// POST /session/login: the one route reachable with no valid token at all — it's how a
// browser gets one. Deliberately outside appRoutes/gateRoutes (server-main.ts wires it in
// unwrapped), since everything gateRoutes wraps requires a token to even reach the
// handler. Shares its rate limiter with checkAuthToken (request-auth.ts) so guessing the
// token here counts the same as guessing it anywhere else.
import type { AuthRateLimiter } from "./auth-rate-limit.ts";
import {
	buildAuthCookie,
	clientIp,
	isHttpsRequest,
	loginPageResponse,
	type RequestIpSource,
	sanitizeNextPath,
	timingSafeEqualStrings,
} from "./request-auth.ts";

export interface SessionLoginRoute {
	POST(request: Request, server?: RequestIpSource): Promise<Response>;
}

export function createSessionLoginRoute(
	expectedToken: string,
	rateLimiter: AuthRateLimiter,
): SessionLoginRoute {
	return {
		async POST(request, server) {
			let form: FormData;
			try {
				form = await request.formData();
			} catch {
				return new Response("Bad request.", { status: 400 });
			}
			const next = sanitizeNextPath(stringField(form, "next"));
			const candidate = stringField(form, "token") ?? "";
			const ip = clientIp(request, server);

			if (!candidate) return loginPageResponse(next, "Enter the auth token.");
			// Like checkAuthToken (request-auth.ts): a blocked IP gets 429 even for the
			// correct token, or the block would be a success oracle that slows no guesser
			// down. An empty submission is not a guess and never counts.
			const blocked = rateLimiter.isBlocked(ip);
			if (blocked.blocked)
				return tooManyRequestsResponse(blocked.retryAfterSeconds);
			if (!timingSafeEqualStrings(candidate, expectedToken)) {
				rateLimiter.recordFailure(ip);
				return loginPageResponse(next, "That token isn't correct.");
			}
			rateLimiter.recordSuccess(ip);

			const response = new Response(null, {
				status: 303,
				headers: { location: next },
			});
			response.headers.append(
				"set-cookie",
				buildAuthCookie(expectedToken, isHttpsRequest(request)),
			);
			return response;
		},
	};
}

function stringField(form: FormData, name: string): string | undefined {
	const value = form.get(name);
	return value === null || value instanceof File ? undefined : value;
}

function tooManyRequestsResponse(retryAfterSeconds: number): Response {
	return new Response("Too many failed authentication attempts. Try again later.", {
		status: 429,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
		},
	});
}

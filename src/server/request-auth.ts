// Opt-in bearer-token gate for `--auth-token`/`PI_UI_AUTH_TOKEN` (server-options.ts). pi-ui
// has no other authentication: binding `--host` to anything but a loopback address (see
// isLoopbackHostname) exposes the whole app — including the workspace file routes, whose
// read path deliberately follows absolute paths and symlinks outside the workspace root
// (see workspace-files.ts) — to every device on that network. This module is the whole
// mechanism: checked once per request in server-main.ts, in front of both the route table
// and the static-asset fallback, before any handler or auth-required route runs. The one
// carve-out is `isPublicAsset`: the app's own CSS/JS/theme script, so the login page below
// (which is itself served from this same gate, to any unauthenticated browser navigation)
// has something to look like pi-ui with, before there is a cookie to authenticate it.
import { timingSafeEqual } from "node:crypto";

import { renderLoginPage } from "../ui/login-page.tsx";
import type { AuthRateLimiter } from "./auth-rate-limit.ts";
import { endpoints } from "./routes/endpoints.ts";

const cookieName = "pi_ui_token";
const cookieMaxAgeSeconds = 60 * 60 * 24 * 30;

const publicAssetPaths = new Set(["/app.css", "/theme.js", "/favicon.svg"]);

/** The app's own front-end bundle: no user data, safe to serve to a browser with no
 * cookie yet — it's what the login page itself is built from. Everything else stays
 * gated. */
function isPublicAsset(pathname: string): boolean {
	return pathname.startsWith("/static/") || publicAssetPaths.has(pathname);
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	// timingSafeEqual throws on a length mismatch; comparing against a same-length,
	// definitely-wrong buffer first keeps the whole check constant-time either way.
	if (left.length !== right.length)
		return timingSafeEqual(left, Buffer.alloc(left.length));
	return timingSafeEqual(left, right);
}

function cookieToken(request: Request): string | undefined {
	const header = request.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== cookieName) continue;
		try {
			return decodeURIComponent(part.slice(separator + 1).trim());
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function bearerToken(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
	return undefined;
}

/** True behind TLS: either directly, or terminated by a reverse proxy that says so. */
export function isHttpsRequest(request: Request): boolean {
	if (new URL(request.url).protocol === "https:") return true;
	const forwarded = request.headers.get("x-forwarded-proto");
	return (forwarded?.split(",")[0]?.trim().toLowerCase() ?? "") === "https";
}

export function buildAuthCookie(token: string, secure: boolean): string {
	const base = `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookieMaxAgeSeconds}`;
	return secure ? `${base}; Secure` : base;
}

/** Clears the session cookie (used by the /session/logout route). */
export function buildClearedAuthCookie(secure: boolean): string {
	const base = `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
	return secure ? `${base}; Secure` : base;
}

/**
 * True for a top-level page load a browser is doing (as opposed to `fetch`/`EventSource`/
 * curl/an API client): these get the friendly login page and the `?token=` strip-from-URL
 * redirect: 401s and other machine-readable responses would be wrong for them, and a
 * silent redirect would be wrong for anyone else. `Sec-Fetch-Mode: navigate` is exact and
 * sent by every Baseline-newly-available browser; `Accept: text/html` is the fallback for
 * the rare client that omits it.
 */
function isBrowserNavigation(request: Request): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	const mode = request.headers.get("sec-fetch-mode");
	if (mode) return mode === "navigate";
	return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Restricts a client-supplied "return to this URL after login" value to a same-origin
 * path, so a tampered `next` field can't turn the post-login redirect into an open
 * redirect to an attacker's site.
 */
export function sanitizeNextPath(candidate: string | null | undefined): string {
	if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
		return endpoints.root;
	}
	try {
		const parsed = new URL(candidate, "http://pi-ui.invalid");
		if (parsed.origin !== "http://pi-ui.invalid") return endpoints.root;
		return `${parsed.pathname}${parsed.search}${parsed.hash}` || endpoints.root;
	} catch {
		return endpoints.root;
	}
}

/** Structural subset of Bun's `Server` this module needs — just enough to resolve the
 * real client IP for rate limiting, and narrow enough that tests don't need a real one. */
export interface RequestIpSource {
	requestIP(request: Request): { address: string } | null;
}

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The peer address Bun accepted the connection from, unless that peer is loopback (a
 * reverse proxy on the same host) and it forwarded one via `X-Forwarded-For`, in which
 * case its first hop — the actual client — is used instead. Never trusts
 * `X-Forwarded-For` from a non-loopback peer, since anyone on the network could send it.
 */
export function clientIp(request: Request, server: RequestIpSource | undefined): string {
	const peer = server?.requestIP(request)?.address;
	if (peer && loopbackAddresses.has(peer)) {
		const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
		if (forwarded) return forwarded;
	}
	return peer ?? "unknown";
}

function originHost(request: Request): string | undefined {
	const origin = request.headers.get("origin");
	if (origin) {
		try {
			return new URL(origin).host.toLowerCase();
		} catch {
			return undefined;
		}
	}
	const referer = request.headers.get("referer");
	if (!referer) return undefined;
	try {
		return new URL(referer).host.toLowerCase();
	} catch {
		return undefined;
	}
}

/**
 * CSRF defense for cookie-authenticated mutations: a cookie rides along automatically on
 * a cross-site request, but its Origin/Referer never lies about where it came from. A
 * Bearer header or `?token=` requires the caller to already know the secret, so neither
 * can be forged cross-site and neither needs this check (see checkAuthToken).
 */
function originMatchesHost(request: Request): boolean {
	const host = (
		request.headers.get("x-forwarded-host") ?? request.headers.get("host")
	)?.toLowerCase();
	const source = originHost(request);
	return !!host && !!source && host === source;
}

export type AuthCheck =
	| { ok: true; setCookie?: string; redirect?: string }
	| { ok: false; response: Response };

export interface AuthCheckDeps {
	server?: RequestIpSource;
	rateLimiter?: AuthRateLimiter;
}

/**
 * Accepts an `Authorization: Bearer <token>` header, a `?token=` query parameter (so an
 * `EventSource` or a plain browser navigation can authenticate without custom headers), or
 * a previously-set session cookie. A query-parameter match asks the caller to set that
 * cookie on the response; on a browser navigation it instead asks for an immediate
 * redirect to the same URL with `token` stripped, so it never sits in the address bar,
 * history, or an accidentally-shared link — non-navigation callers (like `/stream`) still
 * just get the cookie set on their normal response, since there's no address bar to clean.
 */
export function checkAuthToken(
	request: Request,
	expectedToken: string,
	deps: AuthCheckDeps = {},
): AuthCheck {
	const url = new URL(request.url);
	if (isPublicAsset(url.pathname)) return { ok: true };

	const bearer = bearerToken(request);
	const query = url.searchParams.get("token") ?? undefined;
	const cookie = cookieToken(request);
	const provided = bearer ?? query ?? cookie;

	const ip = clientIp(request, deps.server);
	const limiter = deps.rateLimiter;

	// A blocked IP gets 429 for every credential it presents, the correct one included:
	// if the right token still got through, a guesser would simply keep going and watch
	// for the first non-429, so the block would slow nothing down. Requests carrying no
	// credential at all are not guesses — they neither count nor get blocked.
	if (provided && limiter) {
		const status = limiter.isBlocked(ip);
		if (status.blocked) {
			return {
				ok: false,
				response: tooManyRequestsResponse(status.retryAfterSeconds),
			};
		}
	}
	const valid = !!provided && timingSafeEqualStrings(provided, expectedToken);

	if (!valid) {
		if (provided) limiter?.recordFailure(ip);
		const response = isBrowserNavigation(request)
			? loginPageResponse(sanitizeNextPath(url.pathname + url.search))
			: unauthorizedResponse();
		// A stale cookie (e.g. from before the token was rotated) would otherwise ride
		// along on every request — each one a failed guess — until it rate-limits its own
		// browser out of the login form.
		if (!bearer && !query && cookie) {
			response.headers.append(
				"set-cookie",
				buildClearedAuthCookie(isHttpsRequest(request)),
			);
		}
		return { ok: false, response };
	}
	limiter?.recordSuccess(ip);

	const authenticatedByCookieOnly = !bearer && !query && !!cookie;
	if (
		authenticatedByCookieOnly &&
		request.method !== "GET" &&
		request.method !== "HEAD" &&
		!originMatchesHost(request)
	) {
		return { ok: false, response: forbiddenResponse() };
	}

	if (!query) return { ok: true };
	const setCookie = buildAuthCookie(expectedToken, isHttpsRequest(request));
	if (!isBrowserNavigation(request)) return { ok: true, setCookie };
	const stripped = new URL(url);
	stripped.searchParams.delete("token");
	return { ok: true, setCookie, redirect: `${stripped.pathname}${stripped.search}` };
}

/** Renders the login page. Always a plain 200: every call site is a browser navigation the
 * page itself IS the response to (an unauthenticated visit, or a login form re-rendered
 * with an error after a wrong submission) — a non-2xx status on it would only produce a
 * "Failed to load resource" console line for the document itself, with no machine client
 * ever reading it (those get `unauthorizedResponse`'s plain-text 401 instead; see
 * `isBrowserNavigation`). RM1 audit open issue 2. */
export function loginPageResponse(next: string, error?: string): Response {
	return new Response(
		renderLoginPage({ next, loginPath: endpoints.sessionLogin, error }),
		{
			status: 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		},
	);
}

function unauthorizedResponse(): Response {
	return new Response(
		"Unauthorized. This pi-ui server requires its auth token: open " +
			"http://<host>:<port>/?token=<token> once in this browser, or send an " +
			"Authorization: Bearer <token> header.",
		{
			status: 401,
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"www-authenticate": "Bearer",
			},
		},
	);
}

function forbiddenResponse(): Response {
	return new Response(
		"Forbidden: this request's Origin does not match the server it was sent to.",
		{ status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
	);
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

/** Wraps a Bun.serve fetch/route handler so every response first passes checkAuthToken. */
export function withAuthToken<Handler extends (request: Request) => Promise<Response>>(
	handler: Handler,
	token: string,
	deps: AuthCheckDeps = {},
): Handler {
	// SAFETY: this closure has the exact `(request: Request) => Promise<Response>` shape
	// `Handler` is constrained to, plus the optional `server` second parameter Bun.serve
	// itself passes to both `fetch` and route handlers — TypeScript can't infer that an
	// arrow function assigned back to a generic type parameter satisfies it, but the
	// signature matches (extra accepted parameters are compatible either way).
	return (async (request: Request, server?: RequestIpSource) => {
		const check = checkAuthToken(request, token, { ...deps, server });
		if (!check.ok) return check.response;
		if (check.redirect) {
			const response = new Response(null, {
				status: 303,
				headers: { location: check.redirect },
			});
			if (check.setCookie) response.headers.append("set-cookie", check.setCookie);
			return response;
		}
		const response = await handler(request);
		if (check.setCookie) response.headers.append("set-cookie", check.setCookie);
		return response;
	}) as Handler;
}

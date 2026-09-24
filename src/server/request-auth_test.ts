import { test } from "bun:test";

import { assertEquals, assertFalse, assertStringIncludes } from "#testing/assertions";

import { AuthRateLimiter } from "./auth-rate-limit.ts";
import {
	checkAuthToken,
	clientIp,
	type RequestIpSource,
	withAuthToken,
} from "./request-auth.ts";

const token = "secret-token-value";

function serverFor(ip: string): RequestIpSource {
	return { requestIP: () => ({ address: ip }) };
}

/** A GET request as a real browser navigation would send it (no cookie, no token yet). */
function navigationRequest(url: string, init: RequestInit = {}): Request {
	return new Request(url, {
		...init,
		headers: { "sec-fetch-mode": "navigate", accept: "text/html", ...init.headers },
	});
}

test("a request with no token is rejected with 401", async () => {
	const result = checkAuthToken(new Request("http://localhost/"), token);
	assertEquals(result.ok, false);
	if (!result.ok) {
		assertEquals(result.response.status, 401);
		assertEquals(result.response.headers.get("www-authenticate"), "Bearer");
	}
});

test("a wrong bearer token is rejected", () => {
	const request = new Request("http://localhost/", {
		headers: { authorization: "Bearer wrong" },
	});
	assertEquals(checkAuthToken(request, token).ok, false);
});

test("a correct bearer token is accepted without setting a cookie", () => {
	const request = new Request("http://localhost/", {
		headers: { authorization: `Bearer ${token}` },
	});
	const result = checkAuthToken(request, token);
	assertEquals(result.ok, true);
	if (result.ok) assertEquals(result.setCookie, undefined);
});

test("a correct query-parameter token is accepted and asks to set a cookie", () => {
	const request = new Request(`http://localhost/?token=${encodeURIComponent(token)}`);
	const result = checkAuthToken(request, token);
	assertEquals(result.ok, true);
	if (result.ok) {
		assertStringIncludes(
			result.setCookie ?? "",
			`pi_ui_token=${encodeURIComponent(token)}`,
		);
		assertStringIncludes(result.setCookie ?? "", "HttpOnly");
		assertStringIncludes(result.setCookie ?? "", "SameSite=Lax");
	}
});

test("a wrong query-parameter token is rejected", () => {
	const request = new Request("http://localhost/?token=wrong");
	assertEquals(checkAuthToken(request, token).ok, false);
});

test("a previously-set cookie is accepted, without asking to set it again", () => {
	const request = new Request("http://localhost/", {
		headers: { cookie: `pi_ui_token=${encodeURIComponent(token)}; other=1` },
	});
	const result = checkAuthToken(request, token);
	assertEquals(result.ok, true);
	if (result.ok) assertEquals(result.setCookie, undefined);
});

test("a wrong cookie value is rejected", () => {
	const request = new Request("http://localhost/", {
		headers: { cookie: "pi_ui_token=wrong" },
	});
	assertEquals(checkAuthToken(request, token).ok, false);
});

test("withAuthToken rejects unauthenticated requests without calling the handler", async () => {
	let called = false;
	const handler = withAuthToken(async (_request: Request) => {
		called = true;
		return new Response("ok");
	}, token);
	const response = await handler(new Request("http://localhost/"));
	assertEquals(response.status, 401);
	assertEquals(called, false);
});

test("withAuthToken calls the handler and sets the cookie on a query-token first visit", async () => {
	const handler = withAuthToken(async (_request: Request) => new Response("ok"), token);
	const response = await handler(
		new Request(`http://localhost/?token=${encodeURIComponent(token)}`),
	);
	assertEquals(response.status, 200);
	assertEquals(await response.text(), "ok");
	assertStringIncludes(response.headers.get("set-cookie") ?? "", "pi_ui_token=");
});

test("withAuthToken calls the handler without touching set-cookie on a cookie-authenticated visit", async () => {
	const handler = withAuthToken(async (_request: Request) => new Response("ok"), token);
	const response = await handler(
		new Request("http://localhost/", {
			headers: { cookie: `pi_ui_token=${encodeURIComponent(token)}` },
		}),
	);
	assertEquals(response.status, 200);
	assertEquals(response.headers.get("set-cookie"), null);
});

test("pi-ui's own CSS, theme script, and favicon are served with no token at all", () => {
	for (const path of ["/app.css", "/theme.js", "/favicon.svg", "/static/abc/app.css"]) {
		const result = checkAuthToken(new Request(`http://localhost${path}`), token);
		assertEquals(result.ok, true);
	}
});

test("the PWA manifest, its icons, and the offline fallback page are served with no token, so an install prompt and a precache can fetch them", () => {
	for (const path of [
		"/manifest.webmanifest",
		"/icon-180.png",
		"/icon-192.png",
		"/icon-512.png",
		"/offline.html",
	]) {
		const result = checkAuthToken(new Request(`http://localhost${path}`), token);
		assertEquals(result.ok, true);
	}
});

test("an unauthenticated API-style request still gets a plain-text 401, not the login page", async () => {
	const result = checkAuthToken(
		new Request("http://localhost/", { headers: { accept: "application/json" } }),
		token,
	);
	assertEquals(result.ok, false);
	if (!result.ok) {
		assertEquals(result.response.status, 401);
		assertEquals(
			result.response.headers.get("content-type"),
			"text/plain; charset=utf-8",
		);
		const body = await result.response.text();
		assertStringIncludes(body, "http://localhost/?token=<token>");
	}
});

test("the plain-text 401 says https behind an HTTPS proxy, not a hard-coded http:// (RM1 audit open issue 5)", async () => {
	const result = checkAuthToken(
		new Request("http://origin-server/", {
			headers: {
				accept: "application/json",
				"x-forwarded-proto": "https",
				"x-forwarded-host": "pi.example.com",
			},
		}),
		token,
	);
	assertEquals(result.ok, false);
	if (!result.ok) {
		const body = await result.response.text();
		assertStringIncludes(body, "https://pi.example.com/?token=<token>");
		assertFalse(body.includes("http://origin-server"));
	}
});

test("an unauthenticated browser navigation gets the login page instead of a bare 401", async () => {
	const result = checkAuthToken(
		navigationRequest("http://localhost/sessions/abc"),
		token,
	);
	assertEquals(result.ok, false);
	if (!result.ok) {
		const html = await result.response.text();
		assertStringIncludes(html, 'action="/session/login"');
		assertStringIncludes(html, "/sessions/abc");
	}
});

test("the login page navigation gets a plain 200, not 401, so the browser console stays empty (RM1 audit open issue 2)", async () => {
	const result = checkAuthToken(
		navigationRequest("http://localhost/sessions/abc"),
		token,
	);
	assertEquals(result.ok, false);
	if (!result.ok) {
		assertEquals(result.response.status, 200);
		assertEquals(result.response.headers.get("cache-control"), "no-store");
	}
});

test("a correct query token on a browser navigation redirects to strip it from the address bar", async () => {
	const result = checkAuthToken(
		navigationRequest(`http://localhost/sessions/abc?token=${token}&x=1`),
		token,
	);
	assertEquals(result.ok, true);
	if (result.ok) {
		assertEquals(result.redirect, "/sessions/abc?x=1");
		assertStringIncludes(
			result.setCookie ?? "",
			`pi_ui_token=${encodeURIComponent(token)}`,
		);
	}
});

test("withAuthToken issues that redirect instead of calling the handler", async () => {
	let called = false;
	const handler = withAuthToken(async (_request: Request) => {
		called = true;
		return new Response("ok");
	}, token);
	const response = await handler(navigationRequest(`http://localhost/?token=${token}`));
	assertEquals(called, false);
	assertEquals(response.status, 303);
	assertEquals(response.headers.get("location"), "/");
	assertStringIncludes(response.headers.get("set-cookie") ?? "", "pi_ui_token=");
});

test("a correct query token on a non-navigation request (like EventSource) is not redirected", async () => {
	const request = new Request(`http://localhost/stream?token=${token}`, {
		headers: { accept: "text/event-stream" },
	});
	const result = checkAuthToken(request, token);
	assertEquals(result.ok, true);
	if (result.ok) assertEquals(result.redirect, undefined);
});

test("the cookie is Secure over HTTPS and not over plain HTTP", () => {
	const http = checkAuthToken(new Request(`http://localhost/?token=${token}`), token);
	const https = checkAuthToken(new Request(`https://localhost/?token=${token}`), token);
	if (http.ok) assertEquals(http.setCookie?.includes("Secure"), false);
	if (https.ok) assertEquals(https.setCookie?.includes("Secure"), true);
});

test("a forwarded HTTPS proto also makes the cookie Secure", () => {
	const result = checkAuthToken(
		new Request(`http://localhost/?token=${token}`, {
			headers: { "x-forwarded-proto": "https" },
		}),
		token,
	);
	if (result.ok) assertEquals(result.setCookie?.includes("Secure"), true);
});

test("a cookie-authenticated POST is rejected when Origin doesn't match Host", () => {
	const result = checkAuthToken(
		new Request("http://localhost/prompt", {
			method: "POST",
			headers: {
				cookie: `pi_ui_token=${encodeURIComponent(token)}`,
				origin: "https://evil.example",
				host: "localhost",
			},
		}),
		token,
	);
	assertEquals(result.ok, false);
	if (!result.ok) assertEquals(result.response.status, 403);
});

test("a cookie-authenticated POST with no Origin or Referer is rejected too", () => {
	const result = checkAuthToken(
		new Request("http://localhost/prompt", {
			method: "POST",
			headers: { cookie: `pi_ui_token=${encodeURIComponent(token)}` },
		}),
		token,
	);
	assertEquals(result.ok, false);
});

test("a cookie-authenticated POST is accepted when Origin matches Host", () => {
	const result = checkAuthToken(
		new Request("http://localhost/prompt", {
			method: "POST",
			headers: {
				cookie: `pi_ui_token=${encodeURIComponent(token)}`,
				origin: "http://localhost",
				host: "localhost",
			},
		}),
		token,
	);
	assertEquals(result.ok, true);
});

test("a Referer is accepted in place of Origin for the CSRF check", () => {
	const result = checkAuthToken(
		new Request("http://localhost/prompt", {
			method: "POST",
			headers: {
				cookie: `pi_ui_token=${encodeURIComponent(token)}`,
				referer: "http://localhost/sessions/abc",
				host: "localhost",
			},
		}),
		token,
	);
	assertEquals(result.ok, true);
});

test("a bearer-authenticated POST needs no Origin check at all", () => {
	const result = checkAuthToken(
		new Request("http://localhost/prompt", {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		}),
		token,
	);
	assertEquals(result.ok, true);
});

test("a GET authenticated by cookie is never CSRF-checked", () => {
	const result = checkAuthToken(
		new Request("http://localhost/", {
			headers: { cookie: `pi_ui_token=${encodeURIComponent(token)}` },
		}),
		token,
	);
	assertEquals(result.ok, true);
});

test("clientIp trusts the LAST X-Forwarded-For hop from a loopback peer, not the first (RM1 audit open issue 6)", () => {
	// A proxy that *appends* to X-Forwarded-For (e.g. nginx's $proxy_add_x_forwarded_for)
	// leaves any earlier, client-supplied hops in place — trusting the first hop would let
	// a client pick its own rate-limit bucket by sending its own X-Forwarded-For. Caddy
	// (this project's documented recipe) instead *replaces* the header with a single real
	// hop, so this is safe either way; see docs/remote.md.
	const request = new Request("http://localhost/", {
		headers: { "x-forwarded-for": "attacker-supplied, 10.0.0.1, 203.0.113.9" },
	});
	assertEquals(clientIp(request, serverFor("127.0.0.1")), "203.0.113.9");
});

test("clientIp trusts X-Forwarded-For only from a loopback peer", () => {
	const request = new Request("http://localhost/", {
		headers: { "x-forwarded-for": "203.0.113.9" },
	});
	assertEquals(clientIp(request, serverFor("198.51.100.1")), "198.51.100.1");
});

test("clientIp falls back to the peer address with no X-Forwarded-For", () => {
	const request = new Request("http://localhost/");
	assertEquals(clientIp(request, serverFor("127.0.0.1")), "127.0.0.1");
});

test("repeated wrong tokens from one IP are rate-limited, but other IPs are unaffected", () => {
	const rateLimiter = new AuthRateLimiter({ maxFailures: 3 });
	const server = serverFor("9.9.9.9");
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const result = checkAuthToken(
			new Request("http://localhost/", {
				headers: { authorization: "Bearer wrong" },
			}),
			token,
			{ server, rateLimiter },
		);
		assertEquals(result.ok, false);
	}
	const blocked = checkAuthToken(
		new Request("http://localhost/", { headers: { authorization: "Bearer wrong" } }),
		token,
		{ server, rateLimiter },
	);
	assertEquals(blocked.ok, false);
	if (!blocked.ok) {
		assertEquals(blocked.response.status, 429);
		assertEquals(blocked.response.headers.has("retry-after"), true);
	}
	const otherIp = checkAuthToken(
		new Request("http://localhost/", { headers: { authorization: "Bearer wrong" } }),
		token,
		{ server: serverFor("1.1.1.1"), rateLimiter },
	);
	assertEquals(otherIp.ok, false);
	if (!otherIp.ok) assertEquals(otherIp.response.status, 401);
});

test("while an IP is blocked even the correct token gets 429, so the block is no success oracle", () => {
	const rateLimiter = new AuthRateLimiter({ maxFailures: 1 });
	const server = serverFor("9.9.9.9");
	checkAuthToken(
		new Request("http://localhost/", { headers: { authorization: "Bearer wrong" } }),
		token,
		{ server, rateLimiter },
	);
	const correctCredentials: Record<string, string>[] = [
		{ authorization: `Bearer ${token}` },
		{ cookie: `pi_ui_token=${token}` },
	];
	for (const headers of correctCredentials) {
		const result = checkAuthToken(
			new Request("http://localhost/", { headers }),
			token,
			{
				server,
				rateLimiter,
			},
		);
		assertEquals(result.ok, false);
		if (!result.ok) assertEquals(result.response.status, 429);
	}
	const viaQuery = checkAuthToken(
		new Request(`http://localhost/stream?token=${token}`),
		token,
		{ server, rateLimiter },
	);
	assertEquals(viaQuery.ok, false);
	if (!viaQuery.ok) assertEquals(viaQuery.response.status, 429);
});

test("requests that present no credential at all never count as failed guesses", () => {
	const rateLimiter = new AuthRateLimiter({ maxFailures: 1 });
	const server = serverFor("8.8.8.8");
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const result = checkAuthToken(navigationRequest("http://localhost/"), token, {
			server,
			rateLimiter,
		});
		assertEquals(result.ok, false);
		if (!result.ok) assertEquals(result.response.status, 200);
	}
	const correct = checkAuthToken(
		new Request("http://localhost/", {
			headers: { authorization: `Bearer ${token}` },
		}),
		token,
		{ server, rateLimiter },
	);
	assertEquals(correct.ok, true);
});

test("a rejected stale cookie is cleared so the browser stops re-sending it", () => {
	const result = checkAuthToken(
		navigationRequest("https://pi.example/", {
			headers: { cookie: "pi_ui_token=rotated-away" },
		}),
		token,
	);
	assertEquals(result.ok, false);
	if (!result.ok) {
		assertEquals(result.response.status, 200);
		assertStringIncludes(
			result.response.headers.get("set-cookie") ?? "",
			"pi_ui_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
		);
	}
});

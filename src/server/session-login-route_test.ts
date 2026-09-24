import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import { AuthRateLimiter } from "./auth-rate-limit.ts";
import type { RequestIpSource } from "./request-auth.ts";
import { createSessionLoginRoute } from "./session-login-route.ts";

const token = "secret-token-value";

function serverFor(ip: string): RequestIpSource {
	return { requestIP: () => ({ address: ip }) };
}

function loginRequest(fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields);
	return new Request("http://localhost/session/login", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
}

test("a correct token redirects to next and sets the cookie", async () => {
	const route = createSessionLoginRoute(token, new AuthRateLimiter());
	const response = await route.POST(
		loginRequest({ token, next: "/sessions/abc" }),
		serverFor("1.1.1.1"),
	);
	assertEquals(response.status, 303);
	assertEquals(response.headers.get("location"), "/sessions/abc");
	assertStringIncludes(response.headers.get("set-cookie") ?? "", `pi_ui_token=`);
});

test("an untrusted next value is sanitized to a local path before redirecting", async () => {
	const route = createSessionLoginRoute(token, new AuthRateLimiter());
	const response = await route.POST(
		loginRequest({ token, next: "https://evil.example/steal" }),
		serverFor("1.1.1.1"),
	);
	assertEquals(response.status, 303);
	assertEquals(response.headers.get("location"), "/");
});

test("a missing next defaults to the root", async () => {
	const route = createSessionLoginRoute(token, new AuthRateLimiter());
	const response = await route.POST(loginRequest({ token }), serverFor("1.1.1.1"));
	assertEquals(response.headers.get("location"), "/");
});

test("a wrong token re-renders the login page with an error, not a redirect", async () => {
	const route = createSessionLoginRoute(token, new AuthRateLimiter());
	const response = await route.POST(
		loginRequest({ token: "wrong", next: "/sessions/abc" }),
		serverFor("1.1.1.1"),
	);
	assertEquals(response.status, 401);
	const html = await response.text();
	assertStringIncludes(html, 'action="/session/login"');
	assertStringIncludes(html, "/sessions/abc");
	assertEquals(response.headers.get("set-cookie"), null);
});

test("repeated wrong tokens from one IP get rate-limited", async () => {
	const rateLimiter = new AuthRateLimiter({ maxFailures: 2 });
	const route = createSessionLoginRoute(token, rateLimiter);
	const server = serverFor("2.2.2.2");
	await route.POST(loginRequest({ token: "wrong" }), server);
	await route.POST(loginRequest({ token: "wrong" }), server);
	const response = await route.POST(loginRequest({ token: "wrong" }), server);
	assertEquals(response.status, 429);
	assertEquals(response.headers.has("retry-after"), true);
});

test("a correct token succeeds even while that IP is blocked from wrong guesses", async () => {
	const rateLimiter = new AuthRateLimiter({ maxFailures: 1 });
	const route = createSessionLoginRoute(token, rateLimiter);
	const server = serverFor("3.3.3.3");
	await route.POST(loginRequest({ token: "wrong" }), server);
	const response = await route.POST(loginRequest({ token }), server);
	assertEquals(response.status, 303);
});

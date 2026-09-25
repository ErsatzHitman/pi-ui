import { test } from "bun:test";
import { join } from "node:path";

import {
	assertEquals,
	assertStringExcludes,
	assertStringIncludes,
} from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { AuthRateLimiter } from "./auth-rate-limit.ts";
import { writeLoginCredentials } from "./login-credentials.ts";
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
	// A plain 200, not 401 (RM1 audit open issue 2): this response IS the page the browser
	// navigates to (the login form re-rendered with an error), so a failure status here is
	// just a "Failed to load resource" console line with nothing actionable behind it.
	assertEquals(response.status, 200);
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

test("while an IP is blocked even the correct token gets 429, so the block is no success oracle", async () => {
	const rateLimiter = new AuthRateLimiter({ maxFailures: 1 });
	const route = createSessionLoginRoute(token, rateLimiter);
	const server = serverFor("3.3.3.3");
	await route.POST(loginRequest({ token: "wrong" }), server);
	const response = await route.POST(loginRequest({ token }), server);
	assertEquals(response.status, 429);
	assertEquals(response.headers.get("set-cookie"), null);
});

test("an empty submission is not counted as a failed guess", async () => {
	const rateLimiter = new AuthRateLimiter({ maxFailures: 1 });
	const route = createSessionLoginRoute(token, rateLimiter);
	const server = serverFor("4.4.4.4");
	await route.POST(loginRequest({ token: "" }), server);
	await route.POST(loginRequest({ token: "" }), server);
	const response = await route.POST(loginRequest({ token }), server);
	assertEquals(response.status, 303);
});

async function savedLogin(): Promise<string> {
	const path = join(await makeTempDir({ prefix: "pi-ui-login-route-" }), "login.json");
	await writeLoginCredentials(path, "akshat", "correct horse");
	return path;
}

test("with a saved login, the right username and password set the token cookie", async () => {
	const route = createSessionLoginRoute(
		token,
		new AuthRateLimiter(),
		await savedLogin(),
	);
	const response = await route.POST(
		loginRequest({
			username: "akshat",
			password: "correct horse",
			next: "/sessions/abc",
		}),
		serverFor("5.5.5.5"),
	);
	assertEquals(response.status, 303);
	assertEquals(response.headers.get("location"), "/sessions/abc");
	assertStringIncludes(
		response.headers.get("set-cookie") ?? "",
		`pi_ui_token=${token}`,
	);
});

test("a wrong password re-renders the password form with the username kept", async () => {
	const route = createSessionLoginRoute(
		token,
		new AuthRateLimiter(),
		await savedLogin(),
	);
	const response = await route.POST(
		loginRequest({ username: "akshat", password: "wrong horse" }),
		serverFor("5.5.5.6"),
	);
	assertEquals(response.status, 200);
	assertEquals(response.headers.get("set-cookie"), null);
	const html = await response.text();
	assertStringIncludes(html, "username or password");
	assertStringIncludes(html, 'value="akshat"');
	assertStringExcludes(html, 'name="token"');
});

test("repeated wrong passwords from one IP get rate-limited", async () => {
	const route = createSessionLoginRoute(
		token,
		new AuthRateLimiter({ maxFailures: 2 }),
		await savedLogin(),
	);
	const server = serverFor("5.5.5.7");
	const wrong = { username: "akshat", password: "wrong horse" };
	await route.POST(loginRequest(wrong), server);
	await route.POST(loginRequest(wrong), server);
	const response = await route.POST(
		loginRequest({ username: "akshat", password: "correct horse" }),
		server,
	);
	assertEquals(response.status, 429);
});

test("an empty username or password is not counted as a guess", async () => {
	const route = createSessionLoginRoute(
		token,
		new AuthRateLimiter({ maxFailures: 1 }),
		await savedLogin(),
	);
	const server = serverFor("5.5.5.8");
	const empty = await route.POST(
		loginRequest({ username: "akshat", password: "" }),
		server,
	);
	assertStringIncludes(await empty.text(), "Enter your username and password.");
	const response = await route.POST(
		loginRequest({ username: "akshat", password: "correct horse" }),
		server,
	);
	assertEquals(response.status, 303);
});

test("the access token still signs in when a login is saved", async () => {
	const route = createSessionLoginRoute(
		token,
		new AuthRateLimiter(),
		await savedLogin(),
	);
	const response = await route.POST(loginRequest({ token }), serverFor("5.5.5.9"));
	assertEquals(response.status, 303);
});

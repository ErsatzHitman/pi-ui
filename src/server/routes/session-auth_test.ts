import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import { sessionAuthRoutes } from "./session-auth.ts";

test("logging out clears the session cookie and redirects to the root", async () => {
	const handler = sessionAuthRoutes["/session/logout"].POST;
	const response = await handler(
		new Request("http://localhost/session/logout", { method: "POST" }),
	);
	assertEquals(response.status, 303);
	assertEquals(response.headers.get("location"), "/");
	const cookie = response.headers.get("set-cookie") ?? "";
	assertStringIncludes(cookie, "pi_ui_token=;");
	assertStringIncludes(cookie, "Max-Age=0");
});

test("logging out over HTTPS clears a Secure cookie", async () => {
	const handler = sessionAuthRoutes["/session/logout"].POST;
	const response = await handler(
		new Request("https://localhost/session/logout", { method: "POST" }),
	);
	assertStringIncludes(response.headers.get("set-cookie") ?? "", "Secure");
});

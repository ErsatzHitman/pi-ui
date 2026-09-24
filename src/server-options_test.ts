import { test } from "bun:test";

import { assertEquals, assertStringIncludes, assertThrows } from "#testing/assertions";

import {
	defaultServerHostname,
	defaultServerPort,
	explicitServerOptions,
	isLoopbackHostname,
	parseServerOptions,
	serverUsage,
} from "./server-options.ts";

test("server options use loopback defaults", () => {
	assertEquals(parseServerOptions([]), {
		hostname: defaultServerHostname,
		port: defaultServerPort,
		help: false,
	});
});

test("server options read host and port from the environment", () => {
	assertEquals(parseServerOptions([], { host: "0.0.0.0", port: "8080" }), {
		hostname: "0.0.0.0",
		port: 8080,
		help: false,
	});
});

test("server flags override the environment", () => {
	assertEquals(
		parseServerOptions(["--host", "::1", "--port=9000"], {
			host: "0.0.0.0",
			port: "8080",
		}),
		{ hostname: "::1", port: 9000, help: false },
	);
});

test("server options support help", () => {
	assertEquals(parseServerOptions(["-h"]), {
		hostname: defaultServerHostname,
		port: defaultServerPort,
		help: true,
	});
	assertStringIncludes(serverUsage, "usage: pi-ui [options]");
	assertStringIncludes(serverUsage, "pi-ui service install|uninstall");
	assertStringIncludes(serverUsage, "PI_UI_HOST");
	assertStringIncludes(serverUsage, "PI_UI_PORT");
});

test("server options reject invalid input", () => {
	assertThrows(() => parseServerOptions(["--host"]), Error, "non-empty hostname");
	assertThrows(() => parseServerOptions(["--port", "0"]), Error, "1 to 65535");
	assertThrows(() => parseServerOptions([], { port: "abc" }), Error, "1 to 65535");
	assertThrows(() => parseServerOptions(["-H", "localhost"]), Error, "unknown option");
	assertThrows(() => parseServerOptions(["-p", "1234"]), Error, "unknown option");
	assertThrows(() => parseServerOptions(["--unknown"]), Error, "unknown option");
	assertThrows(() => parseServerOptions(["--auth-token"]), Error, "non-empty token");
	assertThrows(() => parseServerOptions(["--auth-token="]), Error, "non-empty token");
});

test("server options accept an opt-in auth token from a flag or the environment", () => {
	assertEquals(parseServerOptions(["--auth-token", "secret"]), {
		hostname: defaultServerHostname,
		port: defaultServerPort,
		help: false,
		authToken: "secret",
	});
	assertEquals(parseServerOptions(["--auth-token=secret"]), {
		hostname: defaultServerHostname,
		port: defaultServerPort,
		help: false,
		authToken: "secret",
	});
	assertEquals(parseServerOptions([], { authToken: "from-env" }), {
		hostname: defaultServerHostname,
		port: defaultServerPort,
		help: false,
		authToken: "from-env",
	});
	// A flag overrides the environment, same as --host/--port.
	assertEquals(parseServerOptions(["--auth-token", "flag"], { authToken: "env" }), {
		hostname: defaultServerHostname,
		port: defaultServerPort,
		help: false,
		authToken: "flag",
	});
});

test("server options omit authToken entirely when not set, unlike an empty string", () => {
	const options = parseServerOptions([], { authToken: "  " });
	assertEquals("authToken" in options, false);
});

test("explicitServerOptions reports false for both when nothing was passed", () => {
	assertEquals(explicitServerOptions([]), { hostname: false, port: false });
	assertEquals(explicitServerOptions([], {}), { hostname: false, port: false });
});

test("explicitServerOptions is true for a flag, an environment variable, or both", () => {
	assertEquals(explicitServerOptions(["--host", "0.0.0.0"]), {
		hostname: true,
		port: false,
	});
	assertEquals(explicitServerOptions(["--port=9000"]), {
		hostname: false,
		port: true,
	});
	assertEquals(explicitServerOptions([], { host: "0.0.0.0" }), {
		hostname: true,
		port: false,
	});
	assertEquals(explicitServerOptions([], { port: "8080" }), {
		hostname: false,
		port: true,
	});
	assertEquals(
		explicitServerOptions(["--host", "0.0.0.0", "--port", "9000"], {
			host: "1.2.3.4",
			port: "1234",
		}),
		{ hostname: true, port: true },
	);
});

test("explicitServerOptions is unaffected by --remote/--auth-token", () => {
	assertEquals(explicitServerOptions(["--remote", "--auth-token", "tok"]), {
		hostname: false,
		port: false,
	});
});

test("isLoopbackHostname recognizes loopback addresses only", () => {
	assertEquals(isLoopbackHostname("127.0.0.1"), true);
	assertEquals(isLoopbackHostname("::1"), true);
	assertEquals(isLoopbackHostname("localhost"), true);
	assertEquals(isLoopbackHostname("LOCALHOST"), true);
	assertEquals(isLoopbackHostname("0.0.0.0"), false);
	assertEquals(isLoopbackHostname("192.168.1.5"), false);
});

test("server options enable remote mode from the flag or the environment", () => {
	assertEquals(parseServerOptions(["--remote"]).remote, true);
	assertEquals(parseServerOptions([], { remote: "1" }).remote, true);
	assertEquals(parseServerOptions([], { remote: "true" }).remote, true);
	assertEquals(parseServerOptions([], { remote: "0" }).remote, undefined);
	assertEquals(parseServerOptions([]).remote, undefined);
});

import { test } from "bun:test";

import {
	assertEquals,
	assertFalse,
	assertStringIncludes,
	assertThrows,
} from "#testing/assertions";

import { serverAutostartConfig, systemdService } from "./server-autostart.ts";
import {
	buildServiceInstallAutostartConfig,
	createShutdown,
	formatCliError,
} from "./server-main.ts";

// These tests exercise the exact function `main()`'s `pi-ui service install` branch calls
// (`buildServiceInstallAutostartConfig`), not a hand-built `serverAutostartConfig` /
// `systemdService` input — see the regression this guards against in server-autostart.ts's
// `ServerAutostartServiceEnvironment` doc comment.

test("service install with zero flags and no PI_UI_* env persists nothing", () => {
	const config = buildServiceInstallAutostartConfig([], {});

	assertEquals(config.headless, false);
	assertEquals(config.serviceEnvironment, {
		hostname: undefined,
		port: undefined,
		remote: undefined,
		authToken: undefined,
	});
});

test("a plain desktop `pi-ui service install` (no flags) keeps the systemd unit exactly as before: no EnvironmentFile, still targets the graphical session", () => {
	// Simulate the installing shell having a normal desktop session, same as the
	// implementer's original manual check ("desktop (unchanged...)") intended to cover.
	const originalDisplay = process.env.DISPLAY;
	process.env.DISPLAY = ":0";
	try {
		const overrides = buildServiceInstallAutostartConfig([], {});
		const config = serverAutostartConfig(
			"linux",
			{ executable: "/usr/bin/pi-ui", standalone: true },
			overrides,
		);
		assertFalse(config.headless);

		const service = systemdService(config);
		assertFalse(service.includes("EnvironmentFile"));
		assertStringIncludes(service, "WantedBy=graphical-session.target");
		assertStringIncludes(service, "After=graphical-session.target");
	} finally {
		if (originalDisplay === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = originalDisplay;
	}
});

test("service install persists an explicit --host/--port flag", () => {
	const config = buildServiceInstallAutostartConfig(
		// A non-loopback host implies remote mode, which needs a token to install.
		["--host", "0.0.0.0", "--port", "8080", "--auth-token", "secret"],
		{},
	);

	assertEquals(config.serviceEnvironment, {
		hostname: "0.0.0.0",
		port: 8080,
		remote: undefined,
		authToken: "secret",
	});
});

test("service install persists an explicit PI_UI_HOST/PI_UI_PORT environment variable", () => {
	const config = buildServiceInstallAutostartConfig([], {
		host: "0.0.0.0",
		port: "9000",
		authToken: "secret",
	});

	assertEquals(config.serviceEnvironment, {
		hostname: "0.0.0.0",
		port: 9000,
		remote: undefined,
		authToken: "secret",
	});
});

test("service install persists --remote/--auth-token without marking hostname/port explicit", () => {
	const config = buildServiceInstallAutostartConfig(
		["--remote", "--auth-token", "secret"],
		{},
	);

	assertEquals(config.serviceEnvironment, {
		hostname: undefined,
		port: undefined,
		remote: true,
		authToken: "secret",
	});
});

test("service install --headless is consumed as the headless override, not forwarded as an unknown flag", () => {
	const config = buildServiceInstallAutostartConfig(["--headless"], {});

	assertEquals(config.headless, true);
	assertEquals(config.serviceEnvironment, {
		hostname: undefined,
		port: undefined,
		remote: undefined,
		authToken: undefined,
	});
});

test("a headless VPS `pi-ui service install --host 0.0.0.0 --remote --auth-token secret` persists an EnvironmentFile and targets default.target", () => {
	const overrides = buildServiceInstallAutostartConfig(
		["--host", "0.0.0.0", "--remote", "--auth-token", "secret"],
		{},
	);
	const config = serverAutostartConfig(
		"linux",
		{ executable: "/usr/bin/pi-ui", standalone: true },
		overrides,
	);
	assertEquals(config.headless, true);

	const service = systemdService(config);
	assertStringIncludes(service, "EnvironmentFile=-");
	assertStringIncludes(service, "WantedBy=default.target");
	assertFalse(service.includes("secret"));
});

test("service install refuses a remote service with no auth token, since the server would refuse to start", () => {
	assertThrows(
		() => buildServiceInstallAutostartConfig(["--remote"], {}),
		Error,
		"--auth-token",
	);
	// A non-loopback --host implies remote mode just like it does for `pi-ui` itself.
	assertThrows(
		() => buildServiceInstallAutostartConfig(["--host", "0.0.0.0"], {}),
		Error,
		"--auth-token",
	);
});

test("service install persists --insecure-no-auth so an explicitly unauthenticated remote service still starts", () => {
	const overrides = buildServiceInstallAutostartConfig(
		["--remote", "--insecure-no-auth"],
		{},
	);

	assertEquals(overrides.serviceEnvironment, {
		hostname: undefined,
		port: undefined,
		remote: true,
		authToken: undefined,
		insecureNoAuth: true,
	});
});

test("shutdown closes open SSE streams by default, in local mode too, so SIGTERM never waits on a connected client", async () => {
	// `systemctl stop/restart` (remote) or Ctrl+C (local, a tab left open) with a client
	// still connected used to hang for Bun's default graceful stop / systemd's 90s stop
	// timeout and end in SIGKILL, with disposeApp never running. RM1 audit open issue 4:
	// this is a real local bug too, so it's unconditional now, not gated on remote mode.
	const calls: string[] = [];
	const shutdown = createShutdown(
		{
			stop: async (closeActiveConnections?: boolean) => {
				calls.push(`stop(${closeActiveConnections === true})`);
			},
		},
		async () => {
			calls.push("dispose");
		},
	);
	await Promise.all([shutdown(), shutdown()]);
	assertEquals(calls, ["stop(true)", "dispose"]);
});

test("formatCliError reduces an Error to its one-line message, no stack or source frame (RM1 audit open issue 5)", () => {
	const error = new Error("--auth-token required for a remote install");
	const formatted = formatCliError(error);
	assertEquals(formatted, "--auth-token required for a remote install");
	assertFalse(formatted.includes("\n"));
	assertFalse(formatted.includes("at "));
});

test("formatCliError falls back to String() for a non-Error throw", () => {
	assertEquals(formatCliError("plain string failure"), "plain string failure");
	assertEquals(formatCliError(42), "42");
});

test("shutdown's closeActiveConnections is still overridable for callers that need it", async () => {
	const calls: string[] = [];
	const shutdown = createShutdown(
		{
			stop: async (closeActiveConnections?: boolean) => {
				calls.push(`stop(${closeActiveConnections === true})`);
			},
		},
		async () => {
			calls.push("dispose");
		},
		false,
	);
	await shutdown();
	assertEquals(calls, ["stop(false)", "dispose"]);
});

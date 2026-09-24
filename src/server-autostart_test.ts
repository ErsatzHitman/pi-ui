import { test } from "bun:test";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
	assertEquals,
	assertFalse,
	assertRejects,
	assertStringIncludes,
} from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import {
	enableServerAutostart,
	launchAgent,
	resolveHeadless,
	serverAutostartConfig,
	systemdService,
	windowsRunCommand,
	writeSystemdServiceEnvironment,
} from "./server-autostart.ts";

test("systemd service starts the current server executable", () => {
	const service = systemdService({
		platform: "linux",
		executable: "/home/Test User/.bun/bin/bun",
		args: ["/home/Test User/pi-ui%dev/server-main.js"],
		home: "/home/Test User",
	});

	assertStringIncludes(
		service,
		"ExecStart=/home/Test\\x20User/.bun/bin/bun /home/Test\\x20User/pi-ui\\x25dev/server-main.js",
	);
	assertStringIncludes(service, "After=graphical-session.target");
	assertStringIncludes(service, "PartOf=graphical-session.target");
	assertStringIncludes(service, "WantedBy=graphical-session.target");
});

test("launch agent starts at login and escapes paths", () => {
	const agent = launchAgent({
		platform: "darwin",
		executable: "/Users/test/.bun/bin/bun",
		args: ["/Users/test/pi-ui & dev/server-main.js"],
		home: "/Users/test",
		uid: 501,
	});

	assertStringIncludes(agent, "<string>dev.pi.ui</string>");
	assertStringIncludes(agent, "<key>RunAtLoad</key>");
	assertStringIncludes(agent, "/Library/Logs/pi-ui.log");
	assertStringIncludes(agent, "<key>KeepAlive</key>");
	assertStringIncludes(agent, "<key>SuccessfulExit</key>");
	assertStringIncludes(agent, "/Users/test/.bun/bin/bun");
	assertStringIncludes(agent, "/Users/test/pi-ui &amp; dev/server-main.js");
});

test("windows startup command launches the executable without a window", () => {
	assertEquals(
		windowsRunCommand({
			platform: "windows",
			executable: "C:\\Program Files\\pi-ui\\pi-ui.exe",
			home: "C:\\Users\\test",
		}),
		"powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command \"Start-Process -WindowStyle Hidden -FilePath 'C:\\Program Files\\pi-ui\\pi-ui.exe'\"",
	);
	assertEquals(
		windowsRunCommand({
			platform: "windows",
			executable: "C:\\Users\\test\\.bun\\bin\\bun.exe",
			args: ["C:\\Users\\test\\pi-ui's package\\server-main.js"],
			home: "C:\\Users\\test",
		}),
		"powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command \"Start-Process -WindowStyle Hidden -FilePath 'C:\\Users\\test\\.bun\\bin\\bun.exe' -ArgumentList @('C:\\Users\\test\\pi-ui''s package\\server-main.js')\"",
	);
});

test("autostart uses the standalone executable without arguments", () => {
	const config = serverAutostartConfig("linux", {
		executable: "/usr/bin/pi-ui",
		standalone: true,
	});

	assertEquals(config.executable, "/usr/bin/pi-ui");
	assertEquals(config.args, []);
	assertFalse(config.transient);
});

test("autostart runs a global bun package through its runtime", () => {
	const config = serverAutostartConfig("linux", {
		executable: "/home/test/.bun/bin/bun",
		script: "/home/test/.bun/install/global/node_modules/@hyperpuncher/pi-ui/dist/npm/server-main.js",
		standalone: false,
	});

	assertEquals(config.executable, "/home/test/.bun/bin/bun");
	assertEquals(config.args, [
		"/home/test/.bun/install/global/node_modules/@hyperpuncher/pi-ui/dist/npm/server-main.js",
	]);
	assertFalse(config.transient);
});

test("systemd service on a headless host targets default.target, not a graphical session", () => {
	const service = systemdService({
		platform: "linux",
		executable: "/usr/bin/pi-ui",
		args: [],
		home: "/home/test",
		headless: true,
	});

	assertStringIncludes(service, "WantedBy=default.target");
	assertFalse(service.includes("graphical-session.target"));
});

test("systemd service references an EnvironmentFile for host/port/remote/token, never ExecStart", () => {
	const service = systemdService({
		platform: "linux",
		executable: "/usr/bin/pi-ui",
		args: [],
		home: "/home/test",
		headless: true,
		serviceEnvironment: {
			hostname: "0.0.0.0",
			port: 31415,
			remote: true,
			authToken: "super-secret",
		},
	});

	assertStringIncludes(service, "EnvironmentFile=-/home/test/.config/pi-ui/pi-ui.env");
	assertFalse(service.includes("super-secret"));
});

test("systemd service omits EnvironmentFile when no host/port/remote/token is persisted", () => {
	const service = systemdService({
		platform: "linux",
		executable: "/usr/bin/pi-ui",
		args: [],
		home: "/home/test",
	});

	assertFalse(service.includes("EnvironmentFile"));
});

test("resolveHeadless detects a headless linux host from the display environment", () => {
	assertEquals(resolveHeadless({}, {}), true);
	assertEquals(resolveHeadless({}, { DISPLAY: ":0" }), false);
	assertEquals(resolveHeadless({}, { WAYLAND_DISPLAY: "wayland-0" }), false);
});

test("resolveHeadless is forced by --headless or remote options regardless of the display", () => {
	assertEquals(resolveHeadless({ headless: true }, { DISPLAY: ":0" }), true);
	assertEquals(
		resolveHeadless({ serviceEnvironment: { remote: true } }, { DISPLAY: ":0" }),
		true,
	);
	assertEquals(
		resolveHeadless(
			{ serviceEnvironment: { hostname: "0.0.0.0" } },
			{ DISPLAY: ":0" },
		),
		true,
	);
	assertEquals(
		resolveHeadless(
			{ serviceEnvironment: { hostname: "127.0.0.1" } },
			{ DISPLAY: ":0" },
		),
		false,
	);
});

test("serverAutostartConfig resolves headless from overrides on linux only", () => {
	const linux = serverAutostartConfig(
		"linux",
		{ executable: "/usr/bin/pi-ui", standalone: true },
		{ headless: true },
	);
	assertEquals(linux.headless, true);

	const darwin = serverAutostartConfig(
		"darwin",
		{ executable: "/usr/bin/pi-ui", standalone: true },
		{ headless: true },
	);
	assertEquals(darwin.headless, false);
	assertEquals(darwin.serviceEnvironment, undefined);
});

test("writeSystemdServiceEnvironment writes a 0600 file with the persisted options", async () => {
	const home = await makeTempDir();
	const config = serverAutostartConfig(
		"linux",
		{ executable: "/usr/bin/pi-ui", standalone: true },
		{
			serviceEnvironment: {
				hostname: "0.0.0.0",
				port: 31415,
				remote: true,
				authToken: "tok",
			},
		},
	);

	const path = await writeSystemdServiceEnvironment({ ...config, home });

	const contents = await Bun.file(path).text();
	assertStringIncludes(contents, "PI_UI_HOST=0.0.0.0");
	assertStringIncludes(contents, "PI_UI_PORT=31415");
	assertStringIncludes(contents, "PI_UI_REMOTE=1");
	assertStringIncludes(contents, "PI_UI_AUTH_TOKEN=tok");
	if (process.platform !== "win32") {
		const mode = (await stat(path)).mode & 0o777;
		assertEquals(mode, 0o600);
		const dirMode = (await stat(dirname(path))).mode & 0o777;
		assertEquals(dirMode, 0o700);
	}
});

test("writeSystemdServiceEnvironment removes a stale file when nothing is persisted", async () => {
	const home = await makeTempDir();
	const withEnvironment = {
		...serverAutostartConfig("linux", {
			executable: "/usr/bin/pi-ui",
			standalone: true,
		}),
		home,
		serviceEnvironment: { hostname: "0.0.0.0" },
	};
	const path = await writeSystemdServiceEnvironment(withEnvironment);
	assertEquals(await Bun.file(path).exists(), true);

	const withoutEnvironment = { ...withEnvironment, serviceEnvironment: undefined };
	await writeSystemdServiceEnvironment(withoutEnvironment);
	assertEquals(await Bun.file(path).exists(), false);
});

test("autostart rejects a transient bunx package", async () => {
	await assertRejects(
		() =>
			enableServerAutostart({
				platform: "linux",
				executable: "/home/test/.bun/bin/bun",
				args: [
					"/home/test/.bun/install/cache/@hyperpuncher/pi-ui@0.38.2/dist/npm/server-main.js",
				],
				home: "/home/test",
				transient: true,
			}),
		Error,
		"bun i -g @hyperpuncher/pi-ui",
	);
});

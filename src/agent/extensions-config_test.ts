import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	applyExtensionsHostMarker,
	defaultExtensionsConfig,
	extensionsHostMarkerEnvVar,
	parseExtensionsConfig,
} from "./extensions-config.ts";

test('extensions config defaults to "tui" and rejects unknown values', () => {
	const tui = { mode: "tui", terminalChrome: false };
	assertEquals(defaultExtensionsConfig, tui);
	assertEquals(parseExtensionsConfig(undefined), tui);
	assertEquals(parseExtensionsConfig(null as unknown as undefined), tui);
	assertEquals(parseExtensionsConfig({}), tui);
	assertEquals(parseExtensionsConfig({ mode: "not-a-mode" }), tui);
	assertEquals(parseExtensionsConfig({ mode: 5 as unknown as string }), tui);
	assertEquals(parseExtensionsConfig({ mode: "tui" }), tui);
	assertEquals(parseExtensionsConfig({ mode: "rpc" }), {
		mode: "rpc",
		terminalChrome: false,
	});
});

test('the host marker is set only for "tui" mode, and only once needed', () => {
	const original = process.env[extensionsHostMarkerEnvVar];
	try {
		delete process.env[extensionsHostMarkerEnvVar];
		applyExtensionsHostMarker({ mode: "rpc", terminalChrome: false });
		assertEquals(process.env[extensionsHostMarkerEnvVar], undefined);

		applyExtensionsHostMarker({ mode: "tui", terminalChrome: false });
		assertEquals(process.env[extensionsHostMarkerEnvVar], "1");
	} finally {
		if (original === undefined) delete process.env[extensionsHostMarkerEnvVar];
		else process.env[extensionsHostMarkerEnvVar] = original;
	}
});

test("extension terminal chrome (setHeader/setFooter) is hidden unless enabled", () => {
	assertEquals(parseExtensionsConfig(undefined).terminalChrome, false);
	assertEquals(parseExtensionsConfig({}).terminalChrome, false);
	assertEquals(parseExtensionsConfig({ terminalChrome: "yes" }).terminalChrome, false);
	assertEquals(parseExtensionsConfig({ terminalChrome: true }).terminalChrome, true);
	assertEquals(parseExtensionsConfig({ mode: "rpc", terminalChrome: true }), {
		mode: "rpc",
		terminalChrome: true,
	});
});

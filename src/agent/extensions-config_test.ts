import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	applyExtensionsHostMarker,
	defaultExtensionsConfig,
	extensionsHostMarkerEnvVar,
	parseExtensionsConfig,
} from "./extensions-config.ts";

const tui = {
	mode: "tui",
	terminalChrome: false,
	activityTracking: true,
	activityPersist: true,
};

test('extensions config defaults to "tui" and rejects unknown values', () => {
	assertEquals(defaultExtensionsConfig, tui);
	assertEquals(parseExtensionsConfig(undefined), tui);
	assertEquals(parseExtensionsConfig(null as unknown as undefined), tui);
	assertEquals(parseExtensionsConfig({}), tui);
	assertEquals(parseExtensionsConfig({ mode: "not-a-mode" }), tui);
	assertEquals(parseExtensionsConfig({ mode: 5 as unknown as string }), tui);
	assertEquals(parseExtensionsConfig({ mode: "tui" }), tui);
	assertEquals(parseExtensionsConfig({ mode: "rpc" }), { ...tui, mode: "rpc" });
});

test('the host marker is set only for "tui" mode, and only once needed', () => {
	const original = process.env[extensionsHostMarkerEnvVar];
	try {
		delete process.env[extensionsHostMarkerEnvVar];
		applyExtensionsHostMarker({ ...tui, mode: "rpc" });
		assertEquals(process.env[extensionsHostMarkerEnvVar], undefined);

		applyExtensionsHostMarker({ ...tui, mode: "tui" });
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
		...tui,
		mode: "rpc",
		terminalChrome: true,
	});
});

test("extension activity tracking/persistence default on and are opt-out only", () => {
	assertEquals(parseExtensionsConfig(undefined).activityTracking, true);
	assertEquals(parseExtensionsConfig(undefined).activityPersist, true);
	assertEquals(parseExtensionsConfig({}).activityTracking, true);
	assertEquals(parseExtensionsConfig({ activityTracking: "no" }).activityTracking, true);
	assertEquals(parseExtensionsConfig({ activityTracking: false }).activityTracking, false);
	assertEquals(parseExtensionsConfig({ activityPersist: false }).activityPersist, false);
	assertEquals(
		parseExtensionsConfig({ activityTracking: false, activityPersist: false }),
		{ ...tui, activityTracking: false, activityPersist: false },
	);
});

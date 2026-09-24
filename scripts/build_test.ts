import { test } from "bun:test";
import { existsSync } from "node:fs";

import { assert, assertEquals, assertThrows } from "#testing/assertions";

import { buildOutfile, parseBuildTarget, piCliThemeFiles } from "./build.ts";

test("parseBuildTarget is undefined without --target, so the build stays local", () => {
	assertEquals(parseBuildTarget([]), undefined);
	assertEquals(buildOutfile(parseBuildTarget([])), "./dist/pi-ui");
});

test("parseBuildTarget reads --target=<value> and --target <value>", () => {
	assertEquals(parseBuildTarget(["--target=bun-linux-x64"]), "bun-linux-x64");
	assertEquals(parseBuildTarget(["--target", "bun-linux-arm64"]), "bun-linux-arm64");
});

test("a cross-compile target names the output after itself", () => {
	assertEquals(buildOutfile("bun-linux-x64"), "./dist/pi-ui-bun-linux-x64");
});

test("--target requires a non-empty value", () => {
	assertThrows(() => parseBuildTarget(["--target"]), Error, "requires a value");
	assertThrows(() => parseBuildTarget(["--target="]), Error, "requires a value");
});

// subagents stream: a compiled pi-ui binary now runs the bundled pi CLI in-process
// (server-main.ts's `runPiCli`, for `isPiCliPassthrough` argv) so a sub-agent's
// re-invocation of "the running pi" works — but for `isBunBinary`, pi CLI's own
// `getThemesDir()` looks for `theme/dark.json`/`theme/light.json` next to
// `process.execPath` on the real filesystem, not anywhere `compile.assets` embeds and not
// under node_modules. Caught only by actually running the compiled binary (see
// server-main.ts's `runPiCli` doc comment); this locks down the two real files the build
// must ship a sibling copy of so that regresses loudly if the upstream package ever
// renames or drops them.
test("piCliThemeFiles names pi CLI's real dark.json/light.json under node_modules", () => {
	const files = piCliThemeFiles();
	assertEquals(files.length, 2);
	assert(files.some((file) => file.endsWith("dark.json")));
	assert(files.some((file) => file.endsWith("light.json")));
	for (const file of files) {
		assert(
			existsSync(file),
			`${file} does not exist — has the theme layout changed?`,
		);
	}
});

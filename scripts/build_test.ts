import { test } from "bun:test";

import { assertEquals, assertThrows } from "#testing/assertions";

import { buildOutfile, parseBuildTarget } from "./build.ts";

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

import { afterEach, beforeEach, test } from "bun:test";
import { join } from "node:path";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import { appCachePath, appConfigPath, appDataPath } from "./app-dirs.ts";

// `scripts/test-env.ts` (the `bunfig.toml` `[test]` preload) sets both
// `PI_UI_CACHE_DIR` and `PI_UI_DATA_DIR` once for the whole `bun test` process, so
// these tests save and restore them around each case instead of relying on that
// preload's values, matching `PI_UI_CACHE_DIR`'s own precedent.
let originalCacheDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(() => {
	originalCacheDir = process.env.PI_UI_CACHE_DIR;
	originalDataDir = process.env.PI_UI_DATA_DIR;
});

afterEach(() => {
	setEnv("PI_UI_CACHE_DIR", originalCacheDir);
	setEnv("PI_UI_DATA_DIR", originalDataDir);
});

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test("appDataPath joins the PI_UI_DATA_DIR override, not the platform default", () => {
	setEnv("PI_UI_DATA_DIR", join("tmp", "pi-ui-data-override"));
	assertEquals(
		appDataPath("session-images", "abc.bin"),
		join("tmp", "pi-ui-data-override", "session-images", "abc.bin"),
	);
});

test("appDataPath falls back to the platform default when PI_UI_DATA_DIR is unset or blank", () => {
	setEnv("PI_UI_DATA_DIR", undefined);
	assertStringIncludes(appDataPath("session-images"), "pi-ui");
	setEnv("PI_UI_DATA_DIR", "   ");
	assertStringIncludes(appDataPath("session-images"), "pi-ui");
});

test("PI_UI_DATA_DIR is independent of PI_UI_CACHE_DIR", () => {
	setEnv("PI_UI_CACHE_DIR", join("tmp", "pi-ui-cache-override"));
	setEnv("PI_UI_DATA_DIR", join("tmp", "pi-ui-data-override"));
	assertEquals(appCachePath("x"), join("tmp", "pi-ui-cache-override", "x"));
	assertEquals(appDataPath("x"), join("tmp", "pi-ui-data-override", "x"));
	// `appConfigPath` (the "config" kind) has no override at all — unaffected by either.
	assertStringIncludes(appConfigPath(), "pi-ui");
});

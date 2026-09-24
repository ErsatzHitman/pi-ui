import { afterEach, test } from "bun:test";
import os from "node:os";

import { assertEquals } from "#testing/assertions";

import { defaultWorkspacePath, setDefaultWorkspacePath } from "./workspace.ts";

afterEach(() => {
	setDefaultWorkspacePath(undefined);
});

test("defaultWorkspacePath is the home directory with no override configured", () => {
	assertEquals(defaultWorkspacePath(), os.homedir() || process.cwd());
});

test("setDefaultWorkspacePath overrides the default (--workspace / PI_UI_WORKSPACE, RM1 audit open issue 8)", () => {
	setDefaultWorkspacePath("/srv/pi-ui-workspace");
	assertEquals(defaultWorkspacePath(), "/srv/pi-ui-workspace");
});

test("setDefaultWorkspacePath(undefined) restores the home-directory default", () => {
	setDefaultWorkspacePath("/srv/pi-ui-workspace");
	setDefaultWorkspacePath(undefined);
	assertEquals(defaultWorkspacePath(), os.homedir() || process.cwd());
});

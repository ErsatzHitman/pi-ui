import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { resolveExclusiveRightPane } from "./right-pane-preferences.ts";

test("both closed stays closed", () => {
	assertEquals(resolveExclusiveRightPane(false, false), {
		sessionSidebarOpen: false,
		liveWorkspaceOpen: false,
	});
});

test("only sessions open is left alone", () => {
	assertEquals(resolveExclusiveRightPane(true, false), {
		sessionSidebarOpen: true,
		liveWorkspaceOpen: false,
	});
});

test("only live workspace open is left alone", () => {
	assertEquals(resolveExclusiveRightPane(false, true), {
		sessionSidebarOpen: false,
		liveWorkspaceOpen: true,
	});
});

test("an old config with both open resolves to Sessions only", () => {
	assertEquals(resolveExclusiveRightPane(true, true), {
		sessionSidebarOpen: true,
		liveWorkspaceOpen: false,
	});
});

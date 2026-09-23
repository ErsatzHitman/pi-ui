import { test } from "bun:test";

import type { ExtensionShortcut } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { assertEquals } from "#testing/assertions";

import {
	appShortcutToKeyId,
	findExtensionShortcut,
	listExtensionShortcuts,
	normalizeKeyId,
	reservedAppKeyIds,
} from "./extension-shortcuts.ts";

function shortcut(
	overrides: Partial<ExtensionShortcut> & { extensionPath: string },
): ExtensionShortcut {
	return {
		shortcut: "alt+o" as KeyId,
		handler: () => {},
		...overrides,
	};
}

/** A minimal `Pick<ExtensionRunner, "getShortcuts">` double: real
 * `getShortcuts()` already lowercases its keys and ignores the
 * `resolvedKeybindings` argument's exact contents for this test's purposes
 * (only `listExtensionShortcuts`/`findExtensionShortcut`'s own filtering is
 * under test, not the SDK's own conflict resolution). */
function fakeRunner(entries: Record<string, ExtensionShortcut>) {
	return {
		getShortcuts: () =>
			new Map(Object.entries(entries)) as Map<KeyId, ExtensionShortcut>,
	};
}

test("appShortcutToKeyId converts pi-ui's canonical shortcut form to a pi-tui KeyId", () => {
	assertEquals(appShortcutToKeyId("ctrl alt O"), "ctrl+alt+o");
	assertEquals(appShortcutToKeyId("alt shift T"), "alt+shift+t");
	assertEquals(appShortcutToKeyId("ctrl ^"), "ctrl+^");
	assertEquals(appShortcutToKeyId("alt L"), "alt+l");
	assertEquals(appShortcutToKeyId("ctrl /"), "ctrl+/");
	// A malformed/empty shortcut string has no KeyId equivalent.
	assertEquals(appShortcutToKeyId(""), undefined);
	assertEquals(appShortcutToKeyId("ctrl ctrl O"), undefined);
});

test("reservedAppKeyIds converts every shortcut in the iterable, dropping unparseable ones", () => {
	const reserved = reservedAppKeyIds(["alt L", "ctrl B", "not a shortcut !!"]);
	assertEquals(reserved.has("alt+l"), true);
	assertEquals(reserved.has("ctrl+b"), true);
	assertEquals(reserved.size, 2);
});

test("normalizeKeyId lowercases a KeyId string", () => {
	assertEquals(normalizeKeyId("Alt+O"), "alt+o");
	assertEquals(normalizeKeyId("CTRL+SHIFT+P"), "ctrl+shift+p");
});

test("listExtensionShortcuts flags reserved keys unreachable-by-keyboard instead of dropping them, and sorts by key", () => {
	const runner = fakeRunner({
		"alt+o": shortcut({ description: "Open", extensionPath: "/ext/a.ts" }),
		"alt+l": shortcut({
			description: "Reserved by pi-ui",
			extensionPath: "/ext/b.ts",
		}),
		"ctrl+shift+x": shortcut({ extensionPath: "/ext/c.ts" }),
	});

	// btw.ts/plan-mode.ts's real Alt+O/Alt+M collide with pi-ui's own web-only
	// "toggle tool output"/"toggle minimal mode" binds even though the real TUI
	// has no such concept to defer to (round-5 runtime-validation finding) — a
	// colliding shortcut still gets listed (for the `/hotkeys` dialog and
	// command palette), just unreachable by keyboard, never silently dropped.
	const infos = listExtensionShortcuts(runner, new Set(["alt+l"]));
	assertEquals(infos, [
		{
			key: "alt+l",
			description: "Reserved by pi-ui",
			extensionPath: "/ext/b.ts",
			reachableByKeyboard: false,
		},
		{
			key: "alt+o",
			description: "Open",
			extensionPath: "/ext/a.ts",
			reachableByKeyboard: true,
		},
		{
			key: "ctrl+shift+x",
			description: undefined,
			extensionPath: "/ext/c.ts",
			reachableByKeyboard: true,
		},
	]);
});

test("listExtensionShortcuts returns an empty list only when none are registered", () => {
	assertEquals(listExtensionShortcuts(fakeRunner({}), new Set()), []);
});

test("findExtensionShortcut looks up a normalized keyId regardless of pi-ui's own reserved keys", () => {
	const target = shortcut({ description: "Open", extensionPath: "/ext/a.ts" });
	const runner = fakeRunner({ "alt+o": target });

	assertEquals(findExtensionShortcut(runner, "Alt+O"), target);
	// A direct lookup is never blocked by a pi-ui collision — reachability only
	// gates the CLIENT's keyboard matcher (`extension-keys.js`'s
	// `currentShortcutKeys()`), not this server-side invocation lookup itself
	// (see `findExtensionShortcut`'s doc comment).
	assertEquals(findExtensionShortcut(runner, "alt+o"), target);
	assertEquals(findExtensionShortcut(runner, "ctrl+z"), undefined);
});

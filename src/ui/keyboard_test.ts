import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import { ShortcutKbd } from "./keyboard.tsx";

test("shortcut keys use platform-appropriate modifiers", async () => {
	const html = await ShortcutKbd({ shortcut: "alt F" });

	assertStringIncludes(html, "data-keybind-hint");
	assertStringIncludes(html, process.platform === "darwin" ? "⌥" : ">alt</kbd>");
	assertStringIncludes(html, ">F</kbd>");
	assertEquals(html.match(/<kbd/g)?.length, 2);
});

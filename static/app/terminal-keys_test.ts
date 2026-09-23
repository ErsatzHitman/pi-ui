import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { encodeKeyEvent } from "./terminal-keys.js";

function key(
	value: string,
	modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) {
	return { key: value, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

test("terminal keys encode editing and navigation keys as xterm sequences", () => {
	assertEquals(encodeKeyEvent(key("Enter")), "\r");
	assertEquals(encodeKeyEvent(key("Escape")), "\u001b");
	assertEquals(encodeKeyEvent(key("Backspace")), "\u007f");
	assertEquals(encodeKeyEvent(key("Tab")), "\t");
	assertEquals(encodeKeyEvent(key("Tab", { shiftKey: true })), "\u001b[Z");
	assertEquals(encodeKeyEvent(key("ArrowUp")), "\u001b[A");
	assertEquals(encodeKeyEvent(key("ArrowLeft", { ctrlKey: true })), "\u001b[1;5D");
	assertEquals(encodeKeyEvent(key("PageDown")), "\u001b[6~");
	assertEquals(encodeKeyEvent(key("Delete", { shiftKey: true })), "\u001b[3;2~");
	assertEquals(encodeKeyEvent(key("Home")), "\u001b[H");
});

test("terminal keys fall back to xterm's modifyOtherKeys form for otherwise-unencodable chords", () => {
	// Ctrl+Enter/Ctrl+Tab have no simpler legacy encoding pi-tui's parser accepts.
	assertEquals(encodeKeyEvent(key("Enter", { ctrlKey: true })), "\u001b[27;5;13~");
	assertEquals(encodeKeyEvent(key("Tab", { ctrlKey: true })), "\u001b[27;5;9~");
	assertEquals(
		encodeKeyEvent(key(" ", { ctrlKey: true, altKey: true })),
		"\u001b[27;7;32~",
	);
});

test("terminal keys encode printable text, Ctrl and Alt chords", () => {
	assertEquals(encodeKeyEvent(key("a")), "a");
	assertEquals(encodeKeyEvent(key("Z", { shiftKey: true })), "Z");
	assertEquals(encodeKeyEvent(key("c", { ctrlKey: true })), "\u0003");
	assertEquals(encodeKeyEvent(key("x", { altKey: true })), "\u001bx");
	assertEquals(encodeKeyEvent(key(" ", { ctrlKey: true })), "\u0000");
	assertEquals(encodeKeyEvent(key(" ", { altKey: true })), "\u001b ");
});

test("terminal keys leave bare modifiers and unsupported function keys to the browser", () => {
	assertEquals(encodeKeyEvent(key("Shift", { shiftKey: true })), null);
	assertEquals(encodeKeyEvent(key("F5")), null);
	assertEquals(encodeKeyEvent(key("Escape", { shiftKey: true })), null);
});

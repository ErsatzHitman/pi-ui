import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	encodeTerminalKey,
	encodeTerminalPaste,
	encodeTerminalWheel,
	sendTerminalInput,
} from "./terminal-keys.js";

function key(
	value: string,
	modifiers: Partial<{
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		metaKey: boolean;
		isComposing: boolean;
	}> = {},
) {
	return {
		key: value,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		...modifiers,
	};
}

test("terminal keys encode editing and navigation keys as xterm sequences", () => {
	assertEquals(encodeTerminalKey(key("Enter")), "\r");
	assertEquals(encodeTerminalKey(key("Escape")), "\u001b");
	assertEquals(encodeTerminalKey(key("Backspace")), "\u007f");
	assertEquals(encodeTerminalKey(key("Tab")), "\t");
	assertEquals(encodeTerminalKey(key("Tab", { shiftKey: true })), "\u001b[Z");
	assertEquals(encodeTerminalKey(key("ArrowUp")), "\u001b[A");
	assertEquals(encodeTerminalKey(key("ArrowLeft", { ctrlKey: true })), "\u001b[1;5D");
	assertEquals(encodeTerminalKey(key("PageDown")), "\u001b[6~");
	assertEquals(encodeTerminalKey(key("Delete", { shiftKey: true })), "\u001b[3;2~");
	assertEquals(encodeTerminalKey(key("Home")), "\u001b[H");
});

test("terminal keys encode printable text, Ctrl and Alt chords", () => {
	assertEquals(encodeTerminalKey(key("a")), "a");
	assertEquals(encodeTerminalKey(key("Z", { shiftKey: true })), "Z");
	assertEquals(encodeTerminalKey(key("c", { ctrlKey: true })), "\u0003");
	assertEquals(encodeTerminalKey(key("x", { altKey: true })), "\u001bx");
	assertEquals(encodeTerminalKey(key(" ", { ctrlKey: true })), "\u0000");
});

test("terminal keys leave modifiers, IME composition and Meta shortcuts to the browser", () => {
	assertEquals(encodeTerminalKey(key("Shift", { shiftKey: true })), undefined);
	assertEquals(encodeTerminalKey(key("a", { isComposing: true })), undefined);
	assertEquals(encodeTerminalKey(key("v", { metaKey: true })), undefined);
});

test("terminal paste is bracketed and wheel maps to bounded arrow steps", () => {
	assertEquals(encodeTerminalPaste("hi"), "\u001b[200~hi\u001b[201~");
	assertEquals(encodeTerminalWheel({ deltaY: -40 }), "\u001b[A");
	assertEquals(encodeTerminalWheel({ deltaY: 1000 }), "\u001b[B".repeat(5));
	assertEquals(encodeTerminalWheel({ deltaY: 0 }), undefined);
});

test("terminal input reaches the server one key at a time, in typing order", async () => {
	const sent: string[] = [];
	const releases: Array<() => void> = [];
	const send = (_url: string, init?: RequestInit) => {
		sent.push(JSON.parse(String(init?.body)).data);
		return new Promise<Response>((resolve) =>
			releases.push(() => resolve(new Response())),
		);
	};
	const done = sendTerminalInput("/input", "s1", "a", send as typeof fetch);
	sendTerminalInput("/input", "s1", "b", send as typeof fetch);
	sendTerminalInput("/input", "s1", "c", send as typeof fetch);
	// Only the first key is in flight until the server answers it.
	assertEquals(sent, ["a"]);
	for (let step = 0; step < 3; step += 1) {
		releases.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	await done;
	assertEquals(sent, ["a", "b", "c"]);
});

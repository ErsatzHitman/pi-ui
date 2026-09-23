import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { isForwardCandidate, matchesKeyId } from "./extension-keys.js";

function key(
	value: string,
	modifiers: Partial<{
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		metaKey: boolean;
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

test("matchesKeyId requires every named modifier held and every unnamed one released", () => {
	assertEquals(matchesKeyId(key("o", { altKey: true }), "alt+o"), true);
	// Case-insensitive base-letter match: pi-tui KeyIds are always lowercase.
	assertEquals(matchesKeyId(key("O", { altKey: true }), "alt+o"), true);
	// An unqualified base never matches a modified chord, and vice versa.
	assertEquals(matchesKeyId(key("o"), "alt+o"), false);
	assertEquals(matchesKeyId(key("o", { altKey: true, ctrlKey: true }), "alt+o"), false);
	assertEquals(
		matchesKeyId(key("x", { ctrlKey: true, shiftKey: true }), "ctrl+shift+x"),
		true,
	);
});

test("matchesKeyId matches special-key tokens against their aliased event.key form", () => {
	assertEquals(matchesKeyId(key("Escape"), "escape"), true);
	assertEquals(matchesKeyId(key("Escape"), "esc"), true);
	assertEquals(matchesKeyId(key("ArrowUp", { altKey: true }), "alt+up"), true);
	assertEquals(matchesKeyId(key("Enter", { ctrlKey: true }), "ctrl+enter"), true);
	// A special-key token never matches an unrelated event.key.
	assertEquals(matchesKeyId(key("Tab"), "escape"), false);
});

test("matchesKeyId matches super (meta) and rejects a literal single-char token typo", () => {
	assertEquals(matchesKeyId(key("k", { metaKey: true }), "super+k"), true);
	assertEquals(matchesKeyId(key("k"), "super+k"), false);
	// A two-plus-char unrecognized token (not in the alias table, length !== 1) never matches.
	assertEquals(matchesKeyId(key("z"), "bogus"), false);
});

test("isForwardCandidate always forwards Escape regardless of prompt contents", () => {
	assertEquals(isForwardCandidate(key("Escape"), false), true);
	assertEquals(isForwardCandidate(key("Escape"), true), true);
});

test("isForwardCandidate rejects any modifier-held key outright", () => {
	assertEquals(isForwardCandidate(key("a", { ctrlKey: true }), true), false);
	assertEquals(isForwardCandidate(key("a", { altKey: true }), true), false);
	assertEquals(isForwardCandidate(key("a", { metaKey: true }), true), false);
});

test("isForwardCandidate only forwards arrows and single characters while the prompt is empty", () => {
	assertEquals(isForwardCandidate(key("ArrowLeft"), true), true);
	assertEquals(isForwardCandidate(key("ArrowLeft"), false), false);
	assertEquals(isForwardCandidate(key("a"), true), true);
	assertEquals(isForwardCandidate(key("a"), false), false);
	// Multi-character non-special keys (e.g. "Shift", "F5") never forward.
	assertEquals(isForwardCandidate(key("F5"), true), false);
	assertEquals(isForwardCandidate(key("Shift"), true), false);
});

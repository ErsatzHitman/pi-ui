import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { placeNoticeAbovePromptRow } from "./prompt.js";

// Minimal stand-ins for the DOM nodes involved, in the style of file-transfer_test.ts's
// `document` stub: this only needs to prove *which* element `.before()` is called on, not
// exercise a real layout engine.

test("placeNoticeAbovePromptRow inserts the notice above the whole editor row when one exists", () => {
	const calls: unknown[] = [];
	const row = { before: (el: unknown) => calls.push(el) };
	const input = {
		closest: (selector: string) => (selector === ".prompt-editor-row" ? row : null),
		before: () => calls.push("wrong-target"),
	};
	const el = { marker: "notice" };
	placeNoticeAbovePromptRow(el, input as unknown as HTMLElement);
	assertEquals(calls, [el]);
});

test("placeNoticeAbovePromptRow falls back to the input itself when there is no editor row", () => {
	const calls: unknown[] = [];
	const input = {
		closest: () => null,
		before: (el: unknown) => calls.push(el),
	};
	const el = { marker: "notice" };
	placeNoticeAbovePromptRow(el, input as unknown as HTMLElement);
	assertEquals(calls, [el]);
});

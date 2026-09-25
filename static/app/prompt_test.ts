import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	fadesEmptyState,
	placeNoticeAbovePromptRow,
	promptGhostStyle,
} from "./prompt.js";

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

test("the send ghost copies the textarea box and type metrics into a fixed, inert layer", () => {
	const style = promptGhostStyle(
		{ left: 10, top: 700, width: 600, height: 64 },
		{
			font: "16px Inter",
			lineHeight: "24px",
			letterSpacing: "normal",
			padding: "4px",
			color: "rgb(0, 0, 0)",
			overflowWrap: "anywhere",
			textAlign: "start",
		},
	);
	assertEquals(style.position, "fixed");
	assertEquals(
		[style.left, style.top, style.width, style.height],
		["10px", "700px", "600px", "64px"],
	);
	assertEquals(style.pointerEvents, "none");
	assertEquals(style.whiteSpace, "pre-wrap");
	assertEquals(
		[style.font, style.lineHeight, style.padding],
		["16px Inter", "24px", "4px"],
	);
});

test("a /copy clear keeps the empty state; a real send fades it", () => {
	assertEquals(fadesEmptyState("/copy"), false);
	assertEquals(fadesEmptyState("  /copy "), false);
	assertEquals(fadesEmptyState("hello"), true);
});

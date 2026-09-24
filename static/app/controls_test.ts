import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { caretAtEdge } from "./controls.js";

function input(value: string, start: number, end = start) {
	return { value, selectionStart: start, selectionEnd: end } as HTMLInputElement;
}

test("model picker arrows switch panes only from the search caret's edge", () => {
	assertEquals(caretAtEdge(input("", 0), "ArrowLeft"), true);
	assertEquals(caretAtEdge(input("", 0), "ArrowRight"), true);
	assertEquals(caretAtEdge(input("gpt", 0), "ArrowLeft"), true);
	assertEquals(caretAtEdge(input("gpt", 3), "ArrowRight"), true);
	assertEquals(caretAtEdge(input("gpt", 3), "ArrowLeft"), false);
	assertEquals(caretAtEdge(input("gpt", 0), "ArrowRight"), false);
	assertEquals(caretAtEdge(input("gpt", 1), "ArrowLeft"), false);
	assertEquals(caretAtEdge(input("gpt", 0, 3), "ArrowLeft"), false);
});

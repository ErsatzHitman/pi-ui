import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { caretAtEdge, visibleCommandItems } from "./controls.js";

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

test("command items inside a hidden group are not visible", () => {
	// Regression: clearing a model search re-hides every provider group but the active
	// one, and refresh then marked the first row of the first (hidden) group `.active` —
	// Enter picked a model the user could not see.
	class FakeHTMLElement {
		constructor(
			readonly name: string,
			readonly inHiddenGroup: boolean,
		) {}
		closest(selector: string) {
			return selector === "[hidden]" && this.inHiddenGroup ? {} : null;
		}
		hasAttribute() {
			return false;
		}
		getAttribute() {
			return null;
		}
	}
	const restore = patchHTMLElement(FakeHTMLElement);
	try {
		const items = [
			new FakeHTMLElement("anthropic/claude", true),
			new FakeHTMLElement("openrouter/llama", false),
		];
		const menu = Object.assign(new FakeHTMLElement("menu", false), {
			querySelectorAll: () => items,
		});
		const command = {
			dataset: {},
			querySelector: (selector: string) =>
				selector === '[role="menu"]' ? menu : null,
		};
		assertEquals(
			visibleCommandItems(command as unknown as HTMLElement).map(
				(item) => (item as unknown as FakeHTMLElement).name,
			),
			["openrouter/llama"],
		);
	} finally {
		restore();
	}
});

function patchHTMLElement(value: unknown): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
	Object.defineProperty(globalThis, "HTMLElement", {
		configurable: true,
		writable: true,
		value,
	});
	return () => {
		if (original) Object.defineProperty(globalThis, "HTMLElement", original);
		else Reflect.deleteProperty(globalThis, "HTMLElement");
	};
}

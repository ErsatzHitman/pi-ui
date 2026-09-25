import { test } from "bun:test";

import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

import { assertEquals, waitForCondition } from "#testing/assertions";

import { endpoints } from "../../src/server/routes/endpoints.ts";
import {
	bindPickers,
	completeFileValue,
	copyLastAssistantMessage,
	extractArgumentQuery,
	extractFilePrefix,
	nextPickerIndex,
} from "./pickers.js";

test("extractArgumentQuery reads the command name and trailing argument text", () => {
	assertEquals(extractArgumentQuery("/model op", 9), {
		command: "model",
		prefix: "op",
	});
	assertEquals(extractArgumentQuery("/Thinking ", 10), {
		command: "thinking",
		prefix: "",
	});
	assertEquals(extractArgumentQuery("/export /tmp/out.html", 21), {
		command: "export",
		prefix: "/tmp/out.html",
	});
});

test("extractArgumentQuery matches only up to the caret, not the whole line", () => {
	assertEquals(extractArgumentQuery("/model opus and more", 11), {
		command: "model",
		prefix: "opus",
	});
});

test("extractArgumentQuery returns undefined before the command name has a trailing space", () => {
	assertEquals(extractArgumentQuery("/model", 6), undefined);
	assertEquals(extractArgumentQuery("plain text", 10), undefined);
	assertEquals(extractArgumentQuery("", 0), undefined);
});

test("extractFilePrefix finds the @ token at the caret", () => {
	assertEquals(extractFilePrefix("open @src/ui after", 12), {
		start: 5,
		end: 12,
		query: "src/ui",
	});
	assertEquals(extractFilePrefix("plain text", 10), undefined);
	assertEquals(extractFilePrefix("x=@src", 6), {
		start: 2,
		end: 6,
		query: "src",
	});
});

test("quoted file completions follow pi's spacing and cursor behavior", () => {
	const provider = new CombinedAutocompleteProvider([], "/workspace");
	for (const { before, after, value, label } of [
		{ before: "see @sp", after: "", value: '@"space dir/"', label: "space dir/" },
		{
			before: 'see @"space dir/sp',
			after: '" after',
			value: '@"space dir/space file.txt"',
			label: "space file.txt",
		},
		{
			before: 'see @"space dir/ne',
			after: '"',
			value: '@"space dir/nested dir/"',
			label: "nested dir/",
		},
	]) {
		const input = before + after;
		const match = extractFilePrefix(input, before.length);
		if (!match) throw new Error("Missing quoted file prefix");
		const expected = provider.applyCompletion(
			[input],
			0,
			before.length,
			{ value, label },
			`@${match.query}`,
		);
		const actual = completeFileValue(input, match, value);
		assertEquals(actual, { text: expected.lines[0], cursor: expected.cursorCol });
		if (label.endsWith("/")) {
			assertEquals(
				extractFilePrefix(actual.text, actual.cursor)?.query,
				value.slice(1, -1),
			);
		}
	}
});

test("picker navigation stops at both visual boundaries", () => {
	assertEquals(nextPickerIndex(4, -1, -1), 0);
	assertEquals(nextPickerIndex(4, 0, 1), 0);
	assertEquals(nextPickerIndex(4, 3, -1), 3);
	assertEquals(nextPickerIndex(4, 0, -1), 1);
	assertEquals(nextPickerIndex(4, 1, -1), 2);
	assertEquals(nextPickerIndex(4, 1, 1), 0);
});

test("file completion preserves surrounding prompt text and directory flow", () => {
	const match = { start: 4, end: 7, query: "sr" };
	assertEquals(completeFileValue("see @sr now", match, "@src/app.ts"), {
		text: "see @src/app.ts  now",
		cursor: 16,
	});
	assertEquals(completeFileValue("see @sr", match, "@src/"), {
		text: "see @src/",
		cursor: 9,
	});
});

/** Patches a global via `Object.defineProperty` (see terminal-keys_test.ts's `patchGlobal`). */
function patchGlobal(name: string, value: unknown): () => void {
	return patchProperty(globalThis, name, value);
}

function patchProperty(
	target: typeof globalThis | Navigator,
	name: string,
	value: unknown,
): () => void {
	const original = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { configurable: true, writable: true, value });
	return () => {
		if (original) Object.defineProperty(target, name, original);
		else Reflect.deleteProperty(target, name);
	};
}

/** Fakes just the DOM `copyLastAssistantMessage()` touches (O3). */
function installCopyDom(options: {
	replyText?: string;
	clipboard?: { writeText(text: string): Promise<void> };
	execCommandResult: boolean;
}) {
	const posts: unknown[] = [];
	const execCalls: string[] = [];
	const textarea = {
		value: "",
		style: {},
		setAttribute() {},
		focus() {},
		select() {},
		setSelectionRange() {},
		remove() {},
	};
	const fakeDocument = {
		querySelectorAll: () =>
			options.replyText === undefined ? [] : [{ textContent: options.replyText }],
		createElement: () => textarea,
		body: { append() {} },
		execCommand: (command: string) => {
			execCalls.push(command);
			return options.execCommandResult;
		},
	};
	const restores = [
		patchGlobal("document", fakeDocument),
		patchProperty(globalThis.navigator, "clipboard", options.clipboard),
		patchGlobal("fetch", async (url: string, init: RequestInit) => {
			posts.push({ url, body: JSON.parse(String(init.body)) });
			return new Response(null, { status: 204 });
		}),
	];
	return {
		posts,
		execCalls,
		restore: () => {
			for (const restore of restores.reverse()) restore();
		},
	};
}

test("/copy falls through to the server when there is no reply to copy", () => {
	const dom = installCopyDom({ execCommandResult: true });
	try {
		assertEquals(copyLastAssistantMessage(), false);
		assertEquals(dom.posts, []);
	} finally {
		dom.restore();
	}
});

test("/copy uses the execCommand fallback when the Clipboard API is missing", () => {
	const dom = installCopyDom({ replyText: "reply", execCommandResult: true });
	try {
		assertEquals(copyLastAssistantMessage(), true);
		assertEquals(dom.execCalls, ["copy"]);
		assertEquals(dom.posts, []);
	} finally {
		dom.restore();
	}
});

test("/copy reports a visible failure when writeText rejects and the fallback fails", async () => {
	const dom = installCopyDom({
		replyText: "reply",
		clipboard: { writeText: () => Promise.reject(new Error("denied")) },
		execCommandResult: false,
	});
	try {
		assertEquals(copyLastAssistantMessage(), true);
		await waitForCondition(() => dom.posts.length > 0);
		assertEquals(dom.execCalls, ["copy"]);
		assertEquals(dom.posts, [
			{ url: endpoints.prompt, body: { prompt: "/copy unavailable" } },
		]);
	} finally {
		dom.restore();
	}
});

/** Fakes the prompt, an open argument picker with one selected row, and the document
 * listeners `bindPickers` installs — just enough DOM for its Enter/click path. */
function installArgumentPickerDom(prompt: string) {
	class FakeElement {}
	class FakeHTMLElement extends FakeElement {}
	class FakeTextArea extends FakeHTMLElement {
		value = prompt;
		selectionStart = prompt.length;
		selectionEnd = prompt.length;
		events: string[] = [];
		dispatchEvent(event: Event) {
			this.events.push(event.type);
			return true;
		}
		focus() {}
		setAttribute() {}
		removeAttribute() {}
	}
	const listeners = new Map<string, (event: unknown) => void>();
	const input = new FakeTextArea();
	const popover = Object.assign(new FakeHTMLElement(), { checkVisibility: () => true });
	const row = Object.assign(new FakeHTMLElement(), {
		dataset: { pickerValue: "openrouter/llama-4-maverick" },
		checkVisibility: () => true,
		getAttribute: (name: string) => (name === "aria-selected" ? "true" : null),
		closest: (selector: string) =>
			selector === '[data-picker-kind="argument"]' ? row : null,
		click: () => listeners.get("click")?.({ target: row, preventDefault() {} }),
	});
	const fakeDocument = {
		activeElement: input,
		addEventListener: (type: string, listener: (event: unknown) => void) =>
			listeners.set(type, listener),
		getElementById: (id: string) =>
			id === "prompt-input"
				? input
				: id === "prompt-argument-popover"
					? popover
					: null,
		querySelectorAll: (selector: string) =>
			selector === "[data-argument-row]" ? [row] : [],
	};
	const restores = [
		patchGlobal("Element", FakeElement),
		patchGlobal("HTMLElement", FakeHTMLElement),
		patchGlobal("HTMLTextAreaElement", FakeTextArea),
		patchGlobal("document", fakeDocument),
	];
	bindPickers({ fuzzyFilter: () => [] });
	return {
		input,
		pressEnter: () =>
			listeners.get("keydown")?.({
				target: input,
				code: "Enter",
				isComposing: false,
				ctrlKey: false,
				metaKey: false,
				altKey: false,
				shiftKey: false,
				preventDefault() {},
			}),
		restore: () => {
			for (const restore of restores.reverse()) restore();
		},
	};
}

test("Enter in an argument picker opened by a late completions response still completes", () => {
	// Regression: "/model" + Enter completed the slash row to "/model ", then closed the
	// pickers — forgetting the argument query while its debounced completions request
	// still reopened the picker. That open picker swallowed every Enter without acting,
	// leaving the prompt stuck (the user could only reach the model button with a mouse).
	const dom = installArgumentPickerDom("/model ");
	try {
		dom.pressEnter();
		assertEquals(dom.input.value, "/model openrouter/llama-4-maverick");
		assertEquals(dom.input.events.includes("pi-ui-argument-close"), true);
	} finally {
		dom.restore();
	}
});

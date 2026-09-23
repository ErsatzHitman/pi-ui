import { afterEach, test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { bindExtensionKeys, promptInputBusy } from "./extension-keys.js";

/** Patches a global via `Object.defineProperty` (see live-workspace-open_test.ts). */
function patchGlobal(name: string, value: unknown): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
	return () => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	};
}

class FakeKeyboardEvent extends Event {
	readonly key: string;
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
	readonly isComposing = false;

	constructor(
		type: string,
		init: EventInit & { key: string; code?: string; shiftKey?: boolean },
	) {
		super(type, init);
		this.key = init.key;
		this.code = init.code ?? init.key;
		this.ctrlKey = false;
		this.altKey = false;
		this.metaKey = false;
		this.shiftKey = init.shiftKey ?? false;
	}
}

/** Just the `HTMLTextAreaElement` surface `extension-keys.js` edits through. */
class FakeTextarea extends EventTarget {
	readonly id = "prompt-input";
	value = "";
	selectionStart = 0;
	selectionEnd = 0;
	blurred = false;

	setRangeText(text: string, start: number, end: number) {
		this.value = this.value.slice(0, start) + text + this.value.slice(end);
		this.selectionStart = start + text.length;
		this.selectionEnd = this.selectionStart;
	}

	setSelectionRange(start: number, end: number) {
		this.selectionStart = start;
		this.selectionEnd = end;
	}

	blur() {
		this.blurred = true;
	}
}

type Deferred = { data: string; resolve: (consumed: boolean) => void };

type Harness = {
	input: FakeTextarea;
	requests: Deferred[];
	submitted: string[];
	press: (key: string, options?: { shiftKey?: boolean }) => FakeKeyboardEvent;
	settle: () => Promise<void>;
};

const restores: (() => void)[] = [];

afterEach(() => {
	while (restores.length > 0) restores.pop()?.();
});

/**
 * Fakes the prompt, the `#extension-shortcuts-data` island (with an active
 * `onTerminalInput` listener, the ambient state `bash-background.ts` leaves
 * behind), and a `fetch` whose `/extensions/ui/prompt-input` round trips the
 * test resolves by hand, so two keydowns can land inside one round trip.
 */
function install(): Harness {
	const input = new FakeTextarea();
	const island = { dataset: { terminalInputActive: "" }, children: [] };
	const documentListeners: ((event: Event) => void)[] = [];
	const requests: Deferred[] = [];
	const submitted: string[] = [];

	// Stand-in for prompt-box.tsx's inline Enter-to-send (target phase).
	input.addEventListener("keydown", (event) => {
		const keyEvent = event as FakeKeyboardEvent;
		if (keyEvent.key !== "Enter" || keyEvent.shiftKey) return;
		if (promptInputBusy()) return;
		event.preventDefault();
		submitted.push(input.value);
	});

	const fakeDocument = {
		activeElement: input,
		body: {},
		getElementById: (id: string) =>
			id === "prompt-input"
				? input
				: id === "extension-shortcuts-data"
					? island
					: null,
		querySelector: () => ({}),
		addEventListener: (_type: string, listener: (event: Event) => void) => {
			documentListeners.push(listener);
		},
	};
	restores.push(patchGlobal("document", fakeDocument));
	restores.push(patchGlobal("HTMLTextAreaElement", FakeTextarea));
	restores.push(patchGlobal("KeyboardEvent", FakeKeyboardEvent));
	restores.push(patchGlobal("window", { piUi: { pickers: { isOpen: () => false } } }));
	restores.push(
		patchGlobal("fetch", (_url: string, init: { body: string }) => {
			const { data } = JSON.parse(init.body) as { data: string };
			return new Promise((resolveResponse) => {
				requests.push({
					data,
					resolve: (consumed) =>
						resolveResponse({ json: async () => ({ consumed }) }),
				});
			});
		}),
	);

	bindExtensionKeys();

	function press(key: string, options: { shiftKey?: boolean } = {}) {
		const event = new FakeKeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
			shiftKey: options.shiftKey,
		});
		// Target phase first (prompt-box.tsx), then the document listener.
		input.dispatchEvent(event);
		Object.defineProperty(event, "target", { value: input });
		for (const listener of documentListeners) listener(event);
		return event;
	}

	async function settle() {
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
	}

	return { input, requests, submitted, press, settle };
}

test("two characters typed inside one round trip both land, in order", async () => {
	const { input, requests, press, settle } = install();
	const h = press("h");
	const i = press("i");
	assertEquals(h.defaultPrevented, true);
	assertEquals(i.defaultPrevented, true);
	await settle();
	// Only the first key was forwarded so far; the second waits its turn.
	assertEquals(requests.length, 1);
	requests[0]?.resolve(false);
	await settle();
	// The prompt is no longer empty, so "i" is played back without a forward.
	assertEquals(requests.length, 1);
	assertEquals(input.value, "hi");
	assertEquals(promptInputBusy(), false);
});

test("a consumed key never reaches the prompt and the next one is forwarded too", async () => {
	const { input, requests, press, settle } = install();
	press("j");
	press("x");
	await settle();
	requests[0]?.resolve(true);
	await settle();
	assertEquals(requests.length, 2);
	requests[1]?.resolve(false);
	await settle();
	assertEquals(input.value, "x");
});

test("Backspace and Enter queued behind a forward apply after it, not before", async () => {
	const { input, requests, submitted, press, settle } = install();
	press("a");
	press("b");
	const backspace = press("Backspace");
	const enter = press("Enter");
	assertEquals(backspace.defaultPrevented, true);
	// prompt-box.tsx stood down (busy), so this module queued the Enter.
	assertEquals(submitted.length, 0);
	assertEquals(enter.defaultPrevented, true);
	await settle();
	requests[0]?.resolve(false);
	await settle();
	assertEquals(input.value, "a");
	assertEquals(submitted, ["a"]);
});

test("an unconsumed Escape blurs the prompt", async () => {
	const { input, requests, press, settle } = install();
	press("Escape");
	await settle();
	requests[0]?.resolve(false);
	await settle();
	assertEquals(input.blurred, true);
});

import { afterEach, test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	fadesEmptyState,
	holdEmptyStateForSend,
	placeNoticeAbovePromptRow,
	promptGhostKeyframes,
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

test("a slash command keeps the empty state; a real send fades it", () => {
	assertEquals(fadesEmptyState("/copy"), false);
	assertEquals(fadesEmptyState("  /copy "), false);
	assertEquals(fadesEmptyState("/model"), false);
	assertEquals(fadesEmptyState("hello"), true);
	assertEquals(fadesEmptyState("hello /model"), true);
	assertEquals(fadesEmptyState(""), true);
});

test("the send ghost is never held: it lifts 0.75rem and fades fully out", () => {
	const [from, to] = promptGhostKeyframes(false, 111);
	assertEquals([from?.opacity, from?.transform], [1, "none"]);
	assertEquals([to?.opacity, to?.transform], [0, "translateY(-0.75rem)"]);
});

test("the send ghost is clipped to the collapsing text box, never over the widget row", () => {
	const [from, to] = promptGhostKeyframes(false, 111);
	assertEquals(from?.clipPath, "inset(0px 0px 0px 0px)");
	// The box's top comes down 111px while the ghost lifts 0.75rem: both, in its space.
	assertEquals(to?.clipPath, "inset(calc(111px + 0.75rem) 0px 0px 0px)");
	// A one-line prompt (no collapse) still clips the lift at the box's top.
	assertEquals(
		promptGhostKeyframes(false, 0)[1]?.clipPath,
		"inset(calc(0px + 0.75rem) 0px 0px 0px)",
	);
});

test("under reduced motion the send ghost only fades, clipped to the collapsed box", () => {
	assertEquals(promptGhostKeyframes(true, 111), [
		{ opacity: 1, clipPath: "inset(111px 0px 0px 0px)" },
		{ opacity: 0, clipPath: "inset(111px 0px 0px 0px)" },
	]);
});

// --- holdEmptyStateForSend with hand-written browser stand-ins ----------------------

const restores: (() => void)[] = [];
function install(name: string, value: unknown): void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
	restores.push(() => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	});
}
afterEach(() => {
	while (restores.length > 0) restores.pop()?.();
});

type Keyframes = { opacity?: number; transform?: string; clipPath?: string }[];
class FakeElement {
	isConnected = true;
	style: Record<string, string> = {};
	animations: { keyframes: Keyframes; ms: number; reversed: boolean }[] = [];
	inert = false;
	constructor(public rect = { left: 0, top: 0, width: 0, height: 0 }) {}
	getBoundingClientRect() {
		return this.rect;
	}
	animate(keyframes: Keyframes, { duration }: { duration: number }) {
		const record = { keyframes, ms: duration, reversed: false };
		this.animations.push(record);
		return {
			finished: new Promise(() => {}),
			reverse: () => {
				record.reversed = true;
			},
		};
	}
	cloneNode() {
		return Object.assign(new FakeElement(this.rect), { clone: true });
	}
	querySelectorAll() {
		return [];
	}
	getAttributeNames() {
		return [];
	}
	setAttribute() {}
	removeAttribute() {}
	remove() {
		this.isConnected = false;
	}
}

/** #messages with an empty state and no articles yet; returns the knobs a test turns. */
function emptyTranscript() {
	const messages = new FakeElement();
	const empty = new FakeElement({ left: 40, top: 200, width: 600, height: 240 });
	const articles: unknown[] = [];
	const appended: FakeElement[] = [];
	const listeners = new Map<string, () => void>();
	const timers: (() => void)[] = [];
	let mutated: () => void = () => {};
	let observing = false;
	install("HTMLElement", FakeElement);
	install("matchMedia", () => ({ matches: false }));
	install("requestAnimationFrame", () => 1);
	install("cancelAnimationFrame", () => {});
	install("setTimeout", (callback: () => void) => timers.push(callback));
	install("clearTimeout", () => {});
	install(
		"MutationObserver",
		class {
			constructor(callback: () => void) {
				mutated = callback;
			}
			observe() {
				observing = true;
			}
			disconnect() {
				observing = false;
			}
		},
	);
	install("document", {
		body: { append: (node: FakeElement) => appended.push(node) },
		getElementById: (id: string) => (id === "messages" ? messages : null),
		querySelector: (selector: string) =>
			selector === "#messages .messages-empty-state" ? empty : null,
		querySelectorAll: () => articles,
		addEventListener: (type: string, listener: () => void) =>
			listeners.set(type, listener),
		removeEventListener: (type: string) => listeners.delete(type),
	});
	return {
		empty,
		appended,
		observing: () => observing,
		/** The server's morph: the user article lands and replaces the empty state. */
		land() {
			articles.push({});
			empty.isConnected = false;
			mutated();
		},
		/** The server's morph: an extension card lands first and replaces the empty state. */
		landCard() {
			empty.isConnected = false;
			mutated();
		},
		fail: () => listeners.get("pi-ui-prompt-send-failed")?.(),
		cap: () => timers[0]?.(),
	};
}

test("the empty state stays until the first article lands, then exits as a ghost", () => {
	const page = emptyTranscript();
	holdEmptyStateForSend(false);
	// A slow server: nothing fades while the send is in flight.
	assertEquals(page.empty.animations, []);
	assertEquals(page.appended, []);
	page.land();
	// The morph removed the node: a ghost at its last rect fades out over 120ms.
	assertEquals(page.appended.length, 1);
	const ghost = page.appended[0];
	assertEquals([ghost?.style.left, ghost?.style.top], ["40px", "200px"]);
	assertEquals(ghost?.animations[0]?.ms, 120);
	assertEquals(ghost?.animations[0]?.keyframes.at(-1)?.opacity, 0);
	assertEquals(page.observing(), false);
});

test("a send that never lands fades the empty state at the cap; a failure fades it back", () => {
	const page = emptyTranscript();
	holdEmptyStateForSend(false);
	page.cap();
	assertEquals(page.empty.animations.length, 1);
	assertEquals(page.empty.animations[0]?.keyframes.at(-1), {
		opacity: 0,
		transform: "translateY(-0.25rem)",
	});
	page.fail();
	assertEquals(page.empty.animations[0]?.reversed, true);
});

test("a failed send keeps the empty state where it is", () => {
	const page = emptyTranscript();
	holdEmptyStateForSend(true);
	page.fail();
	assertEquals(page.empty.animations, []);
	assertEquals(page.observing(), false);
});

test("an extension card landing before the user article also retires the empty state", () => {
	const page = emptyTranscript();
	holdEmptyStateForSend(false);
	page.landCard();
	assertEquals(page.appended.length, 1);
	assertEquals(page.observing(), false);
	// The user article that follows does not ghost it a second time.
	page.land();
	assertEquals(page.appended.length, 1);
});

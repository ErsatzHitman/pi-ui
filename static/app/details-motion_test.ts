import { afterEach, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import { assert, assertEquals } from "#testing/assertions";

import {
	bindDetailsMotion,
	chevronTurns,
	isPinnedScroller,
	nextDetailsIntent,
	settleDetails,
} from "./details-motion.js";
import { scrollBottom } from "./message-scroll.js";

/** The declarations of the (first) rule whose selector is exactly `selector`. */
function ruleBody(file: string, selector: string): string {
	const css = readFileSync(new URL(file, import.meta.url), "utf8");
	const start = css.indexOf(`${selector} {`);
	assert(start >= 0, `${file} has a \`${selector}\` rule`);
	return css.slice(start, css.indexOf("}", start));
}

test("a click toggles a resting details", () => {
	assertEquals(nextDetailsIntent(true, undefined), false);
	assertEquals(nextDetailsIntent(false, undefined), true);
});

test("a click mid-flight reverses the latest intent, not the DOM state", () => {
	// While either direction animates the details stays open in the DOM.
	assertEquals(nextDetailsIntent(true, { wantOpen: false }), true);
	assertEquals(nextDetailsIntent(true, { wantOpen: true }), false);
});

test("close, then click again mid-flight, ends open", () => {
	const details = { open: true };
	const closing = { wantOpen: nextDetailsIntent(details.open, undefined) };
	const reopening = { wantOpen: nextDetailsIntent(details.open, closing) };
	// The cancelled close never settles; only the latest intent may.
	assertEquals(settleDetails(details, closing, reopening), false);
	assertEquals(details.open, true);
	assertEquals(settleDetails(details, reopening, reopening), true);
	assertEquals(details.open, true);
});

test("open, then click again mid-flight, ends closed", () => {
	const details = { open: false };
	const opening = { wantOpen: nextDetailsIntent(details.open, undefined) };
	details.open = true; // opened synchronously for the animation
	const closing = { wantOpen: nextDetailsIntent(details.open, opening) };
	assertEquals(settleDetails(details, opening, closing), false);
	assertEquals(settleDetails(details, closing, closing), true);
	assertEquals(details.open, false);
});

test("the WAAPI chevron turn mirrors the CSS it stands in for", () => {
	const { context, piui } = chevronTurns;
	const icon = ruleBody("../../src/ui/messages.css", "	.context-chevron-icon");
	assert(
		icon.includes(`${context.property}: ${context.closed};`),
		"context closed turn",
	);
	const openIcon = ruleBody(
		"../../src/ui/messages.css",
		".context-details[open] > .context-summary .context-chevron-icon",
	);
	assert(
		openIcon.includes(`${context.property}: ${context.open};`),
		"context open turn",
	);
	const marker = ruleBody(
		"../../src/ui/pi-ui-elements.css",
		".piui-widget-lines-collapsible summary::before",
	);
	assert(
		marker.includes(`transition: ${piui.property} `),
		"PIUI marker turns on transform",
	);
	assert(!marker.includes(`${piui.property}:`), "PIUI closed marker is untransformed");
	const openMarker = ruleBody(
		"../../src/ui/pi-ui-elements.css",
		".piui-widget-lines-collapsible[open] summary::before",
	);
	assert(openMarker.includes(`${piui.property}: ${piui.open};`), "PIUI open turn");
});

test("a transcript within 2px of its bottom counts as pinned", () => {
	assertEquals(
		isPinnedScroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }),
		true,
	);
	assertEquals(
		isPinnedScroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 598 }),
		true,
	);
	assertEquals(
		isPinnedScroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 597 }),
		false,
	);
});

// --- Hand-written browser stand-ins (no DOM library in this repo) -------------------

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

class FakeElement {}
class FakeHTMLElement extends FakeElement {
	style = { overflow: "", removeProperty() {} };
	animate() {
		let finish: () => void = () => {};
		const finished = new Promise<void>((resolve) => (finish = resolve));
		animations.push(finish);
		return { finished, cancel() {} };
	}
}
class FakeDetails extends FakeHTMLElement {
	open = false;
	classList = { contains: () => false };
	children: unknown[] = [];
	getBoundingClientRect() {
		return { height: this.open ? 200 : 20 };
	}
}
let animations: (() => void)[] = [];

/** A pinned-or-not transcript holding one closed accordion, and a click on its summary. */
function accordionInTranscript(scrollTop: number) {
	animations = [];
	let frame = new Map<number, () => void>();
	let next = 1;
	install("requestAnimationFrame", (callback: () => void) => {
		frame.set(next, callback);
		return next++;
	});
	install("cancelAnimationFrame", (id: number) => frame.delete(id));
	spyOn(performance, "now").mockImplementation(() => 0);
	install("matchMedia", () => ({ matches: false }));
	install("innerHeight", 800);
	install("getComputedStyle", () => ({ opacity: "1" }));
	install("Element", FakeElement);
	install("HTMLElement", FakeHTMLElement);
	install("HTMLButtonElement", class {});
	install("HTMLDetailsElement", FakeDetails);
	const details = new FakeDetails();
	const summary = Object.assign(new FakeElement(), {
		closest: () => summary,
		parentElement: details,
		querySelector: () => null,
		getBoundingClientRect: () => ({ height: 20 }),
	});
	details.children = [summary, new FakeHTMLElement()];
	const messages = Object.assign(new FakeHTMLElement(), {
		scrollHeight: 1000,
		clientHeight: 400,
		scrollTop,
		contains: (node: unknown) => node === details,
		scrollTo() {},
	});
	let click: (event: unknown) => void = () => {};
	install("document", {
		addEventListener: (_type: string, handler: (event: unknown) => void) =>
			(click = handler),
		getElementById: (id: string) => (id === "messages" ? messages : null),
	});
	return {
		messages,
		click: () => click({ target: summary, preventDefault() {} }),
		frame: () => {
			const current = frame;
			frame = new Map();
			for (const callback of current.values()) callback();
		},
		pending: () => frame.size,
	};
}

test("an accordion in a pinned transcript grows upward with the bottom edge held", async () => {
	const transcript = accordionInTranscript(600);
	scrollBottom("instant");
	transcript.messages.scrollTop = 600;
	bindDetailsMotion();
	transcript.click();
	// The details grows 60px this frame: the reply below stays where it was.
	transcript.messages.scrollHeight = 1060;
	transcript.frame();
	assertEquals(transcript.messages.scrollTop, 660);
	for (const finish of animations) finish();
	await new Promise((resolve) => setTimeout(resolve, 0));
	// Released two frames after the settle (its layout still runs under the hold).
	for (let frame = 0; frame < 3; frame++) transcript.frame();
	assertEquals(transcript.pending(), 0);
});

test("an accordion in a scrolled-up transcript leaves the scroll alone", () => {
	const transcript = accordionInTranscript(100);
	bindDetailsMotion();
	transcript.click();
	transcript.messages.scrollHeight = 1060;
	transcript.frame();
	assertEquals(transcript.messages.scrollTop, 100);
});

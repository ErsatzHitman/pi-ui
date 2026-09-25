import { afterEach, spyOn, test } from "bun:test";

import { assert, assertEquals } from "#testing/assertions";

import {
	blockRevealTargets,
	followBottom,
	hasPointerDragIntent,
	markUnpinned,
	nextSpacerHeight,
	quietTranscript,
	releasedSpacerHeight,
	retainedAnchorScrollTop,
	scrollBottom,
	shouldRearmAfterScroll,
	shouldTrimOldMessages,
} from "./message-scroll.js";

test("retained message anchor preserves its viewport offset", () => {
	assertEquals(retainedAnchorScrollTop(240, 760, 40), 960);
	assertEquals(retainedAnchorScrollTop(960, 40, 40), 960);
});

test("pointer presses require drag intent before releasing follow mode", () => {
	assertEquals(hasPointerDragIntent(100, 100, 100, 100), false);
	assertEquals(hasPointerDragIntent(100, 100, 107, 100), false);
	assertEquals(hasPointerDragIntent(100, 100, 108, 100), true);
	assertEquals(hasPointerDragIntent(100, 100, 106, 106), true);
});

test("old messages trim only when every candidate is above the viewport", () => {
	assertEquals(shouldTrimOldMessages(1, 99, 100), true);
	assertEquals(shouldTrimOldMessages(1, 101, 100), false);
	assertEquals(shouldTrimOldMessages(0, 99, 100), false);
});

test("downward scrolling that reaches the live edge re-arms following", () => {
	assertEquals(shouldRearmAfterScroll(false, 400, 420, 8), true);
	assertEquals(shouldRearmAfterScroll(false, 400, 420, 8.1), false);
	assertEquals(shouldRearmAfterScroll(false, 420, 400, 0), false);
	assertEquals(shouldRearmAfterScroll(true, 400, 420, 0), false);
});

// --- Hand-written browser stand-ins (no DOM library in this repo) -------------------

/** Patches a global via `Object.defineProperty` (see file-links_test.ts). */
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

/** A manual rAF clock: `frame(t)` runs every queued callback at time `t`. */
function fakeFrames() {
	let queue = new Map<number, (now: number) => void>();
	let next = 1;
	let clock = 0;
	install("requestAnimationFrame", (callback: (now: number) => void) => {
		const id = next++;
		queue.set(id, callback);
		return id;
	});
	install("cancelAnimationFrame", (id: number) => queue.delete(id));
	spyOn(performance, "now").mockImplementation(() => clock);
	return {
		frame(now: number) {
			clock = now;
			const current = queue;
			queue = new Map();
			for (const callback of current.values()) callback(now);
		},
		pending: () => queue.size,
	};
}

/** A document with no transcript nodes, for code paths that only look them up. */
function emptyDocument(): void {
	install("document", { getElementById: () => null });
	install("HTMLElement", class {});
	install("HTMLButtonElement", class {});
}

function reducedMotion(matches: boolean): void {
	install("matchMedia", () => ({ matches }));
}

function scroller(scrollHeight: number, clientHeight: number, scrollTop: number) {
	return { scrollHeight, clientHeight, scrollTop };
}

test("the send hold gives the composer's shrink back only as the transcript grows", () => {
	const hold = { px: 201, baseTop: 800, until: 1500 };
	// The composer collapsed (needed 135) but nothing arrived yet: hold the old height.
	assertEquals(nextSpacerHeight(135, hold, 800, 100, true), { height: 201, hold });
	// A 40px article arrived: give back exactly what the transcript grew.
	assertEquals(nextSpacerHeight(135, hold, 840, 120, true), { height: 161, hold });
	// Grown past the shrink: the hold ends.
	assertEquals(nextSpacerHeight(135, hold, 900, 140, true), {
		height: 135,
		hold: undefined,
	});
	// Expired, or the reader scrolled away: the hold ends.
	assertEquals(nextSpacerHeight(135, hold, 800, 1501, true).hold, undefined);
	assertEquals(nextSpacerHeight(135, hold, 800, 100, false).hold, undefined);
	assertEquals(nextSpacerHeight(135, undefined, 0, 0, true), {
		height: 135,
		hold: undefined,
	});
});

test("the send hold outlives its timer while the response is still pending", () => {
	const hold = { px: 201, baseTop: 800, until: 1500 };
	// Expired, but the "thinking..." row still waits: keep holding for the response.
	assertEquals(nextSpacerHeight(135, hold, 800, 1600, true, true), {
		height: 201,
		hold,
	});
	// Expired with nothing pending: release the held height as a glide, not a step.
	assertEquals(nextSpacerHeight(135, hold, 820, 1600, true, false), {
		height: 135,
		hold: undefined,
		release: 181,
	});
	// Grown into, or scrolled away: nothing to glide.
	assertEquals(nextSpacerHeight(135, hold, 900, 1600, true, false).release, undefined);
	assertEquals(nextSpacerHeight(135, hold, 800, 1600, false, false).release, undefined);
});

test("a released spacer eases down to the live needed height over 200ms", () => {
	const release = { from: 200, start: 1000, raf: 0 };
	assertEquals(releasedSpacerHeight(release, 150, 1000, true), 200);
	const mid = releasedSpacerHeight(release, 150, 1100, true);
	assert(mid !== undefined && mid > 150 && mid < 175, `mid-glide ${mid}`);
	// Done, unpinned, or already at/below the needed height: the spacer takes `needed`.
	assertEquals(releasedSpacerHeight(release, 150, 1200, true), undefined);
	assertEquals(releasedSpacerHeight(release, 150, 1100, false), undefined);
	assertEquals(releasedSpacerHeight(release, 220, 1100, true), undefined);
	assertEquals(releasedSpacerHeight(undefined, 150, 1100, true), undefined);
});

test("the pinned follow snaps for a screen-sized step or under reduced motion", () => {
	fakeFrames();
	reducedMotion(false);
	const far = scroller(2000, 400, 500);
	followBottom(far);
	assertEquals(far.scrollTop, 2000);
	reducedMotion(true);
	const near = scroller(1000, 400, 500);
	followBottom(near);
	assertEquals(near.scrollTop, 1000);
});

test("the pinned follow glides over 200ms and retargets from where it is", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	emptyDocument();
	scrollBottom("instant");
	const messages = scroller(1000, 400, 500);
	followBottom(messages);
	assertEquals(messages.scrollTop, 500);
	frames.frame(100);
	const mid = messages.scrollTop;
	assert(mid > 500 && mid < 600, `mid-flight ${mid}`);
	// More content arrives mid-flight: continue from the current position.
	messages.scrollHeight = 1050;
	followBottom(messages);
	assertEquals(messages.scrollTop, mid);
	frames.frame(150);
	assert(messages.scrollTop > mid, "keeps moving toward the new bottom");
	frames.frame(300);
	assertEquals(messages.scrollTop, 650);
	assertEquals(frames.pending(), 0);
});

test("unpinning mid-follow stops it at once", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	emptyDocument();
	scrollBottom("instant");
	const messages = scroller(1000, 400, 500);
	followBottom(messages);
	frames.frame(50);
	const stopped = messages.scrollTop;
	markUnpinned();
	frames.frame(300);
	assertEquals(messages.scrollTop, stopped);
});

class FakeElement {
	constructor(
		readonly classes: string[] = [],
		readonly narrative?: boolean,
	) {}
	classList = { contains: (name: string) => this.classes.includes(name) };
	closest() {
		return this.narrative ? this : null;
	}
}

test("block reveal fades pure appends in a streaming narrative only", () => {
	install("Element", FakeElement);
	const content = new FakeElement(["markdown-content"], true);
	const finalized = new FakeElement(["markdown-content"], false);
	const block = new FakeElement();
	const table = new FakeElement();
	const paragraph = new FakeElement();
	const record = (target: unknown, added: unknown[], removed: unknown[] = []) => ({
		target,
		addedNodes: added,
		removedNodes: removed,
	});
	assertEquals(blockRevealTargets([record(content, [block])]), [block]);
	// A paragraph turning into a table snaps: the same batch removed an element there.
	assertEquals(
		blockRevealTargets([record(content, [table]), record(content, [], [paragraph])]),
		[],
	);
	// Finalized (data-ignore-morph) or entering articles never match.
	assertEquals(blockRevealTargets([record(finalized, [block])]), []);
	// Other targets (tokens inside a block) are ignored.
	assertEquals(blockRevealTargets([record(new FakeElement(["p"]), [block])]), []);
});

test("the transcript stays quiet for its insertion frame plus two, or until released", async () => {
	const frames = fakeFrames();
	const attributes = new Set<string>();
	install("document", {
		documentElement: {
			setAttribute: (name: string) => attributes.add(name),
			removeAttribute: (name: string) => attributes.delete(name),
		},
	});
	quietTranscript();
	assert(attributes.has("data-transcript-quiet"), "set synchronously");
	await new Promise((resolve) => setTimeout(resolve, 0));
	frames.frame(16);
	assert(attributes.has("data-transcript-quiet"), "still quiet after one frame");
	frames.frame(32);
	assert(!attributes.has("data-transcript-quiet"), "released after two frames");

	// History: held until the batch lands (the next unheld call), not by the timers.
	quietTranscript({ hold: true });
	await new Promise((resolve) => setTimeout(resolve, 0));
	frames.frame(48);
	frames.frame(64);
	assert(attributes.has("data-transcript-quiet"), "held while history loads");
	quietTranscript();
	await new Promise((resolve) => setTimeout(resolve, 0));
	frames.frame(80);
	frames.frame(96);
	assert(!attributes.has("data-transcript-quiet"), "released after the batch");
});

class FakeHTMLElement {
	style = { removeProperty() {} };
	constructor(
		public scrollHeight: number,
		public clientHeight: number,
		public scrollTop: number,
	) {}
	scrollTo({ top }: { top: number }) {
		this.scrollTop = Math.min(top, this.scrollHeight - this.clientHeight);
	}
}

test("an explicit snap to the bottom cancels an in-flight follow", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	install("HTMLElement", FakeHTMLElement);
	install("HTMLButtonElement", class {});
	const messages = new FakeHTMLElement(1000, 400, 500);
	install("document", {
		getElementById: (id: string) => (id === "messages" ? messages : null),
	});
	followBottom(messages);
	frames.frame(50);
	// Send / G / anchor restore: snap to the bottom mid-follow.
	messages.scrollHeight = 1100;
	scrollBottom("instant");
	assertEquals(messages.scrollTop, 700);
	// The stale tween must not pull it back toward its old target next frame.
	frames.frame(66);
	assertEquals(messages.scrollTop, 700);
	assertEquals(frames.pending(), 0);
});

test("jump to latest lands a screen above, then tweens to the live bottom in 250ms", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	install("HTMLElement", FakeHTMLElement);
	install("HTMLButtonElement", class {});
	const messages = new FakeHTMLElement(5400, 400, 0);
	install("document", {
		getElementById: (id: string) => (id === "messages" ? messages : null),
	});
	scrollBottom("smooth");
	// 5000px away: pre-jump to one screen above the bottom.
	assertEquals(messages.scrollTop, 4600);
	frames.frame(100);
	assert(messages.scrollTop > 4600 && messages.scrollTop < 5000, "tweening");
	// Streaming grows the transcript mid-jump; the pinned follow must not take over.
	messages.scrollHeight = 5500;
	followBottom(messages);
	const during = messages.scrollTop;
	assert(during < 5100, "the jump keeps scrollTop");
	frames.frame(250);
	assertEquals(messages.scrollTop, 5100);
});

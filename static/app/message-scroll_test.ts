import { afterEach, spyOn, test } from "bun:test";

import { assert, assertEquals } from "#testing/assertions";

import {
	transcriptFootChanges,
	bindMessageResize,
	blockRevealTargets,
	chaseStep,
	composerLift,
	enterFrom,
	followBottom,
	frameClampedStart,
	hasPointerDragIntent,
	holdFollow,
	holdSpacerForSend,
	insertionReveals,
	insertionShifts,
	markUnpinned,
	nextSpacerHeight,
	promptClearance,
	quietTranscript,
	releasedSpacerHeight,
	retainedAnchorScrollTop,
	rowGapUnfilled,
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

/** Runs 60fps frames from `from` until nothing is queued (or `limit` frames). */
function runFrames(
	frames: ReturnType<typeof fakeFrames>,
	from: number,
	onFrame: () => void = () => {},
	limit = 200,
): number {
	let count = 0;
	for (let now = from; frames.pending() > 0 && count < limit; now += 1000 / 60) {
		frames.frame(now);
		onFrame();
		count++;
	}
	return count;
}

test("the pinned follow glides over 200ms and retargets from where it is", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	emptyDocument();
	scrollBottom("instant");
	const messages = scroller(1000, 400, 500);
	followBottom(messages);
	assertEquals(messages.scrollTop, 500);
	// The clock starts at the first frame, which does not move yet.
	frames.frame(0);
	assertEquals(messages.scrollTop, 500);
	frames.frame(100);
	const mid = messages.scrollTop;
	assert(mid > 500 && mid < 600, `mid-flight ${mid}`);
	// More content arrives mid-flight: continue from the current position.
	messages.scrollHeight = 1050;
	followBottom(messages);
	assertEquals(messages.scrollTop, mid);
	frames.frame(116);
	assert(messages.scrollTop > mid, "keeps moving toward the new bottom");
	runFrames(frames, 133);
	assertEquals(messages.scrollTop, 650);
	assertEquals(frames.pending(), 0);
});

test("a long frame before the first step never collapses the glide into a snap", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	emptyDocument();
	scrollBottom("instant");
	const messages = scroller(1300, 400, 500);
	followBottom(messages, true);
	// A 400ms busy frame lands between scheduling and the first rAF.
	frames.frame(400);
	assert((messages.scrollTop - 500) / 400 <= 0.35, `first step ${messages.scrollTop}`);
	let moving = 0;
	let last = messages.scrollTop;
	runFrames(frames, 400 + 1000 / 60, () => {
		if (messages.scrollTop > last) moving++;
		last = messages.scrollTop;
	});
	assertEquals(messages.scrollTop, 900);
	assert(moving >= 10, `glides over ${moving} frames`);
});

test("streaming growth is chased in steps of at most 8px, never restarted", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	emptyDocument();
	scrollBottom("instant");
	const messages = scroller(1000, 400, 600);
	let now = 0;
	let last = messages.scrollTop;
	let maxStep = 0;
	for (let frame = 0; frame < 120; frame++) {
		// Three 24px retargets, 33ms apart (every other frame).
		if (frame === 0 || frame === 2 || frame === 4) {
			messages.scrollHeight += 24;
			followBottom(messages);
		}
		frames.frame(now);
		maxStep = Math.max(maxStep, Math.abs(messages.scrollTop - last));
		last = messages.scrollTop;
		now += 1000 / 60;
	}
	assert(maxStep <= 8, `max per-frame step ${maxStep}`);
	assertEquals(messages.scrollTop, 672);
	assertEquals(frames.pending(), 0);
});

test("the chase step is critically damped, capped, and never passes its target", () => {
	const frame = 1 / 60;
	// From rest: a gentle first step toward the target.
	const first = chaseStep(0, 0, 24, frame, 8);
	assert(first.pos > 0 && first.pos < 8, `first ${first.pos}`);
	// A far target: the cap binds.
	assertEquals(chaseStep(0, 0, 900, frame, 25).pos, 25);
	// A fast run-in: it lands on the target, never beyond it.
	assertEquals(chaseStep(99, 3000, 100, frame, 100), { pos: 100, v: 0, done: true });
	// No time yet (first frame): no movement.
	assertEquals(chaseStep(10, 0, 40, 0, 8).pos, 10);
});

test("a new message taller than a screen lands a screen above its bottom, then glides", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	emptyDocument();
	scrollBottom("instant");
	const messages = scroller(2400, 400, 600);
	followBottom(messages, true);
	assertEquals(messages.scrollTop, 1600);
	runFrames(frames, 0);
	assertEquals(messages.scrollTop, 2000);
	// Not a new message (a transcript replace): the same step snaps.
	const replaced = scroller(2400, 400, 600);
	followBottom(replaced);
	assertEquals(replaced.scrollTop, 2400);
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

test("a send while pinned keeps an in-flight follow gliding to the new bottom", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	install("HTMLElement", FakeHTMLElement);
	install("HTMLButtonElement", class {});
	const messages = new FakeHTMLElement(1000, 400, 500);
	install("document", {
		getElementById: (id: string) => (id === "messages" ? messages : null),
	});
	scrollBottom("instant");
	messages.scrollTop = 500;
	followBottom(messages);
	frames.frame(0);
	frames.frame(50);
	const mid = messages.scrollTop;
	assert(mid > 500 && mid < 600, `mid-follow ${mid}`);
	// Enter queues a steer (prompt-box.tsx calls scrollBottom()) while it still catches up.
	messages.scrollHeight = 1030;
	scrollBottom();
	assertEquals(messages.scrollTop, mid);
	let last = mid;
	let biggest = 0;
	runFrames(frames, 66, () => {
		biggest = Math.max(biggest, messages.scrollTop - last);
		last = messages.scrollTop;
	});
	assertEquals(messages.scrollTop, 630);
	assert(biggest < 20, `largest single-frame step ${biggest}px`);
	scrollBottom("instant");
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
	frames.frame(0);
	assertEquals(messages.scrollTop, 4600);
	for (let now = 1000 / 60; now < 100; now += 1000 / 60) frames.frame(now);
	assert(messages.scrollTop > 4600 && messages.scrollTop < 5000, "tweening");
	// Streaming grows the transcript mid-jump; the pinned follow must not take over.
	messages.scrollHeight = 5500;
	followBottom(messages);
	const during = messages.scrollTop;
	assert(during < 5100, "the jump keeps scrollTop");
	// It lands on the live bottom at 250ms.
	for (let now = 100; now <= 250; now += 1000 / 60) frames.frame(now);
	frames.frame(250);
	assertEquals(messages.scrollTop, 5100);
});

test("the spacer is sized for the settled textarea while it collapses", () => {
	// The textarea settles at 24px; mid-collapse it is still 138px of a 258px composer.
	const settle = { input: 24, until: 1160 };
	assertEquals(promptClearance(258, settle, 1080, 138), 192);
	// After the collapse (or with none) the live height counts.
	assertEquals(promptClearance(150, settle, 1160, 24), 198);
	assertEquals(promptClearance(150, undefined, 0), 198);
	// So a 700px growth past a 306px hold releases straight to 192, in one call: no
	// frame-by-frame tracking of the collapsing textarea.
	const hold = { px: 306, baseTop: 800, until: 2500 };
	const needed = promptClearance(258, settle, 1080, 138);
	assertEquals(nextSpacerHeight(needed, hold, 1500, 1080, true), {
		height: 192,
		hold: undefined,
	});
	const later = promptClearance(210, settle, 1120, 90);
	assertEquals(nextSpacerHeight(later, undefined, 1500, 1120, true).height, 192);
});

test("a queued steer easing in mid-collapse is tracked live, not after the settle", () => {
	const settle = { input: 24, until: 1160 };
	// The textarea is still 138px, and the queue has already grown the composer by 30px.
	assertEquals(promptClearance(288, settle, 1080, 138), 222);
});

test("only the composer's share of a spacer growth lifts the pinned transcript", () => {
	// The first pass for a spacer has nothing to compare with.
	assertEquals(composerLift(240, undefined, 48), 0);
	// The queue eased the composer 12px taller this frame, and the spacer grew with it.
	assertEquals(composerLift(252, 240, 12), 12);
	// A held spacer (send hold) absorbs the growth: nothing moves.
	assertEquals(composerLift(252, 240, 0), 0);
	// The spacer grew past the composer's growth (a row lifted into it): only 12px.
	assertEquals(composerLift(252, 240, 50), 12);
	// A shrinking composer is followed by the scroll clamp instead.
	assertEquals(composerLift(228, 240, -12), 0);
});

test("a pending row replaced by an article at least as tall holds nothing", () => {
	// The row's share is 50px; a 52px card fills it: the foot never moved up.
	assertEquals(rowGapUnfilled(50, 1052, 1002, 1000), 0);
	// A 20px first line leaves 30px to hold until the reply grows into it.
	assertEquals(rowGapUnfilled(50, 1020, 970, 1000), 30);
	// Shown and answered in one batch: nothing was painted to step from.
	assertEquals(rowGapUnfilled(50, 1072, 1022, 950), 0);
	// Nothing measured yet: the row's whole share.
	assertEquals(rowGapUnfilled(50, 1052, 1002, undefined), 50);
	// The lift left the spacer's top unchanged (unmeasurable): the row's own height.
	assertEquals(rowGapUnfilled(50, 1000, 1000, undefined), 50);
});

test("rows below an inserted article are shifted by the run above them", () => {
	// A user article inserted above an extension card that landed first.
	assertEquals(
		insertionShifts([
			{ inserted: true, top: 135 },
			{ inserted: false, top: 235 },
		]),
		[0, 100],
	);
	// Two runs: the rows after the second run move by both.
	assertEquals(
		insertionShifts([
			{ inserted: true, top: 100 },
			{ inserted: true, top: 140 },
			{ inserted: false, top: 180 },
			{ inserted: false, top: 260 },
			{ inserted: true, top: 300 },
			{ inserted: false, top: 330 },
		]),
		[0, 0, 80, 80, 0, 110],
	);
});

test("an inserted article is clipped to the space its displaced rows have left", () => {
	// A 100px user article above a card that landed first, 8px apart: its clip starts at
	// the whole share (card top less the gap) and eases to 0 on the glide's curve.
	assertEquals(
		insertionReveals([
			{ inserted: true, top: 135, height: 100 },
			{ inserted: false, top: 243, height: 40 },
		]),
		[108, 0],
	);
	// A run of two: the earlier one is bounded by its distance above the run's end.
	assertEquals(
		insertionReveals([
			{ inserted: true, top: 100, height: 30 },
			{ inserted: true, top: 140, height: 30 },
			{ inserted: false, top: 180, height: 60 },
		]),
		[40, 80, 0],
	);
	// Nothing displaced after a run (the list's tail): no clip.
	assertEquals(
		insertionReveals([
			{ inserted: false, top: 100, height: 30 },
			{ inserted: true, top: 140, height: 30 },
		]),
		[0, 0],
	);
});

test("a not-yet-started spacer release holds its start height", () => {
	const release = { from: 240, start: undefined, raf: 0 };
	assertEquals(releasedSpacerHeight(release, 192, 5000, true), 240);
});

class FakeNode {
	constructor(
		readonly selector: string,
		readonly id = "",
	) {}
	matches(selector: string) {
		return selector === this.selector;
	}
}

test("only a live article landing under a showing row replaces the row", () => {
	install("Element", FakeNode);
	const live = new FakeNode(".message[data-enter]");
	const earlier = new FakeNode(".message[data-enter]");
	const rerendered = new FakeNode(".message");
	const row = new FakeNode(".message-pending", "message-pending");
	const list = { lastElementChild: live };
	const stack = {};
	const record = (target: unknown, added: unknown[]) => ({ target, addedNodes: added });
	const none = { appended: false, replacesRow: false };
	assertEquals(transcriptFootChanges([record(list, [live])], list), {
		appended: true,
		replacesRow: true,
	});
	// The row was shown after the article (a card that landed before the wait began).
	assertEquals(
		transcriptFootChanges([record(list, [live]), record(stack, [row])], list),
		{
			appended: true,
			replacesRow: false,
		},
	);
	// Shown, then answered, in one batch.
	assertEquals(
		transcriptFootChanges([record(stack, [row]), record(list, [live])], list)
			.replacesRow,
		true,
	);
	// Inserted earlier in the list (not the row's slot): not a replace.
	assertEquals(transcriptFootChanges([record(list, [earlier])], list), {
		appended: true,
		replacesRow: false,
	});
	// Re-rendered without the marker (reconnect, replace), or nested growth: nothing.
	assertEquals(transcriptFootChanges([record(list, [rerendered])], list), none);
	assertEquals(transcriptFootChanges([record({}, [live])], list), none);
});

/** A scroller whose scrollTop clamps to its range, as a browser's does. */
class ClampedScroller {
	#top = 0;
	style = { removeProperty() {} };
	constructor(
		public scrollHeight: number,
		public clientHeight: number,
		scrollTop: number,
	) {
		this.scrollTop = scrollTop;
	}
	get scrollTop() {
		return this.#top;
	}
	set scrollTop(value: number) {
		this.#top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
	}
	scrollTo({ top }: { top: number }) {
		this.scrollTop = top;
	}
}

/** Lets bindMessageResize's quiet-transcript timer run while the fake rAF is installed. */
async function quietReleased(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The module keeps one ResizeObserver for its lifetime: its callback, once created. */
let resizeCallback: (entries: unknown[]) => void = () => {};

/** The module keeps one #message-list MutationObserver: its callback, once created. */
let listMutated: (records: unknown[]) => void = () => {};

/** A stub transcript: #messages, its stack, the composer, and a ResizeObserver hook.
 * `enter`: #messages is a session replace's incoming node (`data-enter`). */
function transcriptStubs({ enter = false, scrollTop = 1400, promptHeight = 144 } = {}) {
	const attributes = new Set<string>();
	const messages = Object.assign(new ClampedScroller(2000, 600, scrollTop), {
		classList: { contains: () => false },
		hasAttribute: (name: string) => enter && name === "data-enter",
	});
	const list = new ClampedScroller(0, 0, 0);
	const stack = new ClampedScroller(0, 0, 0);
	const prompt = Object.assign(new ClampedScroller(0, 0, 0), {
		offsetHeight: promptHeight,
	});
	let spacerHeight = 306;
	const spacer = {
		offsetTop: 1000,
		get offsetHeight() {
			return spacerHeight;
		},
		style: {
			get height() {
				return `${spacerHeight}px`;
			},
			set height(value: string) {
				spacerHeight = Number.parseFloat(value);
			},
		},
	};
	Object.setPrototypeOf(spacer, ClampedScroller.prototype);
	const nodes = new Map<string, unknown>([
		["messages", messages],
		["message-list", list],
		["prompt-box", prompt],
		["messages-prompt-spacer", spacer],
	]);
	install("HTMLElement", ClampedScroller);
	install("HTMLButtonElement", class {});
	install("document", {
		documentElement: {
			setAttribute: (name: string) => attributes.add(name),
			removeAttribute: (name: string) => attributes.delete(name),
			hasAttribute: (name: string) => attributes.has(name),
		},
		getElementById: (id: string) => nodes.get(id) ?? null,
		querySelector: (selector: string) =>
			selector === "#messages > .messages-stack" ? stack : null,
	});
	install(
		"MutationObserver",
		class {
			constructor(readonly callback: (records: unknown[]) => void) {}
			observe(target: unknown) {
				if (target === list) listMutated = this.callback;
			}
			disconnect() {}
		},
	);
	install(
		"ResizeObserver",
		class {
			constructor(callback: (entries: unknown[]) => void) {
				resizeCallback = callback;
			}
			observe() {}
			unobserve() {}
		},
	);
	bindMessageResize();
	return {
		messages,
		list,
		spacer,
		resize: (width: number) =>
			resizeCallback([{ target: stack, contentRect: { width } }]),
	};
}

test("a narrower stack re-wraps the transcript with its bottom edge held, no glide", async () => {
	const frames = fakeFrames();
	reducedMotion(false);
	const { messages, resize } = transcriptStubs();
	scrollBottom("instant");
	resize(800);
	assertEquals(messages.scrollTop, 1400);
	// Sessions opens: the stack narrows and the transcript re-wraps 99px taller.
	messages.scrollHeight = 2099;
	resize(700);
	assertEquals(messages.scrollTop, 1499);
	// Nothing glides afterwards (no follow was started).
	frames.frame(16);
	frames.frame(33);
	assertEquals(messages.scrollTop, 1499);
	assertEquals(frames.pending(), 0);
	// Height-only growth still glides.
	messages.scrollHeight = 2149;
	resize(700);
	assertEquals(messages.scrollTop, 1499);
	assert(frames.pending() > 0, "a follow is running");
	runFrames(frames, 0);
	assertEquals(messages.scrollTop, 1549);
	await quietReleased();
});

test("an accordion hold pins the bottom edge every frame until it settles", async () => {
	const frames = fakeFrames();
	reducedMotion(false);
	const { messages, resize } = transcriptStubs();
	scrollBottom("instant");
	let settle: () => void = () => {};
	holdFollow({ finished: new Promise<void>((resolve) => (settle = resolve)) });
	// The details grows 40px this frame: rAF re-pins, the resize pass does not glide.
	messages.scrollHeight = 2040;
	frames.frame(16);
	assertEquals(messages.scrollTop, 1440);
	messages.scrollHeight = 2080;
	resize(800);
	assertEquals(messages.scrollTop, 1480);
	frames.frame(33);
	settle();
	await Promise.resolve();
	// Released two frames after it settles.
	frames.frame(50);
	frames.frame(66);
	frames.frame(83);
	assertEquals(frames.pending(), 0);
	// Released: growth glides again.
	messages.scrollHeight = 2130;
	followBottom(messages);
	assert(frames.pending() > 0, "the follow is back");
	scrollBottom("instant");
	await quietReleased();
});

test("an expired send hold is kept while the reply still grows, then glides away", async () => {
	const frames = fakeFrames();
	reducedMotion(false);
	const { spacer, resize } = transcriptStubs();
	await quietReleased();
	install("setTimeout", () => 0);
	install("clearTimeout", () => {});
	scrollBottom("instant");
	frames.frame(0);
	holdSpacerForSend();
	// The composer collapsed (needs 192) but nothing arrived yet: hold 306.
	frames.frame(100);
	resize(800);
	assertEquals(spacer.offsetHeight, 306);
	// A reply line lands just before the hold's 1.5s run out: the growth takes 30px back.
	frames.frame(1400);
	spacer.offsetTop = 1030;
	resize(800);
	assertEquals(spacer.offsetHeight, 276);
	// Expired, but the transcript grew 200ms ago: no glide down under the stream.
	frames.frame(1600);
	resize(800);
	assertEquals(spacer.offsetHeight, 276);
	// Quiet for the hold's length: it goes (no motion-ready here, so without the glide).
	frames.frame(3000);
	resize(800);
	assertEquals(spacer.offsetHeight, 192);
});

test("an accordion moving under a live send hold never eats the held space", async () => {
	const frames = fakeFrames();
	reducedMotion(false);
	const { messages, spacer, resize } = transcriptStubs();
	await quietReleased();
	install("setTimeout", () => 0);
	install("clearTimeout", () => {});
	scrollBottom("instant");
	frames.frame(0);
	holdSpacerForSend();
	resize(800);
	assertEquals(spacer.offsetHeight, 306);
	let settle: () => void = () => {};
	holdFollow({ finished: new Promise<void>((resolve) => (settle = resolve)) });
	// The accordion above grows 60px: the reply keeps its place over the held space.
	spacer.offsetTop = 1060;
	messages.scrollHeight = 2060;
	frames.frame(16);
	resize(800);
	assertEquals(spacer.offsetHeight, 306);
	assertEquals(messages.scrollTop, 1460);
	settle();
	await Promise.resolve();
	for (const now of [33, 50, 66]) frames.frame(now);
	scrollBottom("instant");
});

test("a tween's clock advances at most a nominal frame, whatever the timestamps", () => {
	// First frame: the clock starts.
	assertEquals(frameClampedStart(undefined, undefined, 500), 500);
	// A 17ms frame: unchanged.
	assertEquals(frameClampedStart(500, 1000, 1017), 500);
	// A 250ms gap advances only 1000/30 ms: the start moves up by the rest.
	assertEquals(frameClampedStart(500, 1000, 1250), 500 + 250 - 1000 / 30);
	// A stale (earlier) timestamp never moves it back.
	assertEquals(frameClampedStart(500, 1000, 990), 500);
});

test("an appended message's glide never completes in one late frame", () => {
	const frames = fakeFrames();
	reducedMotion(false);
	emptyDocument();
	scrollBottom("instant");
	const messages = scroller(1300, 400, 500);
	followBottom(messages, true);
	frames.frame(1000);
	assertEquals(messages.scrollTop, 500);
	// The next frame arrives 250ms later: at most a 30fps frame's progress.
	frames.frame(1250);
	const progress = (messages.scrollTop - 500) / 400;
	// A 30fps frame's worth of the curve (a normal first frame moves about 0.4).
	assert(progress > 0 && progress < 0.65, `one frame moved ${progress}`);
	assert(frames.pending() > 0, "still gliding");
	runFrames(frames, 1250 + 1000 / 60);
	assertEquals(messages.scrollTop, 900);
});

test("a fast switch fades in briefly from 0.6; a slow one continues from its dim", () => {
	assertEquals(enterFrom(1), { from: "0.6", duration: "var(--duration-sm)" });
	assertEquals(enterFrom(0.83), { from: "0.6", duration: "var(--duration-sm)" });
	assertEquals(enterFrom(0.5), { from: "0.5", duration: "var(--duration-md)" });
	assertEquals(enterFrom(0.504), { from: "0.5", duration: "var(--duration-md)" });
	assertEquals(enterFrom(Number.NaN), { from: "0.6", duration: "var(--duration-sm)" });
});

test("a session replace opens pinned at its bottom, and its first measure never glides", async () => {
	const frames = fakeFrames();
	reducedMotion(false);
	emptyDocument();
	markUnpinned();
	const { messages, resize } = transcriptStubs({ enter: true, scrollTop: 0 });
	// Pinned before its first paint (data-init), not shown at its top.
	assertEquals(messages.scrollTop, 1400);
	// Late layout before the first resize pass: it snaps, it does not ease or chase.
	messages.scrollHeight = 2100;
	resize(800);
	assertEquals(messages.scrollTop, 1500);
	// No follow was started: nothing moves it afterwards.
	messages.scrollTop = 1450;
	for (const now of [16, 33, 50, 66]) frames.frame(now);
	assertEquals(messages.scrollTop, 1450);
	await quietReleased();
});

test("the spacer never aims below its CSS floor", async () => {
	fakeFrames();
	reducedMotion(false);
	install("getComputedStyle", () => ({ minHeight: "192px" }));
	// A 116px composer needs only 164px: the spacer's min-height (12rem) is the floor.
	const { spacer, resize } = transcriptStubs({ promptHeight: 116 });
	resize(800);
	assertEquals(spacer.offsetHeight, 192);
	await quietReleased();
});

test("a send-time follow-up snap keeps a live append's land-and-glide", async () => {
	const frames = fakeFrames();
	reducedMotion(false);
	install("Element", FakeNode);
	const { messages, list, resize } = transcriptStubs();
	resize(800);
	await quietReleased();
	scrollBottom();
	// A live user article taller than a screen lands before the resize pass sees it.
	const article = new FakeNode(".message[data-enter]");
	Object.assign(list, { lastElementChild: article });
	listMutated([{ target: list, addedNodes: [article] }]);
	messages.scrollHeight = 2900;
	// scrollBottom's 16ms follow-up runs first: it lands a screen above, then glides.
	await new Promise((resolve) => setTimeout(resolve, 30));
	assertEquals(messages.scrollTop, 1700);
	runFrames(frames, 0);
	assertEquals(messages.scrollTop, 2300);
	scrollBottom("instant");
});

test("a composer easing taller moves the pinned transcript up in the same pass", async () => {
	const frames = fakeFrames();
	reducedMotion(false);
	const { messages, spacer, resize } = transcriptStubs();
	await quietReleased();
	scrollBottom("instant");
	resize(800);
	runFrames(frames, 0);
	assertEquals(spacer.offsetHeight, 192);
	assertEquals(messages.scrollTop, 1400);
	// One frame of a queued steer easing in: the composer is 16px taller.
	const prompt = document.getElementById("prompt-box") as unknown as {
		offsetHeight: number;
		getAnimations: () => { effect: { getKeyframes: () => object[] } }[];
	};
	const tween = {
		effect: { getKeyframes: () => [{ height: "48px" }, { height: "88px" }] },
	};
	prompt.getAnimations = () => [tween];
	prompt.offsetHeight = 160;
	messages.scrollHeight = 2016;
	resize(800);
	assertEquals(spacer.offsetHeight, 208);
	// Moved with the composer's edge now, not chased a frame or more behind it.
	assertEquals(messages.scrollTop, 1416);
	assertEquals(frames.pending(), 0);
	// Easing back down: the scroll clamp follows the spacer in the same pass.
	prompt.offsetHeight = 144;
	messages.scrollHeight = 2000;
	resize(800);
	assertEquals(spacer.offsetHeight, 192);
	assertEquals(messages.scrollTop, 1400);
	assertEquals(frames.pending(), 0);
	// A stepped growth (a footer re-wrapping for a frame) is not lifted with: the follow
	// chases it, standing still on its first frame.
	prompt.getAnimations = () => [];
	prompt.offsetHeight = 160;
	messages.scrollHeight = 2016;
	resize(800);
	assertEquals(messages.scrollTop, 1400);
	assert(frames.pending() > 0, "a follow chases it");
	scrollBottom("instant");
});

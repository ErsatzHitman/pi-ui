import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	freshIds,
	planQueueExits,
	queueTextKey,
	settleQueueFrame,
} from "./prompt-motion.js";

/** A removed queue item as the MutationObserver hands it over (detached, attributes kept). */
function removedItem(id: string, exit?: string) {
	return {
		id,
		getAttribute: (name: string) => (name === "data-exit" ? (exit ?? null) : null),
	};
}

const offset = {
	left: 12,
	bottom: -80,
	width: 300,
	height: 36,
	clipTop: 0,
	clipBottom: 0,
};

test("freshIds reports only ids that were not on screen before", () => {
	assertEquals(freshIds(new Set(["a", "b"]), ["b", "a", "c"]), ["c"]);
	// A kept node the morph moved or re-inserted is not fresh, so its entry never replays.
	assertEquals(freshIds(new Set(["a", "b"]), ["b", "a"]), []);
});

test("a delivered steer with a cached rect gets exactly one ghost, lifting up", () => {
	const node = removedItem("prompt-queue-steer-x-0");
	const plan = planQueueExits(
		[node],
		new Set<string>(),
		new Map([["prompt-queue-steer-x-0", offset]]),
	);
	assertEquals(plan.length, 1);
	assertEquals(plan[0]?.node, node);
	assertEquals(plan[0]?.offset, offset);
	assertEquals(plan[0]?.translateY, "-0.5rem");
});

test("an item removed with ✕ leaves downward, the way it entered", () => {
	const plan = planQueueExits(
		[removedItem("q-0", "down")],
		new Set<string>(),
		new Map([["q-0", offset]]),
	);
	assertEquals(
		plan.map((exit) => exit.translateY),
		["0.25rem"],
	);
});

test("Restore all sends removed items down into the composer", () => {
	const plan = planQueueExits(
		[removedItem("q-0"), removedItem("q-1")],
		new Set<string>(),
		new Map([
			["q-0", offset],
			["q-1", offset],
		]),
		{ restoring: true },
	);
	assertEquals(
		plan.map((exit) => exit.translateY),
		["0.5rem", "0.5rem"],
	);
});

test("no ghost for an id still present (a move) or without a cached rect", () => {
	const plan = planQueueExits(
		[removedItem("moved"), removedItem("unmeasured"), removedItem("")],
		new Set(["moved"]),
		new Map([["moved", offset]]),
	);
	assertEquals(plan, []);
});

test("✕ on one of two identical texts: the removed twin leaves downward, not lifting", () => {
	// Idiomorph kept the pressed `-0` (stripping its data-exit) and removed `-1`.
	const key = queueTextKey("prompt-queue-steer-abc-1");
	assertEquals(key, "prompt-queue-steer-abc");
	const plan = planQueueExits(
		[
			removedItem("prompt-queue-steer-abc-1"),
			removedItem("prompt-queue-steer-zzz-0"),
		],
		new Set(["prompt-queue-steer-abc-0"]),
		new Map([
			["prompt-queue-steer-abc-1", offset],
			["prompt-queue-steer-zzz-0", offset],
		]),
		{ reassigned: new Map([[key, 1]]) },
	);
	// The unrelated removal in the same batch is still a delivery.
	assertEquals(
		plan.map((exit) => exit.translateY),
		["0.25rem", "-0.5rem"],
	);
});

test("an item scrolled out of the queue list gets no ghost", () => {
	const plan = planQueueExits(
		[removedItem("hidden"), removedItem("partial")],
		new Set<string>(),
		new Map([
			["hidden", { ...offset, clipTop: 36 }],
			["partial", { ...offset, clipTop: 10 }],
		]),
	);
	assertEquals(
		plan.map((exit) => exit.node.id),
		["partial"],
	);
});

test("a list removed and re-added in two callbacks of one frame: no ghosts, no entries", () => {
	// Callback 1 removed section#prompt-queue-list (all three items); callback 2 re-added it.
	// The frame settles once, from the live DOM, so nothing left and nothing is new.
	const previous = new Set(["alpha-0", "bravo-0", "charlie-0"]);
	const removed = [
		removedItem("alpha-0"),
		removedItem("bravo-0"),
		removedItem("charlie-0"),
	];
	const frame = settleQueueFrame(
		previous,
		new Set(previous),
		removed,
		new Set<string>(),
	);
	assertEquals(frame.removed, []);
	assertEquals(frame.fresh, []);
	assertEquals(
		planQueueExits(frame.removed, new Set(previous), new Map([["alpha-0", offset]])),
		[],
	);
});

test("the same removal re-added without one item ghosts only that item, once", () => {
	const previous = new Set(["alpha-0", "bravo-0", "charlie-0"]);
	const present = new Set(["bravo-0", "charlie-0"]);
	// The whole list was removed (and alpha reported twice across callbacks).
	const alpha = removedItem("alpha-0");
	const frame = settleQueueFrame(
		previous,
		present,
		[alpha, removedItem("bravo-0"), removedItem("charlie-0"), removedItem("alpha-0")],
		new Set(["alpha-0"]),
	);
	assertEquals(frame.removed, [alpha]);
	assertEquals(frame.fresh, []);
	// ✕ was pressed on alpha: it leaves downward even though a morph stripped `data-exit`.
	const plan = planQueueExits(frame.removed, present, new Map([["alpha-0", offset]]), {
		removing: new Set(["alpha-0"]),
	});
	assertEquals(
		plan.map((exit) => [exit.node.id, exit.translateY]),
		[["alpha-0", "0.25rem"]],
	);
});

test("✕ on the first of two identical texts: the pressed node is kept, its twin leaves down", () => {
	const previous = new Set(["q-steer-abc-0", "q-steer-abc-1"]);
	const present = new Set(["q-steer-abc-0"]);
	const twin = removedItem("q-steer-abc-1");
	const frame = settleQueueFrame(previous, present, [twin], new Set(["q-steer-abc-0"]));
	assertEquals(frame.kept, ["q-steer-abc-0"]);
	const plan = planQueueExits(
		frame.removed,
		present,
		new Map([["q-steer-abc-1", offset]]),
		{ reassigned: frame.reassigned, removing: new Set(["q-steer-abc-0"]) },
	);
	assertEquals(
		plan.map((exit) => exit.translateY),
		["0.25rem"],
	);
});

test("a new id in the settled frame is fresh; a pressed id with no same-text removal is not kept", () => {
	const frame = settleQueueFrame(
		new Set(["a-0"]),
		new Set(["a-0", "b-0"]),
		[],
		new Set(["a-0"]),
	);
	assertEquals(frame.fresh, ["b-0"]);
	assertEquals(frame.kept, []);
});

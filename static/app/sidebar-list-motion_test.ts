import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { duration, easing } from "./motion.js";
import {
	clearFrames,
	diffRows,
	flipEasing,
	liftedRows,
	removedRowGhost,
} from "./sidebar-list-motion.js";

type Box = { top: number; left: number; width: number; height: number };

function layout(entries: Array<[string, number]>): Map<string, Box> {
	return new Map(
		entries.map(([id, top]) => [id, { top, left: 0, width: 280, height: 56 }]),
	);
}

test("diffRows: a re-sort reports each moved row with its FLIP offset (old - new)", () => {
	const previous = layout([
		["a", 0],
		["b", 56],
		["c", 112],
	]);
	const next = layout([
		["c", 0],
		["a", 56],
		["b", 112],
	]);
	assertEquals(diffRows(previous, next), {
		moved: [
			{ id: "c", dy: 112 },
			{ id: "a", dy: -56 },
			{ id: "b", dy: -56 },
		],
		added: [],
		removed: [],
	});
});

test("diffRows: an inserted row is added and pushes the rows below it", () => {
	const previous = layout([
		["a", 0],
		["b", 56],
	]);
	const next = layout([
		["new", 0],
		["a", 56],
		["b", 112],
	]);
	assertEquals(diffRows(previous, next), {
		moved: [
			{ id: "a", dy: -56 },
			{ id: "b", dy: -56 },
		],
		added: ["new"],
		removed: [],
	});
});

test("diffRows: a deleted row is removed and the rows below it close the gap", () => {
	const previous = layout([
		["a", 0],
		["gone", 56],
		["b", 112],
	]);
	const next = layout([
		["a", 0],
		["b", 56],
	]);
	assertEquals(diffRows(previous, next), {
		moved: [{ id: "b", dy: 56 }],
		added: [],
		removed: ["gone"],
	});
});

test("diffRows: a paged append moves nothing (sub-pixel noise is not a move)", () => {
	const previous = layout([["a", 0]]);
	const next = layout([
		["a", 0.4],
		["b", 56],
	]);
	assertEquals(diffRows(previous, next), { moved: [], added: ["b"], removed: [] });
});

function row(attributes: string[]) {
	return { hasAttribute: (name: string) => attributes.includes(name) };
}

test("a removed delete-pending row ghosts out from its dimmed opacity (B-X0/B-X3)", () => {
	assertEquals(removedRowGhost(row(["data-deleting"]), false), {
		translateY: "0",
		scale: 0.97,
		ms: duration.md,
		fromOpacity: 0.45,
	});
});

test("a removed row that was not pending ghosts from full opacity; reduced motion is shorter", () => {
	assertEquals(removedRowGhost(row([]), false).fromOpacity, 1);
	assertEquals(removedRowGhost(row([]), true).ms, duration.xs);
});

test("a removal closes its gap on ease-out; a pure reorder keeps the in-out glide (SP-11)", () => {
	assertEquals(flipEasing(1), easing.out);
	assertEquals(flipEasing(0), easing.inOut);
});

test("liftedRows: a row moved to the top rides above the rows it crosses", () => {
	const previous = layout([
		["a", 0],
		["b", 56],
		["c", 112],
	]);
	const next = layout([
		["c", 0],
		["a", 56],
		["b", 112],
	]);
	assertEquals([...liftedRows(previous, next)], ["c"]);
});

test("liftedRows: rows and headings pushed down together by an insert cross nothing", () => {
	const previous = layout([
		["heading", 0],
		["a", 24],
		["b", 80],
	]);
	const next = layout([
		["new", 0],
		["heading", 56],
		["a", 80],
		["b", 136],
	]);
	assertEquals(liftedRows(previous, next).size, 0);
});

type Frame = { offset: number; clipPath: string; opacity: number };

function visibleBand(frame: Frame, slot: { top: number; height: number }) {
	const match = /inset\(([\d.]+)px 0 ([\d.]+)px 0\)/.exec(frame.clipPath);
	const top = Number(match?.[1]);
	const bottom = Number(match?.[2]);
	return { top: slot.top + top, bottom: slot.top + slot.height - bottom };
}

type Occupant = { from: number; to: number; height: number };

/** Every sampled keyframe, and so every point between them, clears every occupant. */
function assertClears(
	frames: Frame[],
	slot: { top: number; height: number },
	occupants: Occupant[],
) {
	for (const frame of frames) {
		const band = visibleBand(frame, slot);
		if (band.bottom - band.top <= 0) continue;
		for (const o of occupants) {
			const top = o.from + (o.to - o.from) * frame.offset;
			const overlap =
				Math.min(band.bottom, top + o.height) - Math.max(band.top, top);
			assertEquals(overlap <= 0.01, true);
		}
		assertEquals(
			frame.opacity,
			Math.round(((band.bottom - band.top) / slot.height) * 100) / 100,
		);
	}
}

test("clearFrames: an inserted row never paints over the row it pushes down", () => {
	const slot = { top: 0, height: 56 };
	const pushed = [{ from: 0, to: 56, height: 56 }];
	const frames = clearFrames(slot, pushed) as Frame[];
	assertEquals(frames.length, 13);
	assertEquals(frames[0], { offset: 0, clipPath: "inset(0px 0 56px 0)", opacity: 0 });
	assertEquals(frames.at(-1), {
		offset: 1,
		clipPath: "inset(0px 0 0px 0)",
		opacity: 1,
	});
	assertClears(frames, slot, pushed);
});

test("clearFrames: a new group (heading pushed down with its rows) is revealed as they clear", () => {
	const slot = { top: 0, height: 56 };
	const pushed = [
		{ from: 0, to: 64, height: 24 },
		{ from: 24, to: 88, height: 56 },
	];
	const frames = clearFrames(slot, pushed) as Frame[];
	assertEquals(frames[0]!.opacity, 0);
	assertEquals(frames.at(-1)!.opacity, 1);
	assertClears(frames, slot, pushed);
});

test("clearFrames: a row gliding up out of the slot bounds the visible top", () => {
	const slot = { top: 56, height: 56 };
	const leaving = [{ from: 56, to: 0, height: 56 }];
	const frames = clearFrames(slot, leaving) as Frame[];
	assertEquals(frames[0], { offset: 0, clipPath: "inset(56px 0 0px 0)", opacity: 0 });
	assertEquals(frames.at(-1)!.clipPath, "inset(0px 0 0px 0)");
	assertClears(frames, slot, leaving);
});

test("clearFrames: a removed item's ghost is covered by the rows closing its gap", () => {
	// A heading's old slot: the row above slides down into it, the row below slides up.
	const slot = { top: 100, height: 24 };
	const closing = [
		{ from: 36, to: 100, height: 64 },
		{ from: 124, to: 164, height: 64 },
	];
	const frames = clearFrames(slot, closing) as Frame[];
	assertEquals(frames[0]!.opacity, 1);
	assertEquals(frames.at(-1)!.opacity, 0);
	assertClears(frames, slot, closing);
	const rising = [{ from: 124, to: 100, height: 64 }];
	const covered = clearFrames(slot, rising) as Frame[];
	assertEquals(covered.at(-1)!.clipPath, "inset(0px 0 24px 0)");
	assertClears(covered, slot, rising);
});

test("clearFrames: nothing covers an appended row's slot, so it keeps the plain entry", () => {
	assertEquals(
		clearFrames({ top: 112, height: 56 }, [{ from: 0, to: 56, height: 56 }]),
		undefined,
	);
	assertEquals(clearFrames({ top: 0, height: 56 }, []), undefined);
});

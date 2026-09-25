import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { duration, easing } from "./motion.js";
import { diffRows, flipEasing, removedRowGhost } from "./sidebar-list-motion.js";

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

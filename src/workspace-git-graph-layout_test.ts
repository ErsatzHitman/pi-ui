import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { layoutGitGraphLanes, parseGitGraphRefs } from "./workspace-git-graph-layout.ts";

test("a linear history stays on a single lane", () => {
	const result = layoutGitGraphLanes([
		{ hash: "a", parents: ["b"] },
		{ hash: "b", parents: ["c"] },
		{ hash: "c", parents: [] },
	]);
	assertEquals(result.laneCount, 1);
	assertEquals(
		result.rows.map((row) => row.lane),
		[0, 0, 0],
	);
	for (const row of result.rows) {
		assertEquals(row.segments, [{ fromLane: 0, toLane: 0 }]);
	}
});

test("a feature branch merged back into main forks and rejoins lanes", () => {
	// mg merges m1 (main) and f1 (feature); both trace back to the shared root m0.
	const result = layoutGitGraphLanes([
		{ hash: "mg", parents: ["m1", "f1"] },
		{ hash: "m1", parents: ["m0"] },
		{ hash: "f1", parents: ["m0"] },
		{ hash: "m0", parents: [] },
	]);
	assertEquals(result.laneCount, 2);
	assertEquals(
		result.rows.map((row) => row.lane),
		[0, 0, 1, 0],
	);
	assertEquals(result.rows[0]!.segments, [
		{ fromLane: 0, toLane: 0 },
		{ fromLane: 0, toLane: 1 },
	]);
	assertEquals(result.rows[1]!.segments, [
		{ fromLane: 0, toLane: 0 },
		{ fromLane: 1, toLane: 1 },
	]);
	assertEquals(result.rows[2]!.segments, [
		{ fromLane: 0, toLane: 0 },
		{ fromLane: 1, toLane: 1 },
	]);
	// The join: lane 1 curves back into lane 0 at the shared root, and frees.
	assertEquals(result.rows[3]!.segments, [
		{ fromLane: 0, toLane: 0 },
		{ fromLane: 1, toLane: 0 },
	]);
});

test("an octopus merge opens one lane per extra parent", () => {
	const result = layoutGitGraphLanes([
		{ hash: "mg", parents: ["a", "b", "c"] },
		{ hash: "a", parents: [] },
		{ hash: "b", parents: [] },
		{ hash: "c", parents: [] },
	]);
	assertEquals(result.laneCount, 3);
	assertEquals(
		result.rows.map((row) => row.lane),
		[0, 0, 1, 2],
	);
	assertEquals(result.rows[0]!.segments, [
		{ fromLane: 0, toLane: 0 },
		{ fromLane: 0, toLane: 1 },
		{ fromLane: 0, toLane: 2 },
	]);
});

test("a criss-cross merge draws two lanes converging at their shared commit", () => {
	// x and b1 both descend from b0 (a genuine fork point: b0 has two
	// children in this window, x via its second parent and b1 via its
	// first). The two lines they open must run in parallel lanes and only
	// join exactly at b0's own row — not before.
	const result = layoutGitGraphLanes([
		{ hash: "y", parents: ["x", "b1"] },
		{ hash: "x", parents: ["a1", "b0"] },
		{ hash: "b1", parents: ["b0"] },
		{ hash: "a1", parents: ["base"] },
		{ hash: "b0", parents: ["base"] },
		{ hash: "base", parents: [] },
	]);
	assertEquals(result.laneCount, 3);
	assertEquals(
		result.rows.map((row) => row.lane),
		[0, 0, 1, 0, 1, 0],
	);
	assertEquals(result.rows[1]!.segments, [
		{ fromLane: 0, toLane: 0 },
		{ fromLane: 0, toLane: 2 },
		{ fromLane: 1, toLane: 1 },
	]);
	assertEquals(result.rows[2]!.segments, [
		{ fromLane: 0, toLane: 0 },
		{ fromLane: 1, toLane: 1 },
		{ fromLane: 2, toLane: 2 },
	]);
	// b0's row: lanes 1 and 2 (x's line and b1's line) converge into lane 1.
	assertEquals(result.rows[4]!.segments, [
		{ fromLane: 0, toLane: 0 },
		{ fromLane: 1, toLane: 1 },
		{ fromLane: 2, toLane: 1 },
	]);
});

test("many parallel branch tips reuse a freed lane instead of growing forever", () => {
	const result = layoutGitGraphLanes([
		{ hash: "tip1", parents: ["root1"] },
		{ hash: "root1", parents: [] },
		{ hash: "tip2", parents: ["root2"] },
		{ hash: "root2", parents: [] },
	]);
	// tip1/root1 finish (and free lane 0) before tip2 opens a new lane.
	assertEquals(result.laneCount, 1);
	assertEquals(
		result.rows.map((row) => row.lane),
		[0, 0, 0, 0],
	);
});

test("a detached HEAD and a plain root commit are laid out without parents", () => {
	const result = layoutGitGraphLanes([{ hash: "only", parents: [] }]);
	assertEquals(result.laneCount, 1);
	assertEquals(result.rows, [{ lane: 0, segments: [] }]);
});

test("ref decoration text becomes structured refs", () => {
	assertEquals(
		parseGitGraphRefs(
			"HEAD -> main, origin/main, origin/HEAD, tag: v1.0.0, feature/x",
			"main",
		),
		[
			{ current: true, kind: "local-branch", main: true, name: "main" },
			{ current: false, kind: "remote-branch", main: true, name: "origin/main" },
			{ current: false, kind: "tag", main: false, name: "v1.0.0" },
			{ current: false, kind: "local-branch", main: false, name: "feature/x" },
		],
	);
});

test("a detached HEAD decoration becomes a bare head ref", () => {
	assertEquals(parseGitGraphRefs("HEAD, tag: v2", null), [
		{ current: true, kind: "head", main: false, name: "HEAD" },
		{ current: false, kind: "tag", main: false, name: "v2" },
	]);
});

test("empty decoration text yields no refs", () => {
	assertEquals(parseGitGraphRefs("", "main"), []);
	assertEquals(parseGitGraphRefs("   ", "main"), []);
});

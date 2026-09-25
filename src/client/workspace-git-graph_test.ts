import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	type GitGraphRow,
	unloadedWorkspaceGitGraphSnapshot,
} from "../workspace-git-graph-types.ts";
import { createDetailClearer, newCommitHashes } from "./workspace-git-graph.ts";

function row(hash: string): GitGraphRow {
	return {
		author: "Ada",
		authoredAt: "2026-01-01T00:00:00Z",
		hash,
		lane: 0,
		parents: [],
		refs: [],
		segments: [],
		shortHash: hash.slice(0, 7),
		subject: hash,
	};
}

function rows(...hashes: string[]): GitGraphRow[] {
	return hashes.map(row);
}

test("newCommitHashes: nothing is new on the first load", () => {
	assertEquals([...newCommitHashes(undefined, { rows: rows("a", "b") })], []);
});

test("newCommitHashes: nothing is new when the unloaded placeholder is replaced", () => {
	assertEquals(
		[...newCommitHashes(unloadedWorkspaceGitGraphSnapshot, { rows: rows("a", "b") })],
		[],
	);
});

test("newCommitHashes: a live refresh with a new top commit yields just that hash", () => {
	const previous = { revision: "r1", rows: rows("b", "c") };
	assertEquals([...newCommitHashes(previous, { rows: rows("a", "b", "c") })], ["a"]);
});

test("newCommitHashes: Load more yields exactly the appended hashes", () => {
	const previous = { revision: "r1", rows: rows("a", "b") };
	assertEquals(
		[...newCommitHashes(previous, { rows: rows("a", "b", "c", "d") })],
		["c", "d"],
	);
});

/** A commit sheet stub: its `hidden` flag and how many children it still holds. */
function fakeDetail() {
	const detail = {
		children: 3,
		hidden: true,
		replaceChildren() {
			detail.children = 0;
		},
	};
	return detail;
}

test("createDetailClearer keeps the sheet's content until its exit has finished", async () => {
	const detail = fakeDetail();
	createDetailClearer(detail, () => false, 20).schedule();
	assertEquals(detail.children, 3);
	await Bun.sleep(40);
	assertEquals(detail.children, 0);
});

test("createDetailClearer leaves a sheet that was reopened before the timer fired", async () => {
	const detail = fakeDetail();
	let open = false;
	const clearer = createDetailClearer(detail, () => open, 20);
	clearer.schedule();
	open = true;
	detail.hidden = false;
	clearer.cancel();
	await Bun.sleep(40);
	assertEquals(detail.children, 3);
});

test("createDetailClearer: close, reopen, close keeps the content until the last exit ends", async () => {
	const detail = fakeDetail();
	let open = true;
	const clearer = createDetailClearer(detail, () => open, 100);
	const close = () => {
		open = false;
		detail.hidden = true;
		clearer.schedule();
	};
	close(); // t0: first slide-out, its clear due at ~100ms
	await Bun.sleep(20);
	open = true; // reopen mid-exit
	detail.hidden = false;
	clearer.cancel();
	await Bun.sleep(20);
	close(); // ~40ms: second slide-out, its clear due at ~140ms
	await Bun.sleep(80); // ~120ms: past the first close's deadline, inside the second exit
	assertEquals(detail.children, 3);
	await Bun.sleep(80); // ~200ms: the second exit has finished
	assertEquals(detail.children, 0);
});

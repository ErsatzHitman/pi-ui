import { afterEach, jest, test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	type GitGraphRow,
	unloadedWorkspaceGitGraphSnapshot,
} from "../workspace-git-graph-types.ts";
import {
	createDetailClearer,
	detailOpenCapMs,
	newCommitHashes,
	openDetailWhenLoaded,
} from "./workspace-git-graph.ts";

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

/** A closed commit sheet stub and the log of what its opener did to it, in order. */
function fakeSheet() {
	const log: string[] = [];
	const sheet = { hidden: true, style: { minBlockSize: "" } };
	return { log, sheet };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Drains pending microtasks (promise continuations) under fake timers. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function opener(
	sheet: ReturnType<typeof fakeSheet>,
	load: Promise<string>,
	current = () => true,
) {
	return openDetailWhenLoaded({
		capMs: detailOpenCapMs,
		detail: sheet.sheet,
		fadeIn: () => sheet.log.push(`fade hidden=${sheet.sheet.hidden}`),
		heldHeight: 212,
		isCurrent: current,
		load,
		render: (value) =>
			sheet.log.push(
				`render ${value} hidden=${sheet.sheet.hidden} min=${sheet.sheet.style.minBlockSize}`,
			),
		showLoading: () => sheet.log.push(`loading hidden=${sheet.sheet.hidden}`),
	});
}

afterEach(() => {
	jest.useRealTimers();
});

test("openDetailWhenLoaded: a detail inside the cap renders before the sheet opens", async () => {
	jest.useFakeTimers();
	const sheet = fakeSheet();
	const load = deferred<string>();
	const done = opener(sheet, load.promise);
	jest.advanceTimersByTime(detailOpenCapMs - 50);
	await flush();
	assertEquals(sheet.sheet.hidden, true); // not opened before its content arrives
	load.resolve("abc");
	await done;
	assertEquals(sheet.log, ["render abc hidden=true min="]);
	assertEquals(sheet.sheet.hidden, false);
	assertEquals(sheet.sheet.style.minBlockSize, "");
});

test("openDetailWhenLoaded: a cap miss opens at the held height, then fades the late body in", async () => {
	jest.useFakeTimers();
	const sheet = fakeSheet();
	const load = deferred<string>();
	const done = opener(sheet, load.promise);
	jest.advanceTimersByTime(detailOpenCapMs - 1);
	await flush();
	assertEquals(sheet.sheet.hidden, true);
	jest.advanceTimersByTime(1);
	await flush();
	assertEquals(sheet.log, ["loading hidden=true"]);
	assertEquals(sheet.sheet.hidden, false);
	assertEquals(sheet.sheet.style.minBlockSize, "min(212px, 60%)");
	load.resolve("abc");
	await done;
	assertEquals(sheet.log, [
		"loading hidden=true",
		"render abc hidden=false min=min(212px, 60%)",
		"fade hidden=false",
	]);
	assertEquals(sheet.sheet.style.minBlockSize, "");
});

test("openDetailWhenLoaded: a close or newer selection during the wait never opens the sheet", async () => {
	jest.useFakeTimers();
	const sheet = fakeSheet();
	const load = deferred<string>();
	let current = true;
	const done = opener(sheet, load.promise, () => current);
	current = false;
	load.resolve("abc");
	await done;
	assertEquals(sheet.log, []);
	assertEquals(sheet.sheet.hidden, true);
});

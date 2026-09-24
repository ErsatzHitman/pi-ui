import { test } from "bun:test";

import { assertEquals, assertFalse } from "#testing/assertions";

import type { ExtensionActivity } from "../extension-activity-types.ts";
import {
	decodeActivityEntry,
	encodeActivityEntry,
	isPersistable,
	rebuildActivitiesFromEntries,
} from "./persistence.ts";

function activity(overrides: Partial<ExtensionActivity> = {}): ExtensionActivity {
	return {
		v: 1,
		id: "xa-1",
		extension: { id: "jev", label: "JEV", path: "/x", source: "local" },
		trigger: { kind: "hook", event: "before_agent_start" },
		title: "Consult",
		state: "working",
		startedAt: 0,
		output: [],
		...overrides,
	};
}

test("isPersistable is false only for the invisible started state", () => {
	assertFalse(isPersistable(activity({ state: "started" })));
	assertEquals(isPersistable(activity({ state: "working" })), true);
	assertEquals(isPersistable(activity({ state: "done" })), true);
	assertEquals(isPersistable(activity({ state: "error" })), true);
	assertEquals(isPersistable(activity({ state: "cancelled" })), true);
});

test("encode/decode round-trips", () => {
	const entry = encodeActivityEntry("start", activity());
	assertEquals(entry, { v: 1, phase: "start", activity: activity() });
	assertEquals(decodeActivityEntry(entry), true);
});

test("decodeActivityEntry rejects an unknown schema version and junk payloads", () => {
	assertFalse(decodeActivityEntry({ v: 2, phase: "start", activity: activity() }));
	assertFalse(decodeActivityEntry({ not: "an entry" }));
	assertFalse(decodeActivityEntry(null));
	assertFalse(decodeActivityEntry("junk"));
});

test("rebuildActivitiesFromEntries merges start+finish by id, last phase wins", () => {
	const started = activity({ state: "working" });
	const finished = activity({
		state: "done",
		finishedAt: 100,
		summary: "Consulted jev",
	});
	const rebuilt = rebuildActivitiesFromEntries([
		encodeActivityEntry("start", started),
		encodeActivityEntry("finish", finished),
	]);
	assertEquals(rebuilt.length, 1);
	assertEquals(rebuilt[0]!.activity, finished);
	assertEquals(rebuilt[0]!.firstSeenIndex, 0);
});

test("a start-only activity (pi-ui exited mid-run) is reported cancelled and interrupted", () => {
	const started = activity({ state: "working", workingAt: 10 });
	const rebuilt = rebuildActivitiesFromEntries([encodeActivityEntry("start", started)]);
	assertEquals(rebuilt.length, 1);
	assertEquals(rebuilt[0]!.activity.state, "cancelled");
	assertEquals(rebuilt[0]!.activity.summary, "Interrupted (pi-ui stopped)");
	assertEquals(rebuilt[0]!.activity.finishedAt, 0);
});

test("a re-written finish (after a late panel refresh) replaces the earlier one", () => {
	const first = activity({ state: "done", finishedAt: 100, summary: "first" });
	const refreshed = activity({ state: "done", finishedAt: 100, summary: "second" });
	const rebuilt = rebuildActivitiesFromEntries([
		encodeActivityEntry("start", activity({ state: "working" })),
		encodeActivityEntry("finish", first),
		encodeActivityEntry("finish", refreshed),
	]);
	assertEquals(rebuilt[0]!.activity.summary, "second");
});

test("standalone activities are ordered by the index of their first entry", () => {
	const first = activity({ id: "xa-1" });
	const second = activity({ id: "xa-2" });
	const rebuilt = rebuildActivitiesFromEntries([
		encodeActivityEntry("start", second),
		encodeActivityEntry("start", first),
	]);
	assertEquals(
		rebuilt.map((r) => r.activity.id),
		["xa-2", "xa-1"],
	);
});

test("non-activity entries in the stream are skipped without disturbing indices", () => {
	const rebuilt = rebuildActivitiesFromEntries([
		{ customType: "something-else", data: {} },
		encodeActivityEntry("start", activity()),
		"not even an object",
	]);
	assertEquals(rebuilt.length, 1);
	assertEquals(rebuilt[0]!.firstSeenIndex, 1);
});

test("an already-terminal activity that only saw a start entry is left as-is", () => {
	const cancelled = activity({ state: "cancelled", finishedAt: 5, summary: "Stopped" });
	const rebuilt = rebuildActivitiesFromEntries([
		encodeActivityEntry("start", cancelled),
	]);
	assertEquals(rebuilt[0]!.activity, cancelled);
});

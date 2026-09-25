import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import type { ExtensionActivity } from "../extension-activity-types.ts";
import {
	activityMessageState,
	activityMessageText,
	formatActivityDuration,
	formatExtensionActivityLogLine,
	mergeActivitySteps,
	toExtensionActivityView,
	triggerMeta,
} from "./view.ts";

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

test("formatActivityDuration is undefined until finishedAt is set", () => {
	assertEquals(formatActivityDuration(activity()), undefined);
});

test("formatActivityDuration renders sub-second durations like tool cards", () => {
	assertEquals(
		formatActivityDuration(activity({ startedAt: 0, finishedAt: 340 })),
		"0.3s",
	);
});

test("formatActivityDuration renders second-plus durations with one decimal", () => {
	assertEquals(
		formatActivityDuration(activity({ startedAt: 0, finishedAt: 1500 })),
		"1.5s",
	);
});

test("formatActivityDuration switches to minutes past one minute, like tool cards", () => {
	assertEquals(
		formatActivityDuration(activity({ startedAt: 0, finishedAt: 75_000 })),
		"1m 15s",
	);
});

test("formatActivityDuration measures from startedAt (Called), not the later workingAt", () => {
	assertEquals(
		formatActivityDuration(
			activity({ startedAt: 0, workingAt: 750, finishedAt: 1200 }),
		),
		"1.2s",
	);
});

test("toExtensionActivityView adds durationText only once finished", () => {
	const unfinished = activity();
	assertEquals(toExtensionActivityView(unfinished), unfinished);
	const finished = activity({ startedAt: 0, finishedAt: 250 });
	assertEquals(toExtensionActivityView(finished), {
		...finished,
		durationText: "0.3s",
	});
});

test("activityMessageText prefers summary, then progress, then title", () => {
	assertEquals(activityMessageText(activity()), "Consult");
	assertEquals(activityMessageText(activity({ progress: "loading" })), "loading");
	assertEquals(
		activityMessageText(activity({ progress: "loading", summary: "done" })),
		"done",
	);
});

test("mergeActivitySteps appends a new step and keeps prior steps in order", () => {
	const step1 = toExtensionActivityView(activity({ id: "xa-1" }));
	const step2 = toExtensionActivityView(activity({ id: "xa-2" }));
	assertEquals(mergeActivitySteps(undefined, step1), [step1]);
	assertEquals(mergeActivitySteps([step1], step2), [step1, step2]);
});

test("mergeActivitySteps patches an existing step by id in place instead of duplicating it", () => {
	const started = toExtensionActivityView(activity({ id: "xa-1", state: "working" }));
	const finished = toExtensionActivityView(
		activity({ id: "xa-1", state: "done", workingAt: 0, finishedAt: 100 }),
	);
	const other = toExtensionActivityView(activity({ id: "xa-2" }));
	assertEquals(mergeActivitySteps([started, other], finished), [finished, other]);
});

test("activityMessageState maps error/cancelled to error, started/working to running, done to success", () => {
	assertEquals(activityMessageState(activity({ state: "started" })), "running");
	assertEquals(activityMessageState(activity({ state: "working" })), "running");
	assertEquals(activityMessageState(activity({ state: "done" })), "success");
	assertEquals(activityMessageState(activity({ state: "error" })), "error");
	assertEquals(activityMessageState(activity({ state: "cancelled" })), "error");
});

test("formatActivityDuration hides a 0.0s duration, exactly like tool cards do", () => {
	assertEquals(
		formatActivityDuration(activity({ startedAt: 0, finishedAt: 20 })),
		undefined,
	);
});

test("triggerMeta reads the one distinguishing field of each trigger kind", () => {
	assertEquals(
		triggerMeta({ kind: "hook", event: "before_agent_start" }),
		"before_agent_start",
	);
	assertEquals(
		triggerMeta({ kind: "tool", toolName: "jev_decompose" }),
		"jev_decompose",
	);
	assertEquals(triggerMeta({ kind: "command", name: "advisor" }), "advisor");
	assertEquals(triggerMeta({ kind: "shortcut", key: "ctrl+j" }), "ctrl+j");
	assertEquals(
		triggerMeta({ kind: "ui", signal: "status", key: "fake-vision" }),
		"fake-vision",
	);
});

test("formatExtensionActivityLogLine: a start line has no duration or summary", () => {
	assertEquals(
		formatExtensionActivityLogLine("start", activity({ state: "working" })),
		"JEV started Consult · before_agent_start",
	);
});

test("formatExtensionActivityLogLine: a finish line adds duration and summary when present", () => {
	const finished = activity({
		state: "done",
		startedAt: 0,
		finishedAt: 2100,
		summary: "Consulted jev",
	});
	assertEquals(
		formatExtensionActivityLogLine("finish", finished),
		"JEV finished Consult · before_agent_start (2.1s) — Consulted jev",
	);
});

test("formatExtensionActivityLogLine: a finish line with no duration or summary yet omits the trailing parenthetical", () => {
	assertEquals(
		formatExtensionActivityLogLine("finish", activity({ state: "working" })),
		"JEV finished Consult · before_agent_start",
	);
});

test("formatExtensionActivityLogLine: a finish line with a summary but a hidden (0.0s) duration only shows the summary", () => {
	const finished = activity({
		state: "done",
		startedAt: 0,
		finishedAt: 20,
		summary: "Consulted jev",
	});
	assertEquals(
		formatExtensionActivityLogLine("finish", finished),
		"JEV finished Consult · before_agent_start — Consulted jev",
	);
});

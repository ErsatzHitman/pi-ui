import { test } from "bun:test";

import { assertEquals, assertFalse } from "#testing/assertions";

import {
	extensionActivityEntryType,
	extensionActivitySchemaVersion,
	extensionActivityTriggerLabel,
	isExtensionActivityEntryData,
	isExtensionActivityState,
	isTerminalExtensionActivityState,
} from "./extension-activity-types.ts";

test("the CustomEntry type and schema version are the frozen contract values", () => {
	assertEquals(extensionActivityEntryType, "pi-ui.extension-activity");
	assertEquals(extensionActivitySchemaVersion, 1);
});

test("isExtensionActivityState accepts only the five lifecycle states", () => {
	for (const state of ["started", "working", "done", "error", "cancelled"]) {
		assertEquals(isExtensionActivityState(state), true);
	}
	for (const notState of ["running", "", undefined, null, 5]) {
		assertFalse(isExtensionActivityState(notState));
	}
});

test("isTerminalExtensionActivityState is true only for done/error/cancelled", () => {
	assertFalse(isTerminalExtensionActivityState("started"));
	assertFalse(isTerminalExtensionActivityState("working"));
	assertEquals(isTerminalExtensionActivityState("done"), true);
	assertEquals(isTerminalExtensionActivityState("error"), true);
	assertEquals(isTerminalExtensionActivityState("cancelled"), true);
});

test("extensionActivityTriggerLabel formats each trigger kind", () => {
	assertEquals(
		extensionActivityTriggerLabel({ kind: "hook", event: "before_agent_start" }),
		"before_agent_start",
	);
	assertEquals(
		extensionActivityTriggerLabel({ kind: "tool", toolName: "jev_decompose" }),
		"jev_decompose",
	);
	assertEquals(
		extensionActivityTriggerLabel({ kind: "command", name: "handoff" }),
		"/handoff",
	);
	assertEquals(
		extensionActivityTriggerLabel({ kind: "shortcut", key: "ctrl+j" }),
		"ctrl+j",
	);
	assertEquals(
		extensionActivityTriggerLabel({
			kind: "ui",
			signal: "widget",
			key: "jev-decompose",
		}),
		"widget:jev-decompose",
	);
});

test("isExtensionActivityEntryData validates shape and rejects unknown versions", () => {
	const activity = {
		v: 1 as const,
		id: "xa-1",
		extension: { id: "jev", label: "JEV", path: "/x", source: "local" },
		trigger: { kind: "hook" as const, event: "before_agent_start" },
		title: "Consult",
		state: "working" as const,
		startedAt: 0,
		output: [],
	};
	assertEquals(isExtensionActivityEntryData({ v: 1, phase: "start", activity }), true);
	assertEquals(isExtensionActivityEntryData({ v: 1, phase: "finish", activity }), true);
	assertFalse(isExtensionActivityEntryData({ v: 2, phase: "start", activity }));
	assertFalse(isExtensionActivityEntryData({ v: 1, phase: "middle", activity }));
	assertFalse(isExtensionActivityEntryData({ v: 1, phase: "start" }));
	assertFalse(isExtensionActivityEntryData(null));
	assertFalse(isExtensionActivityEntryData("not an object"));
});

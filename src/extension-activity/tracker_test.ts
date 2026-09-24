import { test } from "bun:test";

import { assertEquals, assertExists } from "#testing/assertions";

import type { ExtensionRef } from "../extension-activity-types.ts";
import type { InstrumentedScope, ScopeOutcomeRaw } from "./instrument.ts";
import type { LedgerChange } from "./ledger.ts";
import { ExtensionActivityTracker, type Scheduler } from "./tracker.ts";

const ref: ExtensionRef = {
	id: "probe",
	label: "Probe",
	path: "/probe.ts",
	source: "local",
};

type FakeTimer = { delayMs: number; run: () => void; cancelled: boolean };
type FakeSchedulerHandle = Readonly<{ scheduler: Scheduler; timers: FakeTimer[] }>;

function fakeScheduler(): FakeSchedulerHandle {
	const timers: FakeTimer[] = [];
	return {
		timers,
		scheduler: {
			schedule(delayMs, run) {
				const timer: FakeTimer = { delayMs, run, cancelled: false };
				timers.push(timer);
				return () => {
					timer.cancelled = true;
				};
			},
		},
	};
}

type SinkRecorderHandle = Readonly<{
	sink: (change: LedgerChange) => void;
	changes: LedgerChange[];
}>;

function sinkRecorder(): SinkRecorderHandle {
	const changes: LedgerChange[] = [];
	return { changes, sink: (change) => changes.push(change) };
}

function hookScope(overrides: Partial<InstrumentedScope> = {}): InstrumentedScope {
	return {
		scopeId: "hook:1",
		timed: true,
		extension: ref,
		trigger: { kind: "hook", event: "before_agent_start" },
		title: "before_agent_start",
		...overrides,
	};
}

function carrierScope(overrides: Partial<InstrumentedScope> = {}): InstrumentedScope {
	return {
		scopeId: "carrier:probe:message_start",
		timed: false,
		extension: ref,
		trigger: { kind: "hook", event: "message_start" },
		title: "message_start",
		...overrides,
	};
}

test("a timed scope schedules one promotion timer at scopeStart and cancels it at scopeEnd", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(hookScope(), 0);
	assertEquals(timers.length, 1);
	assertEquals(timers[0]?.delayMs, 750);
	assertEquals(timers[0]?.cancelled, false);

	tracker.scopeEnd(hookScope(), 5, { ok: true, result: undefined });
	assertEquals(timers[0]?.cancelled, true);
});

test("firing the promotion timer promotes the scope to working, and scopeEnd finishes it", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 100 });

	tracker.scopeStart(hookScope(), 0);
	timers[0]?.run();
	assertEquals(changes.length, 1);
	assertEquals(changes[0]?.kind, "created");

	tracker.scopeEnd(hookScope(), 200, {
		ok: true,
		result: { message: { content: "hi" } },
	});
	assertEquals(changes.length, 2);
	const finished = changes[1];
	assertExists(finished);
	assertEquals(finished.kind, "finished");
	if (finished.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.summary, "hi");
	assertEquals(finished.activity.output, [
		{ kind: "returned-message", title: "Sent to model", text: "hi" },
	]);
});

test("a before_agent_start hook returning display:false is captured as a hidden output section", () => {
	// Vision Proxy (and JEV's jev-decompose) return their message with
	// `display: false` — invisible in terminal pi — so the activity card is
	// the only place it's ever shown; per DESIGN-ext-activity.md's Vision
	// Proxy row it must be marked `hidden: true`, not dropped or shown as if
	// it were a normal, terminal-visible message.
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 100 });

	tracker.scopeStart(hookScope(), 0);
	timers[0]?.run();
	tracker.scopeEnd(hookScope(), 200, {
		ok: true,
		result: { message: { content: "A red square.", display: false } },
	});

	const finished = changes[1];
	assertExists(finished);
	if (finished.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.output, [
		{
			kind: "returned-message",
			title: "Sent to model · hidden in terminal",
			text: "A red square.",
			hidden: true,
		},
	]);
});

test("a before_agent_start hook returning no display field (or display:true) stays unhidden", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 100 });

	tracker.scopeStart(hookScope(), 0);
	timers[0]?.run();
	tracker.scopeEnd(hookScope(), 200, {
		ok: true,
		result: { message: { content: "hi", display: true } },
	});

	const finished = changes[1];
	assertExists(finished);
	if (finished.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.output, [
		{ kind: "returned-message", title: "Sent to model", text: "hi" },
	]);
});

test("a scope that ends below threshold with no signal is dropped, not finished", () => {
	const { scheduler } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(hookScope(), 0);
	tracker.scopeEnd(hookScope(), 5, { ok: true, result: undefined });
	assertEquals(changes.length, 1);
	assertEquals(changes[0]?.kind, "dropped");
});

test("a thrown/rejected scope outcome maps to a failed activity with the error message", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(hookScope(), 0);
	timers[0]?.run();
	tracker.scopeEnd(hookScope(), 10, { ok: false, error: new Error("boom") });

	const finished = changes.at(-1);
	assertExists(finished);
	if (finished?.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.state, "error");
	assertEquals(finished.activity.error, "boom");
});

test("a carrier ui signal starts a pending activity and promotes via the faster ui threshold", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 50 });

	tracker.setRunActive(true, 0);
	tracker.uiSignal(
		carrierScope(),
		{ kind: "status", key: "panel", text: "loading" },
		0,
	);
	assertEquals(changes[0]?.kind, "pending");
	assertEquals(timers.length, 1);
	assertEquals(timers[0]?.delayMs, 250);

	timers[0]?.run();
	assertEquals(changes[1]?.kind, "created");
});

test("a carrier ui signal is ignored while no run is active", () => {
	const { scheduler } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.uiSignal(
		carrierScope(),
		{ kind: "status", key: "panel", text: "loading" },
		0,
	);
	assertEquals(changes.length, 0);
});

test("observeChannel derives running text from subagents:fleet and closes when entries empty", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.setRunActive(true, 0);
	tracker.observeChannel("subagents:fleet", { entries: [{ state: "running" }] }, 0);
	const pending = changes[0];
	assertExists(pending);
	if (pending?.kind !== "pending") throw new Error("expected pending");
	assertEquals(pending.activity.progress, "1 subagent running");

	timers[0]?.run();
	tracker.observeChannel("subagents:fleet", { entries: [] }, 10);
	const finished = changes.at(-1);
	assertExists(finished);
	assertEquals(finished?.kind, "finished");
});

test("observeChannel derives a name:phase label from workflow:progress and honours active:false", () => {
	const { scheduler } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.setRunActive(true, 0);
	tracker.observeChannel("workflow:progress", { name: "Plan", phase: "running" }, 0);
	const pending = changes[0];
	assertExists(pending);
	if (pending?.kind !== "pending") throw new Error("expected pending");
	assertEquals(pending.activity.progress, "Plan: running");

	tracker.observeChannel("workflow:progress", { active: false }, 10);
	assertEquals(changes.at(-1)?.kind, "dropped");
});

test("observeChannel ignores an unrecognized channel", () => {
	const { scheduler } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
	tracker.setRunActive(true, 0);
	tracker.observeChannel("some-other-channel", { entries: [{}] }, 0);
	assertEquals(changes.length, 0);
});

test("observeCustomMessage attaches to the extension's open activity", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(hookScope(), 0);
	timers[0]?.run();
	tracker.observeCustomMessage(ref, "hello from probe", false, 5);

	const updated = changes.at(-1);
	assertExists(updated);
	if (updated?.kind !== "updated") throw new Error("expected updated");
	assertEquals(updated.activity.output.at(-1), {
		kind: "custom-message",
		title: "Posted below",
		text: "hello from probe",
		hidden: false,
	});
});

test("selfHeal finalizes a long-standing carrier activity once it outlives the settle window", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.setRunActive(true, 0);
	tracker.uiSignal(
		carrierScope(),
		{ kind: "status", key: "panel", text: "loading" },
		0,
	);
	timers[0]?.run();

	tracker.selfHeal(70_000, 0);
	const finished = changes.at(-1);
	assertExists(finished);
	assertEquals(finished?.kind, "finished");
});

test("cancelAll cancels pending timers and finalizes/drops every open activity", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(hookScope({ scopeId: "hook:promoted" }), 0);
	timers[0]?.run();
	tracker.scopeStart(hookScope({ scopeId: "hook:never-promoted" }), 0);
	assertEquals(timers[1]?.cancelled, false);

	tracker.cancelAll(100, "runtime disposed");
	assertEquals(timers[1]?.cancelled, true);
	const kinds = changes.map((change) => change.kind);
	assertEquals(kinds.includes("finished"), true);
	assertEquals(kinds.includes("dropped"), true);
});

test("dispose cancels every pending timer without touching ledger state", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(hookScope(), 0);
	assertEquals(timers[0]?.cancelled, false);
	tracker.dispose();
	assertEquals(timers[0]?.cancelled, true);
});

test("a tool scope's outcome maps content to a summary/output section, and isError to a failed activity", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
	const toolScope = hookScope({
		trigger: { kind: "tool", toolName: "probe_tool", toolCallId: "c1" },
	});

	tracker.scopeStart(toolScope, 0);
	timers[0]?.run();
	tracker.scopeEnd(toolScope, 10, {
		ok: true,
		result: { content: [{ type: "text", text: "42" }] },
	});
	const finished = changes.at(-1);
	assertExists(finished);
	if (finished?.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.summary, "42");

	const errorScope = hookScope({
		scopeId: "hook:err",
		trigger: { kind: "tool", toolName: "probe_tool", toolCallId: "c2" },
	});
	tracker.scopeStart(errorScope, 20);
	timers[1]?.run();
	tracker.scopeEnd(errorScope, 30, {
		ok: true,
		result: { isError: true, content: [{ type: "text", text: "nope" }] },
	});
	const errored = changes.at(-1);
	assertExists(errored);
	if (errored?.kind !== "finished") throw new Error("expected finished");
	assertEquals(errored.activity.state, "error");
	assertEquals(errored.activity.error, "nope");
});

test("tool_call/tool_result/input/context hook outcomes map to their §2.3 output kinds", () => {
	const cases: readonly [InstrumentedScope["trigger"], ScopeOutcomeRaw, string][] = [
		[
			{ kind: "hook", event: "context" },
			{ ok: true, result: { messages: [1, 2, 3] } },
			"injected-messages",
		],
		[
			{ kind: "hook", event: "tool_call" },
			{ ok: true, result: { block: true, reason: "not allowed" } },
			"blocked",
		],
		[
			{ kind: "hook", event: "tool_result" },
			{ ok: true, result: { content: [{ type: "text", text: "patched" }] } },
			"tool-content",
		],
		[
			{ kind: "hook", event: "input" },
			{ ok: true, result: { action: "transform", text: "rewritten" } },
			"injected-messages",
		],
	];

	for (const [trigger, outcome, expectedKind] of cases) {
		const { scheduler, timers } = fakeScheduler();
		const { sink, changes } = sinkRecorder();
		const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
		const scope = hookScope({ trigger });
		tracker.scopeStart(scope, 0);
		timers[0]?.run();
		tracker.scopeEnd(scope, 10, outcome);
		const finished = changes.at(-1);
		assertExists(finished);
		if (finished?.kind !== "finished") throw new Error("expected finished");
		assertEquals(finished.activity.output[0]?.kind, expectedKind);
	}
});

test("a generic timed hook with no specific mapping still finishes with a bare outcome", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
	const scope = hookScope({ trigger: { kind: "hook", event: "agent_end" } });

	tracker.scopeStart(scope, 0);
	timers[0]?.run();
	tracker.scopeEnd(scope, 10, { ok: true, result: { messages: [] } });
	const finished = changes.at(-1);
	assertExists(finished);
	if (finished?.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.state, "done");
	assertEquals(finished.activity.output, []);
});

test("a non-timed carrier scope is never promoted or finished via scopeStart/scopeEnd alone", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(carrierScope(), 0);
	tracker.scopeEnd(carrierScope(), 10, { ok: true, result: undefined });
	assertEquals(timers.length, 0);
	assertEquals(changes.length, 0);
});

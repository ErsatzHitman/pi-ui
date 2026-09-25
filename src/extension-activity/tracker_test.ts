import { test } from "bun:test";

import { assertEquals, assertExists } from "#testing/assertions";

import type { ExtensionRef } from "../extension-activity-types.ts";
import type { InstrumentedScope, ScopeOutcomeRaw } from "./instrument.ts";
import type { LedgerChange } from "./ledger.ts";
import { extensionActivityThresholds } from "./policy.ts";
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

test("a before_agent_start hook that returns the exact systemPrompt it was given is a no-op — filtered, not shown as Replaced", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 100 });

	tracker.scopeStart(
		hookScope({ hookEvent: { type: "before_agent_start", systemPrompt: "BASE" } }),
		0,
	);
	timers[0]?.run();
	tracker.scopeEnd(
		hookScope({ hookEvent: { type: "before_agent_start", systemPrompt: "BASE" } }),
		200,
		{ ok: true, result: { systemPrompt: "BASE" } },
	);

	const finished = changes[1];
	assertExists(finished);
	if (finished.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.output, []);
	assertEquals(finished.activity.summary, undefined);
});

test("a before_agent_start hook that appends to the system prompt reports only the appended suffix", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 100 });

	tracker.scopeStart(
		hookScope({ hookEvent: { type: "before_agent_start", systemPrompt: "BASE" } }),
		0,
	);
	timers[0]?.run();
	tracker.scopeEnd(
		hookScope({ hookEvent: { type: "before_agent_start", systemPrompt: "BASE" } }),
		200,
		{ ok: true, result: { systemPrompt: "BASE\n\nExtra section" } },
	);

	const finished = changes[1];
	assertExists(finished);
	if (finished.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.output, [
		{
			kind: "system-prompt",
			title: "Appended to system prompt",
			text: "\n\nExtra section",
		},
	]);
	assertEquals(finished.activity.summary, "Appended to system prompt");
});

test("a before_agent_start hook that replaces the system prompt with something unrelated reports the full replacement", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 100 });

	tracker.scopeStart(
		hookScope({ hookEvent: { type: "before_agent_start", systemPrompt: "BASE" } }),
		0,
	);
	timers[0]?.run();
	tracker.scopeEnd(
		hookScope({ hookEvent: { type: "before_agent_start", systemPrompt: "BASE" } }),
		200,
		{ ok: true, result: { systemPrompt: "TOTALLY DIFFERENT" } },
	);

	const finished = changes[1];
	assertExists(finished);
	if (finished.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.output, [
		{
			kind: "system-prompt",
			title: "Replaced system prompt",
			text: "TOTALLY DIFFERENT",
		},
	]);
});

test("a context hook that returns the same messages it was given is a no-op — filtered, not shown as Replaced context", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 100 });
	const messages = [{ role: "user", content: "hi" }];

	tracker.scopeStart(
		hookScope({
			trigger: { kind: "hook", event: "context" },
			title: "context",
			hookEvent: { type: "context", messages },
		}),
		0,
	);
	timers[0]?.run();
	tracker.scopeEnd(
		hookScope({
			trigger: { kind: "hook", event: "context" },
			title: "context",
			hookEvent: { type: "context", messages },
		}),
		200,
		{ ok: true, result: { messages: [{ role: "user", content: "hi" }] } },
	);

	const finished = changes[1];
	assertExists(finished);
	if (finished.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.output, []);
	assertEquals(finished.activity.summary, undefined);
});

test("a context hook that changes the messages reports the replacement, per the input/output diff", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 100 });
	const messages = [{ role: "user", content: "hi" }];

	tracker.scopeStart(
		hookScope({
			trigger: { kind: "hook", event: "context" },
			title: "context",
			hookEvent: { type: "context", messages },
		}),
		0,
	);
	timers[0]?.run();
	tracker.scopeEnd(
		hookScope({
			trigger: { kind: "hook", event: "context" },
			title: "context",
			hookEvent: { type: "context", messages },
		}),
		200,
		{
			ok: true,
			result: {
				messages: [
					{ role: "user", content: "hi" },
					{ role: "system", content: "injected" },
				],
			},
		},
	);

	const finished = changes[1];
	assertExists(finished);
	if (finished.kind !== "finished") throw new Error("expected finished");
	assertEquals(finished.activity.summary, "Replaced context (2 messages)");
	assertEquals(finished.activity.output, [
		{ kind: "injected-messages", title: "Replaced context", text: "2 messages" },
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
	// The tool card right above already shows the result; the step never copies
	// it (no duplicate summary line, no second copy in the session file).
	assertEquals(finished.activity.summary, undefined);
	assertEquals(finished.activity.output, []);

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

test("the run stays active for runGraceMs after it settles, then carrier signals become standing", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.setRunActive(true, 0);
	tracker.setRunActive(false, 0);
	const grace = timers.find((timer) => timer.delayMs === 10_000);
	assertExists(grace);

	// Within the grace window a carrier signal still opens a run-scoped activity.
	tracker.uiSignal(carrierScope(), { kind: "status", key: "wrap", text: "saving" }, 0);
	assertEquals(changes.at(-1)?.kind, "pending");

	grace.run();
	const before = changes.length;
	tracker.uiSignal(carrierScope(), { kind: "status", key: "later", text: "idle" }, 0);
	assertEquals(changes.length, before);
});

test("settling the run schedules self-heal so a never-cleared run-scoped activity finishes", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	let clock = 0;
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => clock });

	tracker.setRunActive(true, 0);
	tracker.uiSignal(
		carrierScope(),
		{ kind: "status", key: "panel", text: "loading" },
		0,
	);
	timers.find((timer) => timer.delayMs === 250)?.run();
	assertEquals(changes.at(-1)?.kind, "created");

	tracker.setRunActive(false, 1_000);
	const selfHeal = timers.find((timer) => timer.delayMs === 60_000);
	assertExists(selfHeal);
	clock = 61_000;
	selfHeal.run();
	assertEquals(changes.at(-1)?.kind, "finished");
});

test("a new run cancels the previous run's pending grace and self-heal timers", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.setRunActive(false, 0);
	tracker.setRunActive(true, 5);
	assertEquals(
		timers.every((timer) => timer.cancelled),
		true,
	);
});

test("boundSignals tracks the status keys and working message a timed scope's activity holds", () => {
	const { scheduler } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(hookScope(), 0);
	tracker.uiSignal(
		hookScope(),
		{ kind: "status", key: "lsp", text: "pyright checking" },
		0,
	);
	tracker.uiSignal(hookScope(), { kind: "workingMessage", text: "checking" }, 0);
	const pending = changes.at(-1);
	assertExists(pending);
	assertEquals(pending.kind, "pending");
	const id = pending.kind === "pending" ? pending.activity.id : "";
	assertEquals(tracker.boundSignals(id), { statusKeys: ["lsp"], working: true });

	tracker.uiSignal(hookScope(), { kind: "status", key: "lsp", text: undefined }, 0);
	tracker.uiSignal(hookScope(), { kind: "workingMessage", text: undefined }, 0);
	assertEquals(tracker.boundSignals(id), { statusKeys: [], working: false });
});

test("boundSignals forgets an activity once it finishes", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });

	tracker.scopeStart(hookScope(), 0);
	tracker.uiSignal(hookScope(), { kind: "status", key: "lsp", text: "checking" }, 0);
	timers[0]?.run();
	const created = changes.at(-1);
	assertExists(created);
	const id = created.kind === "created" ? created.activity.id : "";
	assertEquals(tracker.boundSignals(id).statusKeys, ["lsp"]);

	tracker.scopeEnd(hookScope(), 900, { ok: true, result: undefined });
	assertEquals(changes.at(-1)?.kind, "finished");
	assertEquals(tracker.boundSignals(id), { statusKeys: [], working: false });
});

test("a tool_result hook that echoes its input content back unchanged is a no-op, while a rewrite is reported", () => {
	const content = [{ type: "text", text: "raw image bytes" }];
	const scope = hookScope({
		trigger: { kind: "hook", event: "tool_result" },
		title: "tool_result",
		hookEvent: { type: "tool_result", content },
	});
	const run = (result: { content: { type: string; text: string }[] }) => {
		const { scheduler, timers } = fakeScheduler();
		const { sink, changes } = sinkRecorder();
		const tracker = new ExtensionActivityTracker({
			sink,
			scheduler,
			clock: () => 100,
		});
		tracker.scopeStart(scope, 0);
		timers[0]?.run();
		tracker.scopeEnd(scope, 900, { ok: true, result });
		const finished = changes.at(-1);
		if (finished?.kind !== "finished") throw new Error("expected finished");
		return finished.activity;
	};

	const echoed = run({ content: [{ type: "text", text: "raw image bytes" }] });
	assertEquals(echoed.summary, undefined);
	assertEquals(echoed.output, []);

	const rewritten = run({ content: [{ type: "text", text: "A red square." }] });
	assertEquals(rewritten.summary, "Modified tool result");
});

test("a factory widget's rendered frames are coalesced into progress and kept as its final frame", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 50 });
	const toolScope = hookScope({
		scopeId: "tool:jev",
		trigger: { kind: "tool", toolName: "jev_decompose", toolCallId: "c1" },
		title: "jev_decompose",
		toolCallId: "c1",
	});
	tracker.scopeStart(toolScope, 0);
	const promotion = timers[0];
	assertExists(promotion);
	promotion.run();

	// A `(tui, theme) => Component` factory: nothing to read from the call itself.
	tracker.uiSignal(toolScope, { kind: "widgetMount", key: "jev-decompose" }, 1);
	assertEquals(tracker.ownsWidget("jev-decompose"), true);
	assertEquals(tracker.ownsWidget("someone-else"), false);
	const before = changes.length;

	// Three frames inside one coalescing window -> one scheduled flush, latest wins.
	tracker.observeWidgetFrame("jev-decompose", "Jev\nconsulting jev (1)", 10);
	tracker.observeWidgetFrame("jev-decompose", "Jev\nconsulting jev (2)", 20);
	tracker.observeWidgetFrame("jev-decompose", "Jev\nconsulting jev (3)", 30);
	const frameTimers = timers.filter((timer) => timer.delayMs === 100);
	assertEquals(frameTimers.length, 1);
	assertEquals(changes.length, before);
	frameTimers[0]?.run();
	const flushed = changes.at(-1);
	if (flushed?.kind !== "updated")
		throw new Error(`expected updated, got ${flushed?.kind}`);
	assertEquals(flushed.activity.progress, "consulting jev (3)");

	// An identical repaint (a spinner tick that changed nothing) schedules nothing.
	tracker.observeWidgetFrame("jev-decompose", "Jev\nconsulting jev (3)", 40);
	assertEquals(timers.filter((timer) => timer.delayMs === 100).length, 1);

	tracker.scopeEnd(toolScope, 60, {
		ok: true,
		result: { content: [{ type: "text", text: "jev: no recommendation" }] },
	});
	// JEV closes its card through the captured ctx after the tool returned.
	tracker.observeWidgetFrame("jev-decompose", "Jev\nfailed: no credential", 70);
	tracker.uiSignal(toolScope, { kind: "widgetClose", key: "jev-decompose" }, 2600);
	const closed = changes.at(-1);
	if (closed?.kind !== "finished")
		throw new Error(`expected finished, got ${closed?.kind}`);
	const panel = closed.activity.output.find((section) => section.kind === "panel");
	assertEquals(panel?.text, "Jev\nfailed: no credential");
	assertEquals(tracker.ownsWidget("jev-decompose"), false);
});

test("a string-array widget update is coalesced the same way as a factory frame", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
	const scope = hookScope();
	tracker.scopeStart(scope, 0);
	timers[0]?.run();
	for (let tick = 0; tick < 10; tick += 1) {
		tracker.uiSignal(
			scope,
			{ kind: "widgetFrame", key: "panel", text: `line ${tick}` },
			tick,
		);
	}
	const frameTimers = timers.filter((timer) => timer.delayMs === 100);
	assertEquals(frameTimers.length, 1);
	frameTimers[0]?.run();
	const updates = changes.filter((change) => change.kind === "updated");
	assertEquals(updates.length, 1);
	const last = updates.at(-1);
	if (last?.kind !== "updated") throw new Error("unreachable");
	assertEquals(last.activity.progress, "line 9");
});

test("a frame for a widget no instrumented scope mounted is ignored", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
	tracker.observeWidgetFrame("unknown", "text", 0);
	assertEquals(timers.length, 0);
	assertEquals(changes.length, 0);
});

test("a throwing sink never escapes a timer callback or a reporter call", () => {
	const { scheduler, timers } = fakeScheduler();
	const tracker = new ExtensionActivityTracker({
		sink: () => {
			throw new Error("sink exploded");
		},
		scheduler,
		clock: () => 0,
	});
	const scope = hookScope();
	tracker.scopeStart(scope, 0);
	timers[0]?.run();
	tracker.scopeEnd(scope, 900, { ok: true, result: undefined });
	assertEquals(tracker.list()[0]?.state, "done");
});

test("a late close from an older mount under the same key never steals the newer mount's frame", () => {
	const { scheduler } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
	// JEV's tool consult mounts card A, then its `context` hook mounts card B under
	// the same widget key before A's lingering close fires (both real JEV paths).
	const toolScope = hookScope({ scopeId: "tool:a", title: "jev_decompose" });
	const hookScopeB = hookScope({ scopeId: "hook:b", title: "context" });
	tracker.scopeStart(toolScope, 0);
	tracker.uiSignal(toolScope, { kind: "widgetMount", key: "jev-decompose" }, 1);
	tracker.observeWidgetFrame("jev-decompose", "card A: failed", 2);
	tracker.scopeEnd(toolScope, 3, { ok: true, result: undefined });
	tracker.scopeStart(hookScopeB, 10);
	tracker.uiSignal(hookScopeB, { kind: "widgetMount", key: "jev-decompose" }, 11);
	tracker.observeWidgetFrame("jev-decompose", "card B: failed", 12);
	tracker.scopeEnd(hookScopeB, 13, { ok: true, result: undefined });

	tracker.uiSignal(toolScope, { kind: "widgetClose", key: "jev-decompose" }, 2500);
	tracker.uiSignal(hookScopeB, { kind: "widgetClose", key: "jev-decompose" }, 2510);
	const panels = new Map<string, string | undefined>();
	for (const change of changes) {
		if (change.kind !== "finished") continue;
		const panel = change.activity.output.find((section) => section.kind === "panel");
		if (panel) panels.set(change.activity.title, panel.text);
	}
	assertEquals(panels.get("context"), "card B: failed");
	assertEquals(panels.get("jev_decompose"), "card A: failed");
});

test("a visible UI signal inside a scope promotes it after uiPromotionMs, not hookPromotionMs", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink, changes } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
	const scope = hookScope({ scopeId: "tool:jev", title: "jev_decompose" });
	tracker.scopeStart(scope, 0);
	tracker.uiSignal(scope, { kind: "widgetMount", key: "jev-decompose" }, 5);
	tracker.uiSignal(scope, { kind: "status", key: "jev", text: "consulting" }, 6);
	const live = timers.filter((timer) => !timer.cancelled);
	assertEquals(
		live.map((timer) => timer.delayMs),
		[extensionActivityThresholds.uiPromotionMs],
	);
	live[0]?.run();
	const promoted = changes.at(-1);
	if (promoted?.kind !== "created") throw new Error(`unexpected ${promoted?.kind}`);
	assertEquals(promoted.activity.state, "working");
});

test("a notify inside a scope does not expedite its promotion", () => {
	const { scheduler, timers } = fakeScheduler();
	const { sink } = sinkRecorder();
	const tracker = new ExtensionActivityTracker({ sink, scheduler, clock: () => 0 });
	const scope = hookScope();
	tracker.scopeStart(scope, 0);
	tracker.uiSignal(scope, { kind: "notify", text: "hi", type: "info" }, 5);
	assertEquals(
		timers.filter((timer) => !timer.cancelled).map((timer) => timer.delayMs),
		[extensionActivityThresholds.hookPromotionMs],
	);
});

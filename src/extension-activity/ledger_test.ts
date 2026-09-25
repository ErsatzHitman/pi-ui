import { test } from "bun:test";

import { assertEquals, assertFalse } from "#testing/assertions";

import type { ExtensionRef } from "../extension-activity-types.ts";
import { ExtensionActivityLedger, type ScopeRef } from "./ledger.ts";
import { extensionActivityThresholds } from "./policy.ts";

function ref(id: string, label = id, source = "local"): ExtensionRef {
	return { id, label, path: `/x/${id}`, source };
}

function hookScope(scopeId: string, extension: ExtensionRef, event: string): ScopeRef {
	return {
		scopeId,
		extension,
		trigger: { kind: "hook", event },
		title: event,
	};
}

test("a timed scope that ends before promotion with no signal is dropped", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	const result = ledger.endTimedScope("s1", 50, { ok: true });
	assertEquals(result.kind, "dropped");
	assertEquals(ledger.list().length, 0);
});

test("promoteScope moves started -> working and is reported as created", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	const promoted = ledger.promoteScope("s1", 750);
	assertEquals(promoted.kind, "created");
	if (promoted.kind !== "created") throw new Error("unreachable");
	assertEquals(promoted.activity.state, "working");
	assertEquals(promoted.activity.workingAt, 750);
	// A second promotion attempt is a no-op.
	assertEquals(ledger.promoteScope("s1", 800).kind, "none");
});

test("ending a promoted scope successfully finishes it as done, with summary/output from the outcome", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	ledger.promoteScope("s1", 750);
	const finished = ledger.endTimedScope("s1", 1200, {
		ok: true,
		summary: "Consulted jev",
		output: [{ kind: "system-prompt", title: "Sent to model", text: "## Fake JEV" }],
	});
	assertEquals(finished.kind, "finished");
	if (finished.kind !== "finished") throw new Error("unreachable");
	assertEquals(finished.activity.state, "done");
	assertEquals(finished.activity.finishedAt, 1200);
	assertEquals(finished.activity.summary, "Consulted jev");
	assertEquals(finished.activity.output, [
		{ kind: "system-prompt", title: "Sent to model", text: "## Fake JEV" },
	]);
});

test("a throwing scope finishes as error, with the error text as a fallback summary", () => {
	const ledger = new ExtensionActivityLedger();
	const visionProxy = ref("vision-proxy", "Vision Proxy");
	ledger.beginTimedScope(hookScope("s1", visionProxy, "before_agent_start"), 0);
	ledger.promoteScope("s1", 750);
	const finished = ledger.endTimedScope("s1", 900, { ok: false, error: "boom" });
	assertEquals(finished.kind, "finished");
	if (finished.kind !== "finished") throw new Error("unreachable");
	assertEquals(finished.activity.state, "error");
	assertEquals(finished.activity.error, "boom");
	assertEquals(finished.activity.summary, "boom");
});

test("a UI signal inside a scope joins it and is reported pending until promoted", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	const pending = ledger.observeUiInScope(
		"s1",
		{ kind: "widgetFrame", key: "jev-decompose", text: "consulting jev" },
		100,
	);
	assertEquals(pending.kind, "pending");
	if (pending.kind !== "pending") throw new Error("unreachable");
	assertEquals(pending.activity.progress, "consulting jev");
	assertEquals(pending.activity.state, "started");

	const promoted = ledger.promoteScope(
		"s1",
		100 + extensionActivityThresholds.uiPromotionMs,
	);
	assertEquals(promoted.kind, "created");
});

test("a scope that got a UI signal but ended before its own promotion still shows retroactively", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	ledger.observeUiInScope("s1", { kind: "status", key: "k", text: "working…" }, 10);
	const finished = ledger.endTimedScope("s1", 40, { ok: true });
	assertEquals(finished.kind, "finished");
	if (finished.kind !== "finished") throw new Error("unreachable");
	assertEquals(finished.activity.state, "done");
	assertEquals(finished.activity.progress, "working…");
});

test("setStatus(key, undefined) clears the signal but keeps the record (the core ask)", () => {
	const ledger = new ExtensionActivityLedger();
	const lsp = ref("pi-lsp", "LSP");
	ledger.beginTimedScope(hookScope("s1", lsp, "tool_call"), 0);
	ledger.observeUiInScope(
		"s1",
		{ kind: "status", key: "lsp", text: "pyright checking" },
		10,
	);
	ledger.promoteScope("s1", 10 + extensionActivityThresholds.uiPromotionMs);
	const cleared = ledger.observeUiInScope(
		"s1",
		{ kind: "status", key: "lsp", text: undefined },
		500,
	);
	assertEquals(cleared.kind, "updated");
	if (cleared.kind !== "updated") throw new Error("unreachable");
	// The record survives the clear; its last progress line is untouched.
	assertEquals(cleared.activity.progress, "pyright checking");
	assertEquals(cleared.activity.state, "working");
});

test("setWidget(key, undefined) after the scope already finished refreshes output without reopening it", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	ledger.observeUiInScope(
		"s1",
		{ kind: "widgetFrame", key: "jev-decompose", text: "consulting jev" },
		10,
	);
	ledger.promoteScope("s1", 10 + extensionActivityThresholds.uiPromotionMs);
	const finished = ledger.endTimedScope("s1", 900, {
		ok: true,
		summary: "Consulted jev",
	});
	assertEquals(finished.kind, "finished");

	// The captured hook ctx closes the widget 2.5s later, long after the hook itself returned.
	const late = ledger.observeUiInScope(
		"s1",
		{ kind: "widgetClose", key: "jev-decompose", finalText: "final card frame" },
		3400,
	);
	// Reported as "finished" again (not just "updated") so the owner re-writes
	// the persisted "finish" entry — otherwise this panel output would be
	// visible live but lost on reload/resume (DESIGN §2.4: last write wins).
	assertEquals(late.kind, "finished");
	if (late.kind !== "finished") throw new Error("unreachable");
	assertEquals(late.activity.state, "done");
	assertEquals(late.activity.summary, "Consulted jev");
	assertEquals(
		late.activity.output.some(
			(section) => section.kind === "panel" && section.text === "final card frame",
		),
		true,
	);
});

test("a carrier UI signal is ignored while the run is not active", () => {
	const ledger = new ExtensionActivityLedger();
	const resilience = ref("resilience", "Resilience");
	const result = ledger.observeUiCarrier({
		extension: resilience,
		key: "retry",
		signal: { kind: "status", key: "retry", text: "stalled, retrying…" },
		now: 100,
		runActive: false,
	});
	assertEquals(result.kind, "none");
	assertEquals(ledger.list().length, 0);
});

test("a carrier UI signal starts a standalone {trigger:ui} activity while the run is active, and finishes when cleared", () => {
	const ledger = new ExtensionActivityLedger();
	const resilience = ref("resilience", "Resilience");
	const started = ledger.observeUiCarrier({
		extension: resilience,
		key: "retry",
		signal: { kind: "status", key: "retry", text: "stalled, retrying…" },
		now: 0,
		runActive: true,
	});
	assertEquals(started.kind, "pending");
	if (started.kind !== "pending") throw new Error("unreachable");
	assertEquals(started.activity.trigger, {
		kind: "ui",
		signal: "status",
		key: "retry",
	});

	const promoted = ledger.promoteCarrier(
		"resilience",
		"retry",
		extensionActivityThresholds.uiPromotionMs,
	);
	assertEquals(promoted.kind, "created");

	const cleared = ledger.observeUiCarrier({
		extension: resilience,
		key: "retry",
		signal: { kind: "status", key: "retry", text: undefined },
		now: 500,
		runActive: true,
	});
	assertEquals(cleared.kind, "finished");
	if (cleared.kind !== "finished") throw new Error("unreachable");
	assertEquals(cleared.activity.state, "done");
});

test("standing chrome never becomes an activity, even during an active run", () => {
	const ledger = new ExtensionActivityLedger();
	const todo = ref("todo", "Todo");
	const result = ledger.observeUiCarrier({
		extension: todo,
		key: "always-here",
		signal: { kind: "widgetFrame", key: "always-here", text: "- [ ] item" },
		now: 0,
		runActive: true,
	});
	assertEquals(result.kind, "none");
	assertEquals(ledger.list().length, 0);
});

test("a custom message attaches to the extension's newest open activity", () => {
	const ledger = new ExtensionActivityLedger();
	const visionProxy = ref("vision-proxy", "Vision Proxy");
	ledger.beginTimedScope(hookScope("s1", visionProxy, "before_agent_start"), 0);
	ledger.promoteScope("s1", 750);
	const attached = ledger.observeCustomMessage({
		extension: visionProxy,
		text: "A red square.",
		hidden: true,
		now: 800,
	});
	assertEquals(attached.kind, "updated");
	if (attached.kind !== "updated") throw new Error("unreachable");
	assertEquals(attached.activity.output, [
		{
			kind: "custom-message",
			title: "Sent to model · hidden in terminal",
			text: "A red square.",
			hidden: true,
		},
	]);
});

test("a custom message attaches to a recently-finished activity within the attach window, not after it", () => {
	const ledger = new ExtensionActivityLedger();
	const visionProxy = ref("vision-proxy", "Vision Proxy");
	ledger.beginTimedScope(hookScope("s1", visionProxy, "before_agent_start"), 0);
	ledger.promoteScope("s1", 750);
	ledger.endTimedScope("s1", 1000, { ok: true });

	const withinWindow = ledger.observeCustomMessage({
		extension: visionProxy,
		text: "A red square.",
		hidden: true,
		now: 1000 + extensionActivityThresholds.customMessageAttachWindowMs - 1,
	});
	assertEquals(withinWindow.kind, "updated");

	const afterWindow = ledger.observeCustomMessage({
		extension: visionProxy,
		text: "too late",
		hidden: true,
		now: 1000 + extensionActivityThresholds.customMessageAttachWindowMs + 1,
	});
	assertEquals(afterWindow.kind, "none");
});

test("a custom message with no matching activity is ignored", () => {
	const ledger = new ExtensionActivityLedger();
	const advisor = ref("advisor", "Advisor");
	const result = ledger.observeCustomMessage({
		extension: advisor,
		text: "## Review\nLGTM",
		hidden: false,
		now: 0,
	});
	assertEquals(result.kind, "none");
});

test("selfHeal finalizes a still-open carrier activity after standingAfterSettleMs and demotes it to standing", () => {
	const ledger = new ExtensionActivityLedger();
	const resilience = ref("resilience", "Resilience");
	ledger.observeUiCarrier({
		extension: resilience,
		key: "retry",
		signal: { kind: "status", key: "retry", text: "stalled…" },
		now: 0,
		runActive: true,
	});
	ledger.promoteCarrier(
		"resilience",
		"retry",
		extensionActivityThresholds.uiPromotionMs,
	);

	const settledAt = 1000;
	const tooSoon = ledger.selfHeal(
		settledAt + extensionActivityThresholds.standingAfterSettleMs - 1,
		settledAt,
	);
	assertEquals(tooSoon.finalized.length, 0);

	const healed = ledger.selfHeal(
		settledAt + extensionActivityThresholds.standingAfterSettleMs,
		settledAt,
	);
	assertEquals(healed.finalized.length, 1);
	assertEquals(healed.finalized[0]!.state, "done");
	assertEquals(healed.finalized[0]!.summary, "Still shown above the prompt");
	assertEquals(healed.demoted, [{ extensionId: "resilience", key: "retry" }]);

	// Demoted: the same (ext,key) never creates another activity this session.
	const again = ledger.observeUiCarrier({
		extension: resilience,
		key: "retry",
		signal: { kind: "status", key: "retry", text: "stalled again…" },
		now: settledAt + extensionActivityThresholds.standingAfterSettleMs + 10,
		runActive: true,
	});
	assertEquals(again.kind, "none");
});

test("cancelAll finishes every promoted open activity as cancelled and drops unpromoted ones", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	const advisor = ref("advisor", "Advisor");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	ledger.promoteScope("s1", 750);
	ledger.beginTimedScope(hookScope("s2", advisor, "agent_settled"), 0); // never promoted

	const result = ledger.cancelAll(2000, "Stopped");
	assertEquals(result.cancelled.length, 1);
	assertEquals(result.cancelled[0]!.state, "cancelled");
	assertEquals(result.cancelled[0]!.summary, "Stopped");
	assertEquals(result.dropped.length, 1);

	// A terminal activity is left alone by a second cancelAll.
	assertEquals(ledger.cancelAll(3000, "Stopped").cancelled.length, 0);
});

test("cancelAll makes a later signal for the same scope a no-op (the index was cleared)", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	ledger.promoteScope("s1", 750);
	ledger.cancelAll(2000, "Session closed");
	assertEquals(
		ledger.observeUiInScope(
			"s1",
			{ kind: "workingMessage", text: "still going?" },
			2100,
		).kind,
		"none",
	);
});

test("listOpen reports only non-terminal activities", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	const advisor = ref("advisor", "Advisor");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	ledger.promoteScope("s1", 750);
	ledger.beginTimedScope(hookScope("s2", advisor, "agent_settled"), 0);
	ledger.promoteScope("s2", 750);
	ledger.endTimedScope("s2", 900, { ok: true });

	const open = ledger.listOpen();
	assertEquals(open.length, 1);
	assertEquals(open[0]!.extension.id, "jev");
});

test("a status timeline is deduped and capped to 20 lines", () => {
	const ledger = new ExtensionActivityLedger();
	const lsp = ref("pi-lsp", "LSP");
	ledger.beginTimedScope(hookScope("s1", lsp, "tool_call"), 0);
	for (let i = 0; i < 25; i++) {
		ledger.observeUiInScope(
			"s1",
			{ kind: "status", key: "lsp", text: `step ${i}` },
			i,
		);
	}
	// A repeat of the same line is not duplicated.
	ledger.observeUiInScope("s1", { kind: "status", key: "lsp", text: "step 24" }, 26);
	ledger.promoteScope("s1", 30);
	const finished = ledger.endTimedScope("s1", 40, { ok: true });
	assertEquals(finished.kind, "finished");
	if (finished.kind !== "finished") throw new Error("unreachable");
	const statusSection = finished.activity.output.find(
		(section) => section.kind === "status",
	);
	assertFalse(statusSection === undefined);
	const lines = statusSection!.text.split("\n");
	assertEquals(lines.length, 20);
	assertEquals(lines.at(-1), "step 24");
	assertEquals(lines[0], "step 5");
});

test("progress text is capped to 200 characters", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	const long = "x".repeat(300);
	const pending = ledger.observeUiInScope(
		"s1",
		{ kind: "workingMessage", text: long },
		10,
	);
	if (pending.kind !== "pending") throw new Error("unreachable");
	assertEquals(pending.activity.progress!.length, 200);
});

test("oldest finished activities are evicted once the in-memory cap is exceeded, but open ones never are", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	// Fill past the cap with finished activities, then confirm the oldest are gone.
	for (let i = 0; i < 205; i++) {
		const scopeId = `s${i}`;
		ledger.beginTimedScope(hookScope(scopeId, jev, "before_agent_start"), i);
		ledger.promoteScope(scopeId, i + 750);
		ledger.endTimedScope(scopeId, i + 800, { ok: true, summary: `run ${i}` });
	}
	assertEquals(ledger.list().length <= 200, true);
	const summaries = ledger.list().map((activity) => activity.summary);
	assertFalse(summaries.includes("run 0"));
	assertEquals(summaries.includes("run 204"), true);
});

test("a widget frame arriving after the scope finished changes nothing (no per-frame churn)", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "tool"), 0);
	ledger.promoteScope("s1", 750);
	ledger.endTimedScope("s1", 900, { ok: true });
	const frame = ledger.observeUiInScope(
		"s1",
		{ kind: "widgetFrame", key: "jev-decompose", text: "spinner tick" },
		1000,
	);
	assertEquals(frame.kind, "none");
});

test("dropped fast scopes never leak their scope index entries", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	for (let i = 0; i < 5000; i++) {
		ledger.beginTimedScope(hookScope(`fast-${i}`, jev, "message_end"), i);
		assertEquals(
			ledger.endTimedScope(`fast-${i}`, i + 1, { ok: true }).kind,
			"dropped",
		);
	}
	assertEquals(ledger.list().length, 0);
	assertEquals(ledger.scopeIndexSize, 0);
});

test("the scope index stays bounded by the in-memory activity cap", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	for (let i = 0; i < 450; i++) {
		ledger.beginTimedScope(hookScope(`s${i}`, jev, "before_agent_start"), i);
		ledger.promoteScope(`s${i}`, i + 750);
		ledger.endTimedScope(`s${i}`, i + 800, { ok: true });
	}
	assertEquals(ledger.scopeIndexSize <= 200, true);
});

test("a panel frame's progress is its last meaningful line, not a box border", () => {
	const ledger = new ExtensionActivityLedger();
	const advisor = ref("advisor", "Advisor");
	ledger.beginTimedScope(hookScope("s1", advisor, "agent_settled"), 0);
	const change = ledger.observeUiInScope(
		"s1",
		{
			kind: "widgetFrame",
			key: "advisor-live-panel",
			text: [
				"╭─ Advisor ─╮",
				"│ reading diff        │",
				"│ reviewing 3 files   │",
				"╰────╯",
				"",
			].join("\n"),
		},
		10,
	);
	if (change.kind !== "pending") throw new Error(`unexpected ${change.kind}`);
	assertEquals(change.activity.progress, "reviewing 3 files");
});

test("closing a widget that never produced any text adds no empty panel section", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "before_agent_start"), 0);
	ledger.promoteScope("s1", 750);
	const change = ledger.observeUiInScope(
		"s1",
		{ kind: "widgetClose", key: "jev-decompose" },
		800,
	);
	if (change.kind !== "updated") throw new Error(`unexpected ${change.kind}`);
	assertEquals(
		change.activity.output.filter((section) => section.kind === "panel"),
		[],
	);
});

test("a fast scope whose only signal was a notice is dropped: notify never creates an activity", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	// e.g. `/jev status`: a command that only calls `ctx.ui.notify(...)` — the notice
	// row already shows it, so a card would just duplicate it (DESIGN §2.3 notify row).
	ledger.beginTimedScope(
		{
			scopeId: "c1",
			extension: jev,
			trigger: { kind: "command", name: "jev" },
			title: "/jev",
		},
		0,
	);
	ledger.observeUiInScope("c1", { kind: "notify", text: "jev: on", type: "info" }, 5);
	assertEquals(ledger.endTimedScope("c1", 10, { ok: true }).kind, "dropped");
	assertEquals(ledger.list().length, 0);
});

test("a fast scope that mounted a widget still shows retroactively (the widget was visible)", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "tool"), 0);
	ledger.observeUiInScope("s1", { kind: "widgetMount", key: "jev-decompose" }, 1);
	const finished = ledger.endTimedScope("s1", 5, { ok: true });
	assertEquals(finished.kind, "finished");
	// …and the widget's later close still lands on it, with its final frame.
	const closed = ledger.observeUiInScope(
		"s1",
		{ kind: "widgetClose", key: "jev-decompose", finalText: "FAILED: no credential" },
		2500,
	);
	if (closed.kind !== "finished") throw new Error(`unexpected ${closed.kind}`);
	assertEquals(closed.activity.output.at(-1)?.text, "FAILED: no credential");
});

test("a panel's final frame becomes the kept one-line result, not a stale live line", () => {
	const ledger = new ExtensionActivityLedger();
	const jev = ref("jev", "JEV");
	ledger.beginTimedScope(hookScope("s1", jev, "tool"), 0);
	ledger.observeUiInScope("s1", { kind: "widgetMount", key: "jev-decompose" }, 1);
	ledger.observeUiInScope(
		"s1",
		{ kind: "widgetFrame", key: "jev-decompose", text: "│ consulting jev (2/3) │" },
		2,
	);
	ledger.endTimedScope("s1", 5, { ok: true });
	const closed = ledger.observeUiInScope(
		"s1",
		{
			kind: "widgetClose",
			key: "jev-decompose",
			finalText: [
				"┌─ jev ─┐",
				"│ recommendation: use 2 agents │",
				"└───────┘",
			].join("\n"),
		},
		2500,
	);
	if (closed.kind !== "finished") throw new Error(`unexpected ${closed.kind}`);
	assertEquals(closed.activity.progress, "recommendation: use 2 agents");
});

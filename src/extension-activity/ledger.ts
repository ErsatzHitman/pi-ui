import {
	isTerminalExtensionActivityState,
	type ExtensionActivity,
	type ExtensionActivityOutput,
	type ExtensionActivityTrigger,
	type ExtensionRef,
} from "../extension-activity-types.ts";
import {
	capOutputSections,
	capProgressLine,
	extensionActivityCaps,
	extensionActivityThresholds,
	isStandingSignal,
} from "./policy.ts";

let activitySequence = 0;
function newActivityId(): string {
	activitySequence += 1;
	return `xa-${crypto.randomUUID()}-${activitySequence}`;
}

/** A `ctx.ui` call, already normalized from whichever real method raised it —
 * see `DESIGN-ext-activity.md` §2.3's transition table rows. */
export type UiSignal =
	| { kind: "widgetFrame"; key: string; text: string }
	/** A `(tui, theme) => Component` factory mounted under `key`. Carries no
	 * text of its own: its rendered frames arrive later as `widgetFrame`s via
	 * `ExtensionActivityTracker.observeWidgetFrame`. The ledger ignores it. */
	| { kind: "widgetMount"; key: string }
	| { kind: "widgetClose"; key: string; finalText?: string }
	| { kind: "status"; key: string; text: string | undefined }
	| { kind: "workingMessage"; text: string | undefined }
	| { kind: "notify"; text: string; type: "info" | "warning" | "error" }
	| { kind: "waiting"; title: string };

/** Identifies one timed hook/tool/command/shortcut run for `beginTimedScope`. */
export type ScopeRef = Readonly<{
	/** Unique per invocation, assigned by `instrument.ts`. */
	scopeId: string;
	extension: ExtensionRef;
	trigger: ExtensionActivityTrigger;
	title: string;
	/** Set when this scope is `tool_call`/`tool_result` for a known tool call, or
	 * is the tool's own `execute()` — folds the activity into that tool's card. */
	toolCallId?: string;
	turnEntryId?: string;
}>;

export type ScopeOutcome =
	| Readonly<{
			ok: true;
			summary?: string;
			output?: readonly ExtensionActivityOutput[];
	  }>
	| Readonly<{ ok: false; error: string }>;

/**
 * What a ledger call changed, so `ExtensionActivityTracker` (which owns I/O:
 * timers, transcript writes, persistence) knows what to do next.
 *
 * - `none`: nothing tracked (unknown scope, standing signal, dropped record, …).
 * - `pending`: the activity exists but is still `started` (below its
 *   promotion threshold) — never render or persist this; the tracker uses it
 *   only to know a promotion timer should be scheduled if one isn't already.
 * - `created`: the activity just became `working` for the first time — render
 *   (append a message) and persist a `"start"` entry.
 * - `updated`: an already-visible `working` activity changed — patch its
 *   message. Never persisted (only `"start"`/`"finish"` are).
 * - `finished`: reached a terminal state — patch its message and persist a
 *   `"finish"` entry.
 * - `dropped`: a `started` (never-visible) activity ended with nothing to
 *   show — nothing to render or persist, ever ("fast hooks never show").
 */
export type LedgerChange =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "pending"; activity: ExtensionActivity }>
	| Readonly<{ kind: "created"; activity: ExtensionActivity }>
	| Readonly<{ kind: "updated"; activity: ExtensionActivity }>
	| Readonly<{ kind: "finished"; activity: ExtensionActivity }>
	| Readonly<{ kind: "dropped"; activityId: string }>;

export type CarrierSignalInput = Readonly<{
	extension: ExtensionRef;
	key: string;
	signal: UiSignal;
	now: number;
	/** Whether an agent run is currently active (dispatch → `agent_settled` +
	 * `runGraceMs`, per §2.3's policy). Computed by the tracker; the ledger has
	 * no clock of its own. */
	runActive: boolean;
}>;

export type CustomMessageInput = Readonly<{
	extension: ExtensionRef;
	text: string;
	hidden: boolean;
	now: number;
}>;

export type SelfHealResult = Readonly<{
	finalized: readonly ExtensionActivity[];
	demoted: readonly Readonly<{ extensionId: string; key: string }>[];
}>;

export type CancelAllResult = Readonly<{
	cancelled: readonly ExtensionActivity[];
	dropped: readonly string[];
}>;

const maxStatusLines = 20;

type MutableActivity = {
	v: 1;
	id: string;
	extension: ExtensionRef;
	trigger: ExtensionActivityTrigger;
	title: string;
	state: ExtensionActivity["state"];
	startedAt: number;
	workingAt?: number;
	finishedAt?: number;
	progress?: string;
	summary?: string;
	output: ExtensionActivityOutput[];
	error?: string;
	anchor?: { toolCallId: string };
	turnEntryId?: string;
	/** Whether this record ever crossed its promotion threshold — an
	 * unpromoted record is invisible and gets dropped, not finished, on end. */
	promoted: boolean;
	/** Whether a visible UI signal (a widget, a status line, a working message,
	 * a dialog wait) was ever raised for it. A scope that ends before its own
	 * promotion still shows retroactively when this is set; a notice or custom
	 * message alone never creates an activity (§2.3) — its own row shows it. */
	signalled: boolean;
	/** The timed scope that created this record, if any — lets `#remove`
	 * drop its `#byScopeId` entry so the index never outgrows the records. */
	scopeId?: string;
};

/**
 * Pure state machine over `ExtensionActivity` records — no timers, no I/O, no
 * SDK dependency. `ExtensionActivityTracker` is the only caller: it owns real
 * time (`Date.now()`), `setTimeout`s for the promotion thresholds, and every
 * sink (transcript, AppStore, persistence). Every method here takes `now`
 * explicitly, which is what keeps this trivially unit-testable — mirrors
 * `LiveWorkspaceController`'s "pure reducer + explicit inputs" shape.
 */
export class ExtensionActivityLedger {
	readonly #activities = new Map<string, MutableActivity>();
	/** Creation order, for "oldest finished dropped from memory" eviction. */
	readonly #order: string[] = [];
	/**
	 * Timed-scope index. Deliberately never deleted on scope end (only on
	 * eviction) — an extension's captured hook `ctx` can call `setWidget(key,
	 * undefined)` long after its hook returned (JEV's `CARD_LINGER_MS`), and
	 * that must still reach the same record: "clearing a status or closing a
	 * widget must NOT delete the record."
	 */
	readonly #byScopeId = new Map<string, string>();
	/** Carrier index: `"<extensionId>:<key>"` → activity id, for the standing
	 * vs run-scoped `{trigger:"ui"}` activities of §2.3's last-but-one row. */
	readonly #byCarrierKey = new Map<string, string>();
	/** `(ext,key)` pairs self-heal demoted to "standing at runtime" — checked
	 * in addition to `policy.ts`'s static deny-list. */
	readonly #runtimeStanding = new Set<string>();

	/** Starts a `started` (invisible) activity for a timed hook/tool/command/
	 * shortcut scope. Idempotent for the same `scopeId`. */
	beginTimedScope(scope: ScopeRef, now: number): void {
		if (this.#byScopeId.has(scope.scopeId)) return;
		const record: MutableActivity = {
			v: 1,
			id: newActivityId(),
			extension: scope.extension,
			trigger: scope.trigger,
			title: scope.title,
			state: "started",
			startedAt: now,
			output: [],
			promoted: false,
			signalled: false,
			anchor: scope.toolCallId ? { toolCallId: scope.toolCallId } : undefined,
			turnEntryId: scope.turnEntryId,
			scopeId: scope.scopeId,
		};
		this.#insert(record, scope.scopeId, undefined);
	}

	/** True while `scopeId` is still tracked (even after its own scope ended —
	 * see the `#byScopeId` doc comment) and not yet promoted, i.e. whether a
	 * pending promotion timer for it is still meaningful. */
	isScopePending(scopeId: string): boolean {
		const record = this.#recordForScope(scopeId);
		return record !== undefined && !record.promoted;
	}

	/** `started` → `working` for a timed-hook or tool scope's own promotion
	 * timer (`hookPromotionMs`). */
	promoteScope(scopeId: string, now: number): LedgerChange {
		const id = this.#byScopeId.get(scopeId);
		return id ? this.#promoteRecord(id, now) : { kind: "none" };
	}

	/** `started` → `working` for a carrier `{trigger:"ui"}` activity's own
	 * promotion timer (`uiPromotionMs`). */
	promoteCarrier(extensionId: string, key: string, now: number): LedgerChange {
		const id = this.#byCarrierKey.get(carrierKey(extensionId, key));
		return id ? this.#promoteRecord(id, now) : { kind: "none" };
	}

	/**
	 * Ends a timed scope. A record that never promoted and has no recorded
	 * progress/output is dropped outright ("fast hooks never show"); one that
	 * did receive a UI signal (even if its own promotion timer never fired) is
	 * shown as finished retroactively. `outcome` carries the hook/tool
	 * return-value-derived summary/output — mapping a specific hook's return
	 * shape to it is the tracker's job, not the ledger's.
	 */
	endTimedScope(scopeId: string, now: number, outcome: ScopeOutcome): LedgerChange {
		const id = this.#byScopeId.get(scopeId);
		if (!id) return { kind: "none" };
		const record = this.#activities.get(id);
		if (!record || isTerminalExtensionActivityState(record.state))
			return { kind: "none" };
		if (!record.promoted) {
			if (!record.signalled) {
				this.#remove(id);
				return { kind: "dropped", activityId: id };
			}
			record.promoted = true;
			record.workingAt = record.workingAt ?? now;
		}
		this.#applyOutcome(record, outcome, now);
		return { kind: "finished", activity: toPublic(record) };
	}

	/**
	 * Applies a `ctx.ui` call attributed to an open timed scope (§2.3's
	 * `setWidget`/`setStatus`/`setWorkingMessage`/`notify`/dialog-wait rows).
	 * Never promotes by itself — see `LedgerChange`'s `"pending"` doc comment —
	 * and, per the `#byScopeId` doc comment, still applies (refreshing output
	 * only) even after the scope's own `endTimedScope` call, without reopening
	 * a terminal state.
	 */
	observeUiInScope(scopeId: string, signal: UiSignal, now: number): LedgerChange {
		const id = this.#byScopeId.get(scopeId);
		if (!id) return { kind: "none" };
		const record = this.#activities.get(id);
		if (!record) return { kind: "none" };
		const wasPromoted = record.promoted;
		const wasTerminal = isTerminalExtensionActivityState(record.state);
		if (wasTerminal) {
			// A finished record only still cares about its panel's final frame
			// (JEV/Advisor close their widget through a captured ctx after the
			// hook or tool returned). Live frames after that are spinner churn:
			// the card already shows its summary, so they change nothing.
			if (signal.kind === "widgetFrame" || signal.kind === "widgetMount")
				return { kind: "none" };
			applySignal(record, signal, now);
			// "finished" (not "updated") so the owner re-writes the persisted
			// "finish" entry with the panel output — last write wins on replay.
			return signal.kind === "widgetClose"
				? { kind: "finished", activity: toPublic(record) }
				: { kind: "updated", activity: toPublic(record) };
		}
		applySignal(record, signal, now);
		if (!record.promoted) return { kind: "pending", activity: toPublic(record) };
		return wasPromoted
			? { kind: "updated", activity: toPublic(record) }
			: { kind: "created", activity: toPublic(record) };
	}

	/**
	 * Applies a `ctx.ui` call raised from a *carrier* scope (no timed hook
	 * bounding it — e.g. a status set from `session_start`, or during an
	 * unrelated fast event). Standing chrome (`policy.ts`'s deny-list, or a
	 * pair this ledger's own `selfHeal` demoted) is always a no-op, rendering
	 * exactly as it does today. Otherwise: joins that `(ext,key)`'s already-open
	 * standalone activity if one exists; else, only while `runActive`, starts
	 * one. Finishes ("All that activity's signals cleared") when the same
	 * signal kind that created it is cleared (a `widgetClose`, or `status`/
	 * `workingMessage` with `text: undefined`).
	 */
	observeUiCarrier(input: CarrierSignalInput): LedgerChange {
		const key = carrierKey(input.extension.id, input.key);
		if (this.#runtimeStanding.has(key)) return { kind: "none" };
		if (isStandingSignal(input.extension, input.key)) return { kind: "none" };

		const existingId = this.#byCarrierKey.get(key);
		if (existingId) {
			const record = this.#activities.get(existingId);
			if (record && !isTerminalExtensionActivityState(record.state)) {
				const wasPromoted = record.promoted;
				applySignal(record, input.signal, input.now);
				if (signalCloses(input.signal)) {
					record.state = "done";
					record.finishedAt = input.now;
					if (record.summary === undefined) record.summary = record.progress;
					this.#byCarrierKey.delete(key);
					if (!record.promoted) {
						this.#remove(record.id);
						return { kind: "dropped", activityId: record.id };
					}
					return { kind: "finished", activity: toPublic(record) };
				}
				if (!record.promoted)
					return { kind: "pending", activity: toPublic(record) };
				return wasPromoted
					? { kind: "updated", activity: toPublic(record) }
					: { kind: "created", activity: toPublic(record) };
			}
		}
		if (!input.runActive) return { kind: "none" };
		if (signalCloses(input.signal)) return { kind: "none" };
		const record: MutableActivity = {
			v: 1,
			id: newActivityId(),
			extension: input.extension,
			trigger: {
				kind: "ui",
				signal: signalTriggerKind(input.signal),
				key: input.key,
			},
			title: input.extension.label,
			state: "started",
			startedAt: input.now,
			output: [],
			promoted: false,
			signalled: false,
		};
		applySignal(record, input.signal, input.now);
		this.#insert(record, undefined, key);
		return { kind: "pending", activity: toPublic(record) };
	}

	/**
	 * Attaches a `display:false`/`display:true` custom message to the extension's
	 * newest activity if one is open, or finished within
	 * `customMessageAttachWindowMs` (§2.3's custom-message row). `{kind:"none"}`
	 * when there is nothing to attach to — the caller renders the message as its
	 * own row, unchanged.
	 */
	observeCustomMessage(input: CustomMessageInput): LedgerChange {
		const record = this.#newestActivityFor(input.extension.id, input.now);
		if (!record) return { kind: "none" };
		const title = input.hidden
			? "Sent to model · hidden in terminal"
			: "Posted below";
		record.output = capOutputSections([
			...record.output,
			{ kind: "custom-message", title, text: input.text, hidden: input.hidden },
		]);
		if (!record.promoted) return { kind: "pending", activity: toPublic(record) };
		return { kind: "updated", activity: toPublic(record) };
	}

	/**
	 * Finalizes any still-open `{trigger:"ui"}` carrier activity that has
	 * outlived `standingAfterSettleMs` since the run settled at `settledAt`,
	 * and demotes its `(ext,key)` to standing so it never creates another
	 * activity this session (§2.3's self-heal row — covers an unknown standing
	 * widget the static deny-list doesn't know about).
	 */
	selfHeal(now: number, settledAt: number): SelfHealResult {
		const finalized: ExtensionActivity[] = [];
		const demoted: { extensionId: string; key: string }[] = [];
		if (now - settledAt < extensionActivityThresholds.standingAfterSettleMs) {
			return { finalized, demoted };
		}
		for (const [key, id] of this.#byCarrierKey) {
			const record = this.#activities.get(id);
			if (!record || isTerminalExtensionActivityState(record.state)) continue;
			if (record.trigger.kind !== "ui") continue;
			finalized.push(finishSelfHealed(record, now));
			this.#byCarrierKey.delete(key);
			this.#runtimeStanding.add(key);
			const [extensionId, signalKey] = splitCarrierKey(key);
			demoted.push({ extensionId, key: signalKey });
		}
		return { finalized, demoted };
	}

	/** `agent_settled` with abort / `session_shutdown` / runtime dispose /
	 * `cancelAll()`: every open activity becomes `cancelled` and is reported for
	 * persistence, except one never promoted (invisible), which is dropped like
	 * any other unpromoted record. */
	cancelAll(now: number, reason: string): CancelAllResult {
		const cancelled: ExtensionActivity[] = [];
		const dropped: string[] = [];
		for (const record of this.#activities.values()) {
			if (isTerminalExtensionActivityState(record.state)) continue;
			if (!record.promoted) {
				dropped.push(record.id);
				continue;
			}
			record.state = "cancelled";
			record.finishedAt = now;
			if (record.summary === undefined) record.summary = reason;
			cancelled.push(toPublic(record));
		}
		for (const id of dropped) this.#remove(id);
		this.#byScopeId.clear();
		this.#byCarrierKey.clear();
		return { cancelled, dropped };
	}

	/** Number of timed-scope index entries — diagnostics/tests only. Bounded by
	 * the records still held (see `#remove`), never by how many hooks ran. */
	get scopeIndexSize(): number {
		return this.#byScopeId.size;
	}

	get(id: string): ExtensionActivity | undefined {
		const record = this.#activities.get(id);
		return record ? toPublic(record) : undefined;
	}

	/** Every tracked record, visible or not — diagnostics/tests only. */
	list(): readonly ExtensionActivity[] {
		return this.#order
			.map((id) => this.#activities.get(id))
			.filter((record): record is MutableActivity => record !== undefined)
			.map(toPublic);
	}

	/** `started`/`working` activities — feeds the prompt-strip chip row. */
	listOpen(): readonly ExtensionActivity[] {
		return this.list().filter(
			(activity) => !isTerminalExtensionActivityState(activity.state),
		);
	}

	#recordForScope(scopeId: string): MutableActivity | undefined {
		const id = this.#byScopeId.get(scopeId);
		return id ? this.#activities.get(id) : undefined;
	}

	#promoteRecord(id: string, now: number): LedgerChange {
		const record = this.#activities.get(id);
		if (
			!record ||
			record.promoted ||
			isTerminalExtensionActivityState(record.state)
		) {
			return { kind: "none" };
		}
		record.promoted = true;
		record.state = "working";
		record.workingAt = now;
		return { kind: "created", activity: toPublic(record) };
	}

	#applyOutcome(record: MutableActivity, outcome: ScopeOutcome, now: number): void {
		record.finishedAt = now;
		if (outcome.ok) {
			record.state = "done";
			if (outcome.summary !== undefined)
				record.summary = capProgressLine(outcome.summary);
			if (outcome.output && outcome.output.length > 0) {
				record.output = capOutputSections([...record.output, ...outcome.output]);
			}
		} else {
			record.state = "error";
			record.error = outcome.error;
			if (record.summary === undefined)
				record.summary = capProgressLine(outcome.error);
		}
	}

	#newestActivityFor(extensionId: string, now: number): MutableActivity | undefined {
		let best: MutableActivity | undefined;
		for (const record of this.#activities.values()) {
			if (record.extension.id !== extensionId) continue;
			const openOrRecent =
				!isTerminalExtensionActivityState(record.state) ||
				(record.finishedAt !== undefined &&
					now - record.finishedAt <=
						extensionActivityThresholds.customMessageAttachWindowMs);
			if (!openOrRecent) continue;
			if (!best || record.startedAt > best.startedAt) best = record;
		}
		return best;
	}

	#insert(
		record: MutableActivity,
		scopeId: string | undefined,
		carrierKeyValue: string | undefined,
	): void {
		this.#activities.set(record.id, record);
		this.#order.push(record.id);
		if (scopeId) this.#byScopeId.set(scopeId, record.id);
		if (carrierKeyValue) this.#byCarrierKey.set(carrierKeyValue, record.id);
		this.#evictOldestFinishedIfOverCap();
	}

	#remove(id: string): void {
		const record = this.#activities.get(id);
		if (record?.scopeId !== undefined && this.#byScopeId.get(record.scopeId) === id)
			this.#byScopeId.delete(record.scopeId);
		this.#activities.delete(id);
		const orderIndex = this.#order.indexOf(id);
		if (orderIndex !== -1) this.#order.splice(orderIndex, 1);
	}

	#evictOldestFinishedIfOverCap(): void {
		if (this.#activities.size <= extensionActivityCaps.maxActivitiesInMemory) return;
		for (const id of this.#order) {
			const record = this.#activities.get(id);
			if (!record || !isTerminalExtensionActivityState(record.state)) continue;
			this.#remove(id);
			for (const [key, mappedId] of this.#byCarrierKey) {
				if (mappedId === id) this.#byCarrierKey.delete(key);
			}
			return;
		}
	}
}

/** Every optional field of `ExtensionActivity`, made assignable — used only to
 * fill in `toPublic`'s result field-by-field without a conditional spread
 * (which would add e.g. `workingAt: undefined` instead of omitting the key). */
type AssignableActivityFields = {
	-readonly [K in keyof ExtensionActivity]?: ExtensionActivity[K];
};

function toPublic(record: MutableActivity): ExtensionActivity {
	const activity: ExtensionActivity = {
		v: 1,
		id: record.id,
		extension: record.extension,
		trigger: record.trigger,
		title: record.title,
		state: record.state,
		startedAt: record.startedAt,
		output: record.output,
	};
	const mutableActivity: AssignableActivityFields = activity;
	if (record.workingAt !== undefined) mutableActivity.workingAt = record.workingAt;
	if (record.finishedAt !== undefined) mutableActivity.finishedAt = record.finishedAt;
	if (record.progress !== undefined) mutableActivity.progress = record.progress;
	if (record.summary !== undefined) mutableActivity.summary = record.summary;
	if (record.error !== undefined) mutableActivity.error = record.error;
	if (record.anchor !== undefined) mutableActivity.anchor = record.anchor;
	if (record.turnEntryId !== undefined)
		mutableActivity.turnEntryId = record.turnEntryId;
	return activity;
}

function applySignal(record: MutableActivity, signal: UiSignal, _now: number): void {
	if (raisesVisibleSignal(signal)) record.signalled = true;
	switch (signal.kind) {
		case "widgetFrame": {
			const line = panelProgressLine(signal.text);
			if (line !== undefined) record.progress = capProgressLine(line);
			break;
		}
		case "widgetMount":
			break;
		case "widgetClose": {
			const text = signal.finalText ?? record.progress ?? "";
			if (text.trim() === "") break;
			// The panel's last meaningful line is the card's kept one-line result;
			// the live line may be a stale spinner frame from before it finished.
			const line =
				signal.finalText === undefined ? undefined : panelProgressLine(text);
			if (line !== undefined) record.progress = capProgressLine(line);
			record.output = capOutputSections([
				...record.output,
				{ kind: "panel", title: "Panel (final frame)", text },
			]);
			break;
		}
		case "status": {
			if (signal.text === undefined) break;
			record.progress = capProgressLine(signal.text);
			record.output = capOutputSections(
				appendDedupedStatusLine(record.output, signal.text),
			);
			break;
		}
		case "workingMessage": {
			if (signal.text !== undefined) record.progress = capProgressLine(signal.text);
			break;
		}
		case "notify": {
			record.output = capOutputSections([
				...record.output,
				{ kind: "notice", title: "Notice", text: signal.text },
			]);
			if (
				signal.type === "error" &&
				!isTerminalExtensionActivityState(record.state)
			) {
				record.error = signal.text;
			}
			break;
		}
		case "waiting": {
			record.progress = capProgressLine(`Waiting for input: ${signal.title}`);
			break;
		}
	}
}

/** Box-drawing and block characters a terminal panel frames itself with. */
const panelChromePattern = /[─-▟]/g;

/**
 * The line a live panel frame reports as progress: its last line that still
 * says something once the panel's border characters are stripped (a framed
 * card's last raw line is its bottom border). `undefined` for a blank frame.
 */
function panelProgressLine(text: string): string | undefined {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = (lines[index] ?? "").replace(panelChromePattern, " ").trim();
		if (/[\p{L}\p{N}]/u.test(line)) return line.replace(/\s{2,}/g, " ");
	}
	return undefined;
}

function appendDedupedStatusLine(
	output: readonly ExtensionActivityOutput[],
	text: string,
): ExtensionActivityOutput[] {
	const line = capProgressLine(text);
	const index = output.findIndex((section) => section.kind === "status");
	if (index === -1) {
		return [...output, { kind: "status", title: "Status", text: line }];
	}
	const existing = output[index]!;
	const lines = existing.text.length > 0 ? existing.text.split("\n") : [];
	if (lines.at(-1) !== line) lines.push(line);
	const trimmed =
		lines.length > maxStatusLines
			? lines.slice(lines.length - maxStatusLines)
			: lines;
	const next = [...output];
	next[index] = { ...existing, text: trimmed.join("\n") };
	return next;
}

/** Whether `signal` put something on screen for this activity (see
 * `MutableActivity.signalled`). */
export function raisesVisibleSignal(signal: UiSignal): boolean {
	switch (signal.kind) {
		case "widgetFrame":
		case "widgetMount":
		case "waiting":
			return true;
		case "status":
		case "workingMessage":
			return signal.text !== undefined;
		case "widgetClose":
		case "notify":
			return false;
	}
}

function signalCloses(signal: UiSignal): boolean {
	return (
		signal.kind === "widgetClose" ||
		(signal.kind === "status" && signal.text === undefined) ||
		(signal.kind === "workingMessage" && signal.text === undefined)
	);
}

function signalTriggerKind(signal: UiSignal): "status" | "widget" | "working" {
	if (
		signal.kind === "widgetFrame" ||
		signal.kind === "widgetClose" ||
		signal.kind === "widgetMount"
	)
		return "widget";
	if (signal.kind === "workingMessage") return "working";
	return "status";
}

function carrierKey(extensionId: string, key: string): string {
	return `${extensionId}:${key}`;
}

function splitCarrierKey(value: string): [string, string] {
	const separator = value.indexOf(":");
	if (separator === -1) return [value, ""];
	return [value.slice(0, separator), value.slice(separator + 1)];
}

function finishSelfHealed(record: MutableActivity, now: number): ExtensionActivity {
	record.state = "done";
	record.finishedAt = now;
	if (record.summary === undefined) record.summary = "Still shown above the prompt";
	return toPublic(record);
}

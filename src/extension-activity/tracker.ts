import type {
	ExtensionActivity,
	ExtensionActivityOutput,
	ExtensionRef,
} from "../extension-activity-types.ts";
import { isRecord, isString } from "../utils/type-guards.ts";
import type {
	InstrumentationReporter,
	InstrumentedScope,
	ScopeOutcomeRaw,
} from "./instrument.ts";
import {
	ExtensionActivityLedger,
	raisesVisibleSignal,
	type LedgerChange,
	type ScopeOutcome,
	type UiSignal,
} from "./ledger.ts";
import { extensionActivityThresholds } from "./policy.ts";

/**
 * Runs a scheduled callback after a delay and returns a canceller. The real
 * implementation is `setTimeout`/`clearTimeout`; tests inject a fake one so
 * promotion timers can be fired deterministically without waiting — mirrors
 * this module's "pure reducer (`ledger.ts`) + explicit inputs" testability
 * goal one layer up, at the I/O boundary this module owns.
 */
export type Scheduler = Readonly<{
	schedule(delayMs: number, run: () => void): () => void;
}>;

export const realScheduler: Scheduler = {
	schedule(delayMs, run) {
		const timer = setTimeout(run, delayMs);
		return () => clearTimeout(timer);
	},
};

/** The status lines and working message an open activity currently holds —
 * see `ExtensionActivityTracker.boundSignals`. */
export type ExtensionActivitySignalBinding = Readonly<{
	statusKeys: readonly string[];
	working: boolean;
}>;

export type ExtensionActivityTrackerOptions = Readonly<{
	/** Called for every `LedgerChange` other than `{kind:"none"}` — the owner
	 * (`runtime-controller.ts`) renders/persists it. */
	sink: (change: LedgerChange) => void;
	clock?: () => number;
	scheduler?: Scheduler;
}>;

/**
 * Orchestrates `ExtensionActivityLedger` for one runtime: implements
 * `InstrumentationReporter` (so `instrument.ts`'s wrapped handlers/tools/
 * commands/shortcuts report straight into it), owns the promotion timers the
 * pure ledger can't own itself, maps raw hook/tool return values to a
 * `ScopeOutcome` per `DESIGN-ext-activity.md` §2.3's transition table, and
 * folds the `pi.events` channels that carry other extensions' running state
 * (`subagents:fleet`, `bash-bg:fleet`, `workflow:progress`, `pi-goal:status`)
 * into the same carrier-activity machinery `ctx.ui` signals use.
 */
export class ExtensionActivityTracker implements InstrumentationReporter {
	readonly #ledger = new ExtensionActivityLedger();
	readonly #clock: () => number;
	readonly #scheduler: Scheduler;
	readonly #sink: (change: LedgerChange) => void;
	readonly #cancelers = new Map<string, () => void>();
	/** Activity id → the status keys / working message it currently holds, so
	 * the owner can show that activity's chip instead of a duplicate plain
	 * status or working line (DESIGN-ext-activity.md §2.4 "Prompt strip"). */
	readonly #boundSignals = new Map<
		string,
		{ statusKeys: Set<string>; working: boolean }
	>();
	#runActive = false;
	/** Widget key → the scope that mounted it, so its later rendered frames
	 * (which carry no attribution of their own) reach the right activity. */
	readonly #widgetOwners = new Map<string, InstrumentedScope>();
	/** Widget key → its latest frame text (applied or still coalescing). */
	readonly #widgetFrames = new Map<string, string>();
	/** Timed scopes whose promotion a visible UI signal already moved up. */
	readonly #expeditedScopes = new Set<string>();

	constructor(options: ExtensionActivityTrackerOptions) {
		this.#clock = options.clock ?? Date.now;
		this.#scheduler = options.scheduler ?? realScheduler;
		this.#sink = options.sink;
	}

	scopeStart(scope: InstrumentedScope, now: number): void {
		if (!scope.timed) return;
		this.#ledger.beginTimedScope(
			{
				scopeId: scope.scopeId,
				extension: scope.extension,
				trigger: scope.trigger,
				title: scope.title,
				toolCallId: scope.toolCallId,
			},
			now,
		);
		this.#scheduleScopePromotion(scope.scopeId);
	}

	scopeEnd(scope: InstrumentedScope, now: number, outcome: ScopeOutcomeRaw): void {
		if (!scope.timed) return;
		this.#cancel(scope.scopeId);
		this.#expeditedScopes.delete(scope.scopeId);
		const mapped = mapOutcome(scope, outcome);
		this.#emit(this.#ledger.endTimedScope(scope.scopeId, now, mapped));
	}

	uiSignal(scope: InstrumentedScope, signal: UiSignal, now: number): void {
		switch (signal.kind) {
			case "widgetMount": {
				// Its frames arrive later through `observeWidgetFrame`; remember
				// whose they are. The mount itself is a visible signal (a fast
				// scope that mounted a widget still gets its card). A different
				// scope's earlier widget under the same key is replaced here, so
				// its last frame is settled onto that scope now: its own late
				// close must not take this mount's frames.
				this.#releaseWidget(signal.key, scope, now);
				this.#widgetOwners.set(signal.key, scope);
				this.#applyUi(scope, signal, now);
				return;
			}
			case "widgetFrame": {
				this.#widgetOwners.set(signal.key, scope);
				this.observeWidgetFrame(signal.key, signal.text, now);
				return;
			}
			case "widgetClose": {
				const owner = this.#widgetOwners.get(signal.key);
				// A close from a scope whose widget was already replaced by
				// another scope's mount: that close only removes the newer
				// widget from the terminal; its own panel was settled then.
				if (owner && owner.scopeId !== scope.scopeId) return;
				const finalText = signal.finalText ?? this.#widgetFrames.get(signal.key);
				this.#flushWidgetFrame(signal.key);
				this.#resetWidget(signal.key);
				this.#applyUi(
					scope,
					finalText === undefined ? signal : { ...signal, finalText },
					now,
				);
				return;
			}
			default:
				this.#applyUi(scope, signal, now);
		}
	}

	/** Whether a scope this tracker saw mounted the widget under `key` — lets the
	 * owner skip turning a frame into text for widgets nobody tracks. */
	ownsWidget(key: string): boolean {
		return this.#widgetOwners.has(key);
	}

	/**
	 * One rendered frame (plain text, ANSI already stripped) of the widget
	 * under `key` — a `(tui, theme) => Component` factory's committed terminal
	 * surface, or a `string[]` widget's lines. Panels repaint at up to 30 fps
	 * (Advisor streams at 10 fps, JEV ticks a spinner every 120 ms), so frames
	 * are coalesced: an identical repaint is ignored and the rest apply at
	 * most once per `widgetFrameIntervalMs`, latest wins. The latest frame is
	 * kept as the activity's "Panel (final frame)" output when the widget
	 * closes (DESIGN-ext-activity.md §2.3's `setWidget` row).
	 */
	observeWidgetFrame(key: string, text: string, _now: number): void {
		if (!this.#widgetOwners.has(key)) return;
		if (this.#widgetFrames.get(key) === text) return;
		this.#widgetFrames.set(key, text);
		const timerKey = widgetFrameTimerKey(key);
		if (this.#cancelers.has(timerKey)) return;
		this.#cancelers.set(
			timerKey,
			this.#scheduler.schedule(
				extensionActivityThresholds.widgetFrameIntervalMs,
				() => {
					this.#cancelers.delete(timerKey);
					this.#applyWidgetFrame(key);
				},
			),
		);
	}

	/** Applies a still-scheduled frame now (before its widget closes). */
	#flushWidgetFrame(key: string): void {
		const timerKey = widgetFrameTimerKey(key);
		if (!this.#cancelers.has(timerKey)) return;
		this.#cancel(timerKey);
		this.#applyWidgetFrame(key);
	}

	#applyWidgetFrame(key: string): void {
		const owner = this.#widgetOwners.get(key);
		const text = this.#widgetFrames.get(key);
		if (!owner || text === undefined) return;
		this.#applyUi(owner, { kind: "widgetFrame", key, text }, this.#clock());
	}

	/** Before `scope` mounts under `key`: settles a different scope's widget
	 * there (its latest frame becomes its final panel), then forgets it. */
	#releaseWidget(key: string, scope: InstrumentedScope, now: number): void {
		const previous = this.#widgetOwners.get(key);
		const frame = this.#widgetFrames.get(key);
		this.#resetWidget(key);
		if (!previous || previous.scopeId === scope.scopeId || frame === undefined)
			return;
		this.#applyUi(previous, { kind: "widgetClose", key, finalText: frame }, now);
	}

	#resetWidget(key: string): void {
		this.#cancel(widgetFrameTimerKey(key));
		this.#widgetOwners.delete(key);
		this.#widgetFrames.delete(key);
	}

	#applyUi(scope: InstrumentedScope, signal: UiSignal, now: number): void {
		if (scope.timed) {
			const change = this.#ledger.observeUiInScope(scope.scopeId, signal, now);
			if (change.kind === "pending" && raisesVisibleSignal(signal)) {
				this.#expediteScopePromotion(scope.scopeId);
			}
			this.#recordBinding(change, signal);
			this.#emit(change);
			return;
		}
		const key = carrierKeyFor(signal);
		const change = this.#ledger.observeUiCarrier({
			extension: scope.extension,
			key,
			signal,
			now,
			runActive: this.#runActive,
		});
		if (change.kind === "pending") {
			this.#scheduleCarrierPromotion(scope.extension.id, key);
		}
		this.#recordBinding(change, signal);
		this.#emit(change);
	}

	/** The status keys and working message `activityId` currently holds —
	 * see `#boundSignals`. */
	boundSignals(activityId: string): ExtensionActivitySignalBinding {
		const binding = this.#boundSignals.get(activityId);
		return {
			statusKeys: binding ? [...binding.statusKeys] : [],
			working: binding?.working ?? false,
		};
	}

	#recordBinding(change: LedgerChange, signal: UiSignal): void {
		if (
			change.kind !== "pending" &&
			change.kind !== "created" &&
			change.kind !== "updated"
		) {
			return;
		}
		if (signal.kind !== "status" && signal.kind !== "workingMessage") return;
		const id = change.activity.id;
		const binding = this.#boundSignals.get(id) ?? {
			statusKeys: new Set<string>(),
			working: false,
		};
		if (signal.kind === "status") {
			if (signal.text === undefined) binding.statusKeys.delete(signal.key);
			else binding.statusKeys.add(signal.key);
		} else {
			binding.working = signal.text !== undefined;
		}
		this.#boundSignals.set(id, binding);
	}

	/**
	 * Folds a `pi.events` channel payload into the same carrier-activity
	 * machinery a `ctx.ui` signal uses, so "N subagents running" etc. shows
	 * with the same pink/working card. Payload shapes mirror
	 * `live-workspace-controller.ts`'s `deriveAgentRows` — the one place these
	 * four channels' shapes are already load-bearing and tested. Any other
	 * channel is ignored.
	 */
	observeChannel<Payload>(channel: string, payload: Payload, now: number): void {
		const ref = channelRefFor(channel);
		if (!ref) return;
		const text = channelActiveText(channel, payload, ref.label);
		const change = this.#ledger.observeUiCarrier({
			extension: ref,
			key: channelCarrierKey,
			signal: { kind: "workingMessage", text },
			now,
			runActive: this.#runActive,
		});
		if (change.kind === "pending") {
			this.#scheduleCarrierPromotion(ref.id, channelCarrierKey);
		}
		this.#emit(change);
	}

	/** Attaches a `pi.sendMessage`/`message_start` custom message to its
	 * resolved owner's open-or-recent activity — the caller resolves `extension`
	 * via `instrument.ts`'s `identifyMessageOwner` first (this module has no
	 * SDK/`Extension[]` dependency of its own). */
	observeCustomMessage(
		extension: ExtensionRef,
		text: string,
		hidden: boolean,
		now: number,
	): void {
		this.#emit(this.#ledger.observeCustomMessage({ extension, text, hidden, now }));
	}

	/** Drives the ledger's run-active window (§2.3's policy: the run counts as
	 * active from dispatch until `runGraceMs` past `agent_settled`, so a
	 * carrier signal an extension raises while wrapping up still gets a card)
	 * and schedules self-heal `standingAfterSettleMs` after the run settles,
	 * so a run-scoped `{trigger:"ui"}` activity whose signal is never cleared
	 * cannot stay "working" forever. The caller drives this from whatever it
	 * already uses to track streaming — an `agent_start`/`agent_settled`
	 * pair, `session.isStreaming`, or equivalent. */
	setRunActive(active: boolean, now: number): void {
		this.#cancel(runGraceTimerKey);
		this.#cancel(selfHealTimerKey);
		if (active) {
			this.#runActive = true;
			return;
		}
		this.#cancelers.set(
			runGraceTimerKey,
			this.#scheduler.schedule(extensionActivityThresholds.runGraceMs, () => {
				this.#cancelers.delete(runGraceTimerKey);
				this.#runActive = false;
			}),
		);
		this.#cancelers.set(
			selfHealTimerKey,
			this.#scheduler.schedule(
				extensionActivityThresholds.standingAfterSettleMs,
				() => {
					this.#cancelers.delete(selfHealTimerKey);
					this.selfHeal(this.#clock(), now);
				},
			),
		);
	}

	/** Finalizes any `{trigger:"ui"}` carrier activity that has outlived
	 * `standingAfterSettleMs` since `settledAt` — call periodically (or once
	 * per `agent_settled`) while the run stays idle. */
	selfHeal(now: number, settledAt: number): void {
		const result = this.#ledger.selfHeal(now, settledAt);
		for (const activity of result.finalized)
			this.#emit({ kind: "finished", activity });
	}

	/** `session_shutdown` / runtime dispose: every open activity becomes
	 * `cancelled` (or is dropped, if never promoted) and every pending
	 * promotion timer is cancelled. */
	cancelAll(now: number, reason: string): void {
		for (const cancel of this.#cancelers.values()) cancel();
		this.#cancelers.clear();
		this.#widgetOwners.clear();
		this.#widgetFrames.clear();
		this.#expeditedScopes.clear();
		const result = this.#ledger.cancelAll(now, reason);
		for (const activity of result.cancelled)
			this.#emit({ kind: "finished", activity });
		for (const activityId of result.dropped)
			this.#emit({ kind: "dropped", activityId });
	}

	get(id: string): ExtensionActivity | undefined {
		return this.#ledger.get(id);
	}

	list(): readonly ExtensionActivity[] {
		return this.#ledger.list();
	}

	listOpen(): readonly ExtensionActivity[] {
		return this.#ledger.listOpen();
	}

	/** Cancels every pending timer without touching ledger state — for tearing
	 * this tracker down without finalizing its activities (the caller already
	 * called `cancelAll`, or is discarding the runtime outright). */
	dispose(): void {
		for (const cancel of this.#cancelers.values()) cancel();
		this.#cancelers.clear();
	}

	/** A visible UI signal (a widget, status or working message) is itself
	 * evidence of real work, so the scope promotes `uiPromotionMs` after its
	 * first one instead of waiting out `hookPromotionMs` (§2.3's `setWidget`
	 * row: "Joins the scope's activity (promotes after uiPromotionMs=250)"). */
	#expediteScopePromotion(scopeId: string): void {
		if (this.#expeditedScopes.has(scopeId)) return;
		this.#expeditedScopes.add(scopeId);
		this.#cancel(scopeId);
		this.#scheduleScopePromotion(scopeId, extensionActivityThresholds.uiPromotionMs);
	}

	#scheduleScopePromotion(
		scopeId: string,
		delayMs: number = extensionActivityThresholds.hookPromotionMs,
	): void {
		const cancel = this.#scheduler.schedule(delayMs, () => {
			this.#cancelers.delete(scopeId);
			if (!this.#ledger.isScopePending(scopeId)) return;
			this.#emit(this.#ledger.promoteScope(scopeId, this.#clock()));
		});
		this.#cancelers.set(scopeId, cancel);
	}

	#scheduleCarrierPromotion(extensionId: string, key: string): void {
		const timerKey = `carrier:${extensionId}:${key}`;
		if (this.#cancelers.has(timerKey)) return;
		const cancel = this.#scheduler.schedule(
			extensionActivityThresholds.uiPromotionMs,
			() => {
				this.#cancelers.delete(timerKey);
				this.#emit(this.#ledger.promoteCarrier(extensionId, key, this.#clock()));
			},
		);
		this.#cancelers.set(timerKey, cancel);
	}

	#cancel(key: string): void {
		const cancel = this.#cancelers.get(key);
		if (!cancel) return;
		cancel();
		this.#cancelers.delete(key);
	}

	#emit(change: LedgerChange): void {
		if (change.kind === "none") return;
		try {
			this.#sink(change);
		} catch (error) {
			// Rendering/persisting a card must never break the extension that
			// raised the signal, nor escape a timer callback.
			console.error("Extension activity update failed", error);
		}
		if (change.kind === "dropped") this.#boundSignals.delete(change.activityId);
		if (change.kind === "finished") this.#boundSignals.delete(change.activity.id);
	}
}

const channelCarrierKey = "!channel";
const runGraceTimerKey = "run:grace";
const selfHealTimerKey = "run:self-heal";

function widgetFrameTimerKey(key: string): string {
	return `frame:${key}`;
}

const channelActivityRefs = {
	"subagents:fleet": {
		id: "subagents",
		label: "Subagents",
		path: "pi.events:subagents:fleet",
		source: "pi.events",
	},
	"bash-bg:fleet": {
		id: "bash-bg",
		label: "Background bash",
		path: "pi.events:bash-bg:fleet",
		source: "pi.events",
	},
	"workflow:progress": {
		id: "workflow",
		label: "Workflow",
		path: "pi.events:workflow:progress",
		source: "pi.events",
	},
	"pi-goal:status": {
		id: "pi-goal",
		label: "Goal",
		path: "pi.events:pi-goal:status",
		source: "pi.events",
	},
} satisfies Readonly<Record<string, ExtensionRef>>;

function channelRefFor(channel: string): ExtensionRef | undefined {
	if (!Object.hasOwn(channelActivityRefs, channel)) return undefined;
	// SAFETY: `Object.hasOwn` just confirmed `channel` is one of
	// `channelActivityRefs`'s own literal keys.
	return channelActivityRefs[channel as keyof typeof channelActivityRefs];
}

function channelActiveText<Payload>(
	channel: string,
	payload: Payload,
	label: string,
): string | undefined {
	if (!isRecord(payload)) return undefined;
	if (channel === "subagents:fleet" || channel === "bash-bg:fleet") {
		const entries = Array.isArray(payload.entries) ? payload.entries : [];
		if (entries.length === 0) return undefined;
		const noun = channel === "bash-bg:fleet" ? "background job" : "subagent";
		return `${entries.length} ${noun}${entries.length === 1 ? "" : "s"} running`;
	}
	if (channel === "workflow:progress" || channel === "pi-goal:status") {
		if (payload.active === false) return undefined;
		const name = isString(payload.name)
			? payload.name
			: isString(payload.text)
				? payload.text
				: label;
		const phase = isString(payload.phase)
			? payload.phase
			: isString(payload.status)
				? payload.status
				: undefined;
		return phase ? `${name}: ${phase}` : name;
	}
	return undefined;
}

function carrierKeyFor(signal: UiSignal): string {
	switch (signal.kind) {
		case "status":
		case "widgetFrame":
		case "widgetMount":
		case "widgetClose":
			return signal.key;
		case "workingMessage":
			return "!working";
		case "notify":
			return "!notify";
		case "waiting":
			return "!waiting";
	}
}

/**
 * Maps a raw hook/tool return value (or thrown error) to the ledger's
 * `ScopeOutcome`, per §2.3's transition table: `before_agent_start` →
 * `result.message`, `context`/`context_with_system` → changed messages,
 * `tool_call` → `block`/`reason`, `tool_result` → changed content, `input` →
 * `transform`, and a tool's own `execute()` failure. Every other timed event
 * (`agent_end`, `turn_end`, …) gets a generic "completed" outcome — a
 * specific mapping can be added the same way without touching the ledger.
 */
function mapOutcome(scope: InstrumentedScope, outcome: ScopeOutcomeRaw): ScopeOutcome {
	if (!outcome.ok) return { ok: false, error: describeError(outcome.error) };
	if (scope.trigger.kind === "tool") return mapToolOutcome(outcome.result);
	if (scope.trigger.kind === "hook")
		return mapHookOutcome(scope.trigger.event, outcome.result, scope.hookEvent);
	return { ok: true };
}

/** A tool's own `execute()` result is already the tool card's output, right
 * next to this step, so a successful result is never copied into the activity
 * (no duplicate line on screen, no second copy in the session file); only a
 * failure is summarized, so the step reads "Failed" with its reason. */
function mapToolOutcome<Result>(result: Result): ScopeOutcome {
	if (!isRecord(result) || result.isError !== true) return { ok: true };
	return { ok: false, error: extractTextContent(result.content) ?? "Tool call failed" };
}

function mapHookOutcome<Result, HookEvent>(
	event: string,
	result: Result,
	hookEvent: HookEvent,
): ScopeOutcome {
	switch (event) {
		case "before_agent_start":
			return mapBeforeAgentStart(result, hookEvent);
		case "context":
		case "context_with_system":
			return mapContextResult(result, hookEvent);
		case "tool_call":
			return mapToolCallResult(result);
		case "tool_result":
			return mapToolResultResult(result, hookEvent);
		case "input":
			return mapInputResult(result);
		default:
			return { ok: true };
	}
}

function mapBeforeAgentStart<Result, HookEvent>(
	result: Result,
	hookEvent: HookEvent,
): ScopeOutcome {
	if (!isRecord(result)) return { ok: true };
	const messageRecord = isRecord(result.message) ? result.message : undefined;
	const message = messageRecord ? messageContentText(messageRecord.content) : undefined;
	// Vision Proxy (and JEV's `jev-decompose`) return their message with
	// `display: false` — never shown in terminal pi, so this is the only
	// place its text becomes visible at all (DESIGN-ext-activity.md's Vision
	// Proxy row: "Output = returned message text … (hidden:true)").
	const hidden = messageRecord?.display === false;
	const originalSystemPrompt =
		isRecord(hookEvent) && isString(hookEvent.systemPrompt)
			? hookEvent.systemPrompt
			: undefined;
	const returnedSystemPrompt = isString(result.systemPrompt)
		? result.systemPrompt
		: undefined;
	const systemPromptOutput = systemPromptDiffOutput(
		originalSystemPrompt,
		returnedSystemPrompt,
	);
	if (message === undefined && systemPromptOutput === undefined) return { ok: true };
	const output =
		message !== undefined
			? [returnedMessageOutput(message, hidden)]
			: systemPromptOutput
				? [systemPromptOutput]
				: [];
	return {
		ok: true,
		summary: message ?? systemPromptOutput?.title ?? "Replaced system prompt",
		output,
	};
}

/**
 * Diffs a `before_agent_start` hook's returned `systemPrompt` against the
 * one it was actually invoked with (§2.3: "plus the appended `systemPrompt`
 * suffix (diff vs `event.systemPrompt`)"). A hook that hands back the exact
 * prompt it was given made no change and is filtered out entirely — the same
 * "fast/no-op hooks never show" rule the promotion threshold applies to slow
 * ones. A hook that only appends (the common case: an extension appends its
 * own section rather than rebuilding the prompt from scratch) reports just
 * the appended suffix, not the whole prompt reproduced. Anything else —
 * including when the original prompt isn't known, e.g. in tests that
 * construct a scope without `hookEvent` — falls back to the full returned
 * text, matching this function's pre-diff behavior.
 */
function systemPromptDiffOutput(
	original: string | undefined,
	returned: string | undefined,
): ExtensionActivityOutput | undefined {
	if (returned === undefined) return undefined;
	if (original !== undefined && returned === original) return undefined;
	if (
		original !== undefined &&
		returned.length > original.length &&
		returned.startsWith(original)
	) {
		return {
			kind: "system-prompt",
			title: "Appended to system prompt",
			text: returned.slice(original.length),
		};
	}
	return { kind: "system-prompt", title: "Replaced system prompt", text: returned };
}

/** The `before_agent_start` "Sent to model" output section — kept as its
 * own function (rather than a conditional spread) so the `hidden` field is
 * genuinely absent, not present-and-`false`, on the common unhidden path
 * (`ScopeOutcome`'s consumers/tests compare output sections by exact shape). */
function returnedMessageOutput(text: string, hidden: boolean): ExtensionActivityOutput {
	if (hidden) {
		return {
			kind: "returned-message",
			title: "Sent to model · hidden in terminal",
			text,
			hidden,
		};
	}
	return { kind: "returned-message", title: "Sent to model", text };
}

function mapContextResult<Result, HookEvent>(
	result: Result,
	hookEvent: HookEvent,
): ScopeOutcome {
	if (!isRecord(result) || !Array.isArray(result.messages)) return { ok: true };
	// §2.3: "context → messages not identical to the input messages" — a hook
	// that hands back the same messages it was given (by reference, or the
	// same content) made no change and is filtered out, the same "no-op hooks
	// never show" rule `systemPromptDiffOutput` applies to `before_agent_start`.
	// When the input isn't known (e.g. a test-built scope with no `hookEvent`)
	// this falls back to always reporting, matching the pre-diff behavior.
	const inputMessages =
		isRecord(hookEvent) && Array.isArray(hookEvent.messages)
			? hookEvent.messages
			: undefined;
	if (inputMessages !== undefined && messagesUnchanged(inputMessages, result.messages))
		return { ok: true };
	const count = result.messages.length;
	const text = `${count} message${count === 1 ? "" : "s"}`;
	return {
		ok: true,
		summary: `Replaced context (${text})`,
		output: [{ kind: "injected-messages", title: "Replaced context", text }],
	};
}

function messagesUnchanged(
	input: readonly unknown[],
	returned: readonly unknown[],
): boolean {
	if (input === returned) return true;
	if (input.length !== returned.length) return false;
	try {
		return JSON.stringify(input) === JSON.stringify(returned);
	} catch {
		// Unserializable content (e.g. a circular structure) — can't prove
		// they're the same, so report the change rather than silently drop it.
		return false;
	}
}

function mapToolCallResult<Result>(result: Result): ScopeOutcome {
	if (!isRecord(result) || result.block !== true) return { ok: true };
	const reason = isString(result.reason) ? result.reason : "Blocked";
	return {
		ok: true,
		summary: reason,
		output: [{ kind: "blocked", title: "Blocked tool call", text: reason }],
	};
}

function mapToolResultResult<Result, HookEvent>(
	result: Result,
	hookEvent: HookEvent,
): ScopeOutcome {
	if (!isRecord(result)) return { ok: true };
	// §2.3: "tool_result → changed content text" — content echoed back
	// unchanged is a no-op, the same rule `mapContextResult` applies.
	if (
		isRecord(hookEvent) &&
		Array.isArray(hookEvent.content) &&
		Array.isArray(result.content) &&
		messagesUnchanged(hookEvent.content, result.content)
	) {
		return { ok: true };
	}
	const text = extractTextContent(result.content);
	if (text === undefined) return { ok: true };
	return {
		ok: true,
		summary: "Modified tool result",
		output: [{ kind: "tool-content", title: "Modified tool result", text }],
	};
}

function mapInputResult<Result>(result: Result): ScopeOutcome {
	if (!isRecord(result) || !isString(result.action)) return { ok: true };
	if (result.action === "transform" && isString(result.text)) {
		return {
			ok: true,
			summary: "Transformed input",
			output: [
				{
					kind: "injected-messages",
					title: "Transformed input",
					text: result.text,
				},
			],
		};
	}
	if (result.action === "handled") return { ok: true, summary: "Handled input" };
	return { ok: true };
}

function messageContentText<Content>(content: Content): string | undefined {
	if (isString(content)) return content;
	return extractTextContent(content);
}

function extractTextContent<Content>(content: Content): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && isString(item.text))
			parts.push(item.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function describeError<Cause>(error: Cause): string {
	if (error instanceof Error) return error.message;
	if (isString(error)) return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

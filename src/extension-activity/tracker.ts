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
	#runActive = false;

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
		const mapped = mapOutcome(scope, outcome);
		this.#emit(this.#ledger.endTimedScope(scope.scopeId, now, mapped));
	}

	uiSignal(scope: InstrumentedScope, signal: UiSignal, now: number): void {
		if (scope.timed) {
			this.#emit(this.#ledger.observeUiInScope(scope.scopeId, signal, now));
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
		this.#emit(change);
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

	/** Drives the ledger's run-active window (§2.3's policy: a carrier signal
	 * only starts a new standalone activity `runGraceMs` past `agent_settled`
	 * for a not-yet-settled run) and, on becoming inactive, checks self-heal.
	 * The caller drives this from whatever it already uses to track
	 * streaming — an `agent_start`/`agent_settled` pair, `session.isStreaming`,
	 * or equivalent. */
	setRunActive(active: boolean, now: number): void {
		this.#runActive = active;
		if (!active) this.selfHeal(now, now);
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

	#scheduleScopePromotion(scopeId: string): void {
		const cancel = this.#scheduler.schedule(
			extensionActivityThresholds.hookPromotionMs,
			() => {
				this.#cancelers.delete(scopeId);
				if (!this.#ledger.isScopePending(scopeId)) return;
				this.#emit(this.#ledger.promoteScope(scopeId, this.#clock()));
			},
		);
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
		this.#sink(change);
	}
}

const channelCarrierKey = "!channel";

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
 * `transform`, and a tool's own `execute()` result. Every other timed event
 * (`agent_end`, `turn_end`, …) gets a generic "completed" outcome — a
 * specific mapping can be added the same way without touching the ledger.
 */
function mapOutcome(scope: InstrumentedScope, outcome: ScopeOutcomeRaw): ScopeOutcome {
	if (!outcome.ok) return { ok: false, error: describeError(outcome.error) };
	if (scope.trigger.kind === "tool") return mapToolOutcome(outcome.result);
	if (scope.trigger.kind === "hook")
		return mapHookOutcome(scope.trigger.event, outcome.result);
	return { ok: true };
}

function mapToolOutcome<Result>(result: Result): ScopeOutcome {
	if (!isRecord(result)) return { ok: true };
	const text = extractTextContent(result.content);
	if (result.isError === true) return { ok: false, error: text ?? "Tool call failed" };
	if (text === undefined) return { ok: true };
	return {
		ok: true,
		summary: text,
		output: [{ kind: "tool-content", title: "Tool result", text }],
	};
}

function mapHookOutcome<Result>(event: string, result: Result): ScopeOutcome {
	switch (event) {
		case "before_agent_start":
			return mapBeforeAgentStart(result);
		case "context":
		case "context_with_system":
			return mapContextResult(result);
		case "tool_call":
			return mapToolCallResult(result);
		case "tool_result":
			return mapToolResultResult(result);
		case "input":
			return mapInputResult(result);
		default:
			return { ok: true };
	}
}

function mapBeforeAgentStart<Result>(result: Result): ScopeOutcome {
	if (!isRecord(result)) return { ok: true };
	const messageRecord = isRecord(result.message) ? result.message : undefined;
	const message = messageRecord ? messageContentText(messageRecord.content) : undefined;
	// Vision Proxy (and JEV's `jev-decompose`) return their message with
	// `display: false` — never shown in terminal pi, so this is the only
	// place its text becomes visible at all (DESIGN-ext-activity.md's Vision
	// Proxy row: "Output = returned message text … (hidden:true)").
	const hidden = messageRecord?.display === false;
	const systemPrompt = isString(result.systemPrompt) ? result.systemPrompt : undefined;
	if (message === undefined && systemPrompt === undefined) return { ok: true };
	const output =
		message !== undefined
			? [returnedMessageOutput(message, hidden)]
			: [
					{
						kind: "system-prompt" as const,
						title: "Replaced system prompt",
						text: systemPrompt ?? "",
					},
				];
	return { ok: true, summary: message ?? "Replaced system prompt", output };
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

function mapContextResult<Result>(result: Result): ScopeOutcome {
	if (!isRecord(result) || !Array.isArray(result.messages)) return { ok: true };
	const count = result.messages.length;
	const text = `${count} message${count === 1 ? "" : "s"}`;
	return {
		ok: true,
		summary: `Replaced context (${text})`,
		output: [{ kind: "injected-messages", title: "Replaced context", text }],
	};
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

function mapToolResultResult<Result>(result: Result): ScopeOutcome {
	if (!isRecord(result)) return { ok: true };
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

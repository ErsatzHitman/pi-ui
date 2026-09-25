import type {
	ExtensionActivityOutput,
	ExtensionRef,
} from "../extension-activity-types.ts";

/**
 * A hook event whose scope is *timed* — it can be promoted to a `working`
 * activity if it runs long enough or raises a UI signal. Everything else is
 * a *carrier* scope: it only attributes `ctx.ui` calls to the right
 * extension, and never becomes an activity on its own (see
 * `DESIGN-ext-activity.md` §2.3 point 5).
 */
export const timedHookEvents: ReadonlySet<string> = new Set([
	"before_agent_start",
	"context",
	"context_with_system",
	"tool_call",
	"tool_result",
	"input",
	"user_bash",
	"turn_start",
	"turn_end",
	"agent_end",
	"agent_settled",
	"message_end",
	"session_compact",
	"before_provider_request",
]);

export function isTimedHookEvent(event: string): boolean {
	return timedHookEvents.has(event);
}

/**
 * Standing UI chrome — todo/plan-mode/minimal-status/@pi-archimedes/pi-fff/
 * btw — that must never become an activity, however long it stays open (see
 * §2.3's policy bullet and §3's "skipped" table).
 */
export type StandingDenyEntry =
	| Readonly<{ kind: "id"; extensionId: string; key?: string }>
	| Readonly<{ kind: "sourcePrefix"; prefix: string }>;

export const standingDenyList: readonly StandingDenyEntry[] = [
	{ kind: "id", extensionId: "todo" },
	{ kind: "id", extensionId: "plan-mode", key: "!mode" },
	{ kind: "id", extensionId: "minimal-status" },
	{ kind: "sourcePrefix", prefix: "@pi-archimedes/" },
	{ kind: "id", extensionId: "pi-fff" },
	{ kind: "id", extensionId: "btw" },
];

/**
 * Whether a `(extension, key)` UI signal is standing chrome that must render
 * exactly as it does today, never as an activity. Only meaningful for a
 * *carrier*-scope signal — a timed-hook or tool-scoped signal is already
 * attributed to a real run and is never standing.
 */
export function isStandingSignal(extension: ExtensionRef, key: string): boolean {
	return standingDenyList.some((entry) => {
		if (entry.kind === "sourcePrefix") return extension.source.includes(entry.prefix);
		if (entry.extensionId !== extension.id) return false;
		return entry.key === undefined || entry.key === key;
	});
}

/** Label overrides for extensions whose slug reads worse than a proper name
 * (`vision-proxy` → title-cased would be "Vision Proxy" anyway, but `pi-lsp`
 * would title-case to "Pi Lsp") — see `identity.ts`'s fallback. */
export const extensionLabelOverrides = {
	jev: "JEV",
	"vision-proxy": "Vision Proxy",
	advisor: "Advisor",
	"pi-lsp": "LSP",
	"pi-goal": "Goal",
	"pi-herdr-delegate": "Delegate",
} satisfies Readonly<Record<string, string>>;

/** Promotion thresholds and grace windows — all §2.3's "Policy" bullet. */
export const extensionActivityThresholds = {
	/** A timed hook scope promotes to `working` after this long unfinished. */
	hookPromotionMs: 750,
	/** A `setWidget`/`setStatus`/`setWorkingMessage` signal inside a scope
	 * promotes after this long, faster than a bare hook because a UI signal
	 * is itself evidence of real work. */
	uiPromotionMs: 250,
	/** Coalescing window for live widget frames (a panel can repaint at 10-30
	 * fps): at most one card patch per widget per window (§4.4 "Realtime"). */
	widgetFrameIntervalMs: 100,
	/** A custom `message_start` attaches to an extension's open-or-recently-
	 * finished activity within this window. */
	customMessageAttachWindowMs: 15000,
	/** How long after `agent_settled` a run is still considered "active" for
	 * carrier-scope UI signals to become standalone activities. */
	runGraceMs: 10000,
	/** A `{trigger:"ui"}` activity still open this long after the run settles
	 * self-heals to `done` and its `(ext,key)` is demoted to standing. */
	standingAfterSettleMs: 60000,
} as const;

/** Size caps — all §2.3's "Policy" bullet. */
export const extensionActivityCaps = {
	/** `progress`/`summary` line length, in UTF-16 code units. */
	progressCapChars: 200,
	/** Bytes (UTF-8) kept per `ExtensionActivityOutput.text` section. */
	outputSectionCapBytes: 16 * 1024,
	/** Bytes (UTF-8) kept across every output section of one activity. */
	totalOutputCapBytes: 32 * 1024,
	/** Activities kept in memory per runtime; oldest finished ones are
	 * dropped first (still persisted — see `persistence.ts`). */
	maxActivitiesInMemory: 200,
} as const;

/** Caps a one-line progress/summary string to `progressCapChars`, adding an
 * ellipsis when it was cut. Collapses embedded newlines to spaces first, since
 * this is always rendered on a single line. */
export function capProgressLine(text: string): string {
	const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
	if (oneLine.length <= extensionActivityCaps.progressCapChars) return oneLine;
	return `${oneLine.slice(0, extensionActivityCaps.progressCapChars - 1)}…`;
}

/** Caps one output section's text to `outputSectionCapBytes` (measured in
 * UTF-8 bytes, since the design's caps are byte budgets), reporting whether
 * it truncated. Never splits a UTF-16 surrogate pair. */
export type CapOutputTextResult = Readonly<{ text: string; truncated: boolean }>;

export function capOutputText(text: string): CapOutputTextResult {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(text);
	if (encoded.byteLength <= extensionActivityCaps.outputSectionCapBytes) {
		return { text, truncated: false };
	}
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const truncatedBytes = encoded.slice(0, extensionActivityCaps.outputSectionCapBytes);
	// `fatal: false` silently drops a trailing partial code point instead of
	// throwing, which is exactly the "never split a surrogate pair" behavior
	// wanted here.
	return { text: decoder.decode(truncatedBytes), truncated: true };
}

/**
 * Applies `totalOutputCapBytes` across a whole output array, in order: every
 * section up to the budget is kept verbatim, the section that crosses it is
 * cut to fit (marked `truncated`), and everything after it is dropped
 * entirely. Each section is still subject to `capOutputText`'s per-section
 * cap first.
 */
export function capOutputSections(
	sections: readonly ExtensionActivityOutput[],
): ExtensionActivityOutput[] {
	const encoder = new TextEncoder();
	const kept: ExtensionActivityOutput[] = [];
	let budget = extensionActivityCaps.totalOutputCapBytes;
	for (const section of sections) {
		if (budget <= 0) break;
		const { text: perSectionCapped, truncated: perSectionTruncated } = capOutputText(
			section.text,
		);
		const bytes = encoder.encode(perSectionCapped);
		if (bytes.byteLength <= budget) {
			const truncated = perSectionTruncated || section.truncated;
			kept.push(
				truncated
					? { ...section, text: perSectionCapped, truncated: true }
					: { ...section, text: perSectionCapped },
			);
			budget -= bytes.byteLength;
			continue;
		}
		const decoder = new TextDecoder("utf-8", { fatal: false });
		const cutText = decoder.decode(bytes.slice(0, budget));
		kept.push({ ...section, text: cutText, truncated: true });
		budget = 0;
	}
	return kept;
}

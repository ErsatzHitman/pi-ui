/**
 * Shared contract for the extension activity lifecycle feature (durable
 * "Called → Working → Output → Completed" cards for pi extensions).
 *
 * FROZEN: this is the one file every implementation stream (server, UI, fake
 * extensions/e2e) builds against. Do not widen or narrow these shapes without
 * updating every stream — see `DESIGN-ext-activity.md` §2.1 and §6.3.
 */

/** `CustomEntry.customType` this feature persists under. Terminal pi has no
 * renderer for it, so it stays invisible there and is never model context
 * (see the design's F13/F14). */
export const extensionActivityEntryType = "pi-ui.extension-activity";

/** Bump only with a matching `persistence.ts` migration; unknown versions are
 * ignored on load (see the design's persistence_test.ts assertions). */
export const extensionActivitySchemaVersion = 1;

/**
 * `started`: a signal was seen but the activity is still under its promotion
 * threshold — not yet rendered anywhere.
 * `working`: promoted, rendered, pink and pulsing.
 * `done` / `error` / `cancelled`: terminal states. The "Output/result" stage
 * is not its own state — output fills `progress`/`output` while `working`
 * and is kept after the activity finishes.
 */
export type ExtensionActivityState = "started" | "working" | "done" | "error" | "cancelled";

export function isExtensionActivityState(value: unknown): value is ExtensionActivityState {
	return (
		value === "started" ||
		value === "working" ||
		value === "done" ||
		value === "error" ||
		value === "cancelled"
	);
}

/** Terminal states — once here, an activity never re-opens. */
export function isTerminalExtensionActivityState(state: ExtensionActivityState): boolean {
	return state === "done" || state === "error" || state === "cancelled";
}

export type ExtensionRef = Readonly<{
	/** Stable slug: `"jev"`, `"vision-proxy"`, `"advisor"`, `"pi-lsp"`, … */
	id: string;
	/** Display label: `"JEV"`, `"Vision Proxy"`, `"Advisor"`, `"LSP"`, … */
	label: string;
	/** `Extension.resolvedPath` — diagnostics only, never rendered. */
	path: string;
	/** `SourceInfo.source` (`"local"`, `"npm:@narumitw/pi-lsp"`, …). */
	source: string;
}>;

export type ExtensionActivityTrigger =
	| { kind: "hook"; event: string }
	| { kind: "tool"; toolName: string; toolCallId?: string }
	| { kind: "command"; name: string }
	| { kind: "shortcut"; key: string }
	| { kind: "ui"; signal: "status" | "widget" | "working"; key: string };

export function extensionActivityTriggerLabel(trigger: ExtensionActivityTrigger): string {
	switch (trigger.kind) {
		case "hook":
			return trigger.event;
		case "tool":
			return trigger.toolName;
		case "command":
			return `/${trigger.name}`;
		case "shortcut":
			return trigger.key;
		case "ui":
			return `${trigger.signal}:${trigger.key}`;
	}
}

export type ExtensionActivityOutputKind =
	| "returned-message"
	| "system-prompt"
	| "injected-messages"
	| "blocked"
	| "tool-content"
	| "panel"
	| "status"
	| "notice"
	| "custom-message"
	| "error";

export type ExtensionActivityOutput = Readonly<{
	kind: ExtensionActivityOutputKind;
	/** e.g. "Sent to model", "Panel (final frame)", "Blocked launch". */
	title: string;
	/** Plain text, ANSI-stripped, capped per `policy.ts`'s `outputSectionCapBytes`. */
	text: string;
	/** A payload the extension marked `display:false` / never shown in terminal pi. */
	hidden?: boolean;
	truncated?: boolean;
}>;

export type ExtensionActivity = Readonly<{
	v: 1;
	/** `"xa-" + crypto.randomUUID()`; stable across persistence. */
	id: string;
	extension: ExtensionRef;
	trigger: ExtensionActivityTrigger;
	/** "Consult", "before_agent_start", a tool's title, the first status text, … */
	title: string;
	state: ExtensionActivityState;
	/** epoch ms — "Called". */
	startedAt: number;
	/** epoch ms — promotion time, "Currently working". */
	workingAt?: number;
	/** epoch ms — "Completed". */
	finishedAt?: number;
	/** Latest one-line progress, capped by `policy.ts`'s `progressCapChars`. */
	progress?: string;
	/** One-line result — "Output/result" — kept visible after completion. */
	summary?: string;
	/** Full output; total capped by `policy.ts`'s `totalOutputCapBytes`. */
	output: readonly ExtensionActivityOutput[];
	error?: string;
	/** Set when this activity folds into a tool card as a step. */
	anchor?: Readonly<{ toolCallId: string }>;
	/** Session leaf id at start — links back to the turn. */
	turnEntryId?: string;
}>;

/** Render-side view: adds a formatted duration. Never persisted. */
export type ExtensionActivityView = ExtensionActivity &
	Readonly<{ durationText?: string }>;

/** Prompt-strip chip (AppStore slice). */
export type ExtensionActivityChip = Readonly<{
	id: string;
	extensionLabel: string;
	progress?: string;
	state: "started" | "working";
	/** Transcript message to scroll to when the chip is clicked. */
	anchorMessageId?: string;
}>;

/** Persisted `CustomEntry` payload — see `persistence.ts`. */
export type ExtensionActivityEntryData = Readonly<{
	v: 1;
	phase: "start" | "finish";
	activity: ExtensionActivity;
}>;

export function isExtensionActivityEntryData(
	value: unknown,
): value is ExtensionActivityEntryData {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.v === extensionActivitySchemaVersion &&
		(record.phase === "start" || record.phase === "finish") &&
		typeof record.activity === "object" &&
		record.activity !== null
	);
}

// Shared contract for the durable extension-activity lifecycle feature.
// Copied verbatim from DESIGN-ext-activity.md §2.1 (frozen shared contract).
// Owned by stream A (server: activity model, signal capture, persistence);
// stream B (UI) and stream C (fake extensions/e2e) code against this file
// without modifying it. If stream A has not yet committed its own copy when
// a dependent stream starts, that stream copies this file verbatim so it can
// build against the contract; the merger reconciles duplicate copies.

export const extensionActivityEntryType = "pi-ui.extension-activity"; // CustomEntry.customType
export const extensionActivitySchemaVersion = 1;

export type ExtensionActivityState =
	| "started"
	| "working"
	| "done"
	| "error"
	| "cancelled";

export type ExtensionRef = Readonly<{
	id: string; // stable slug: "jev" | "vision-proxy" | "advisor" | "pi-lsp" | …
	label: string; // display: "JEV" | "Vision Proxy" | "Advisor" | "LSP" …
	path: string; // Extension.resolvedPath (diagnostics only; not rendered)
	source: string; // SourceInfo.source ("local", "npm:@narumitw/pi-lsp", …)
}>;

export type ExtensionActivityTrigger =
	| { kind: "hook"; event: string } // before_agent_start, context, tool_call, tool_result, agent_settled, input, …
	| { kind: "tool"; toolName: string } // execute() of a tool this extension registered
	| { kind: "command"; name: string } // UI signals raised from a /command
	| { kind: "shortcut"; key: string }
	| { kind: "ui"; signal: "status" | "widget" | "working"; key: string }; // run-scoped UI signal with no timed scope

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
	title: string; // "Sent to model", "Panel (final frame)", "Blocked launch", …
	text: string; // plain text, ANSI-stripped, capped 16 KiB per section
	hidden?: boolean; // payload the extension marked display:false / never shown in terminal
	truncated?: boolean;
}>;

export type ExtensionActivity = Readonly<{
	v: 1;
	id: string; // "xa-" + crypto.randomUUID(); stable across persistence
	extension: ExtensionRef;
	trigger: ExtensionActivityTrigger;
	title: string; // "Consult", "before_agent_start", tool title, first status text …
	state: ExtensionActivityState;
	startedAt: number; // epoch ms — "Called"
	workingAt?: number; // promotion time — "Currently working"
	finishedAt?: number; // "Completed"
	progress?: string; // latest one-line progress, ≤ 200 chars
	summary?: string; // one-line result, ≤ 200 chars — "Output/result"
	output: readonly ExtensionActivityOutput[]; // full output; total ≤ 32 KiB
	error?: string;
	anchor?: Readonly<{ toolCallId: string }>; // folded into that tool's card
	turnEntryId?: string; // session leaf id at start — link to the turn
}>;

/** Render-side view (adds formatted duration; never persisted). */
export type ExtensionActivityView = ExtensionActivity &
	Readonly<{ durationText?: string }>;

/** Prompt-strip chip (AppStore slice). */
export type ExtensionActivityChip = Readonly<{
	id: string;
	extensionLabel: string;
	progress?: string;
	state: "started" | "working";
	anchorMessageId?: string; // transcript message to scroll to
}>;

/** Persisted CustomEntry payload. */
export type ExtensionActivityEntryData = Readonly<{
	v: 1;
	phase: "start" | "finish";
	activity: ExtensionActivity;
}>;

// Rendering for the durable extension-activity lifecycle (DESIGN-ext-activity.md §4).
// Rendering only — this stream never touches signal capture, the tracker or
// persistence (owned by stream A); it turns `ExtensionActivityView`/
// `ExtensionActivityChip` values (already computed) into markup that reuses
// pi-ui's existing tool-card/context-details primitives.
import type {
	ExtensionActivityChip,
	ExtensionActivityOutput,
	ExtensionActivityState,
	ExtensionActivityTrigger,
	ExtensionActivityView,
} from "../extension-activity-types.ts";
import type { AppMessage } from "./render-state.ts";
import { StatusDot } from "./status-dot.tsx";
import { syncHtml } from "./sync-html.ts";

type ActivityDotState = "running" | "success" | "error";

function activityDotState(state: ExtensionActivityState): ActivityDotState {
	if (state === "working" || state === "started") return "running";
	if (state === "error") return "error";
	return "success"; // done, cancelled (cancelled is muted via [data-activity-state] CSS)
}

function activityStateLabel(state: ExtensionActivityState): string {
	switch (state) {
		case "started":
			return "Called";
		case "working":
			return "Working";
		case "done":
			return "Done";
		case "error":
			return "Failed";
		case "cancelled":
			return "Stopped";
	}
}

/** The `<summary>`'s trigger meta text, e.g. "before_agent_start", "fake_jev_consult". */
function triggerMeta(trigger: ExtensionActivityTrigger): string {
	switch (trigger.kind) {
		case "hook":
			return trigger.event;
		case "tool":
			return trigger.toolName;
		case "command":
			return trigger.name;
		case "shortcut":
			return trigger.key;
		case "ui":
			return trigger.key;
	}
}

/** One `<section>` of an activity's captured output, collapsed by default (§4.2). */
function renderActivityOutputSection(output: ExtensionActivityOutput): string {
	return syncHtml(
		<section
			class="ext-activity-section"
			data-output-kind={output.kind}
			data-hidden-payload={output.hidden ? "true" : undefined}
		>
			<h4 class="fine-print">
				{output.hidden ? `${output.title} · hidden in terminal` : output.title}
			</h4>
			<pre class="ext-activity-output-text" safe>
				{output.text}
			</pre>
			{output.truncated && (
				<p class="fine-print ext-activity-truncated">Truncated</p>
			)}
		</section>,
	);
}

/** The progress/summary line under the summary row: live progress while working,
 * the one-line result once finished — the "kept visible" contract (§0, §4.2). */
function activityLineText(activity: ExtensionActivityView): string | undefined {
	if (activity.state === "working" || activity.state === "started") {
		return activity.progress;
	}
	if (activity.state === "error") return activity.error ?? activity.summary;
	return activity.summary ?? activity.progress;
}

/** Shared card body (summary row + collapsible output), used by both the standalone
 * card and each tool-card step — same markup, different wrapping element (§4.2). */
function renderActivityDetails(activity: ExtensionActivityView): string {
	const dotState = activityDotState(activity.state);
	const lineText = activityLineText(activity);
	const openByDefault = activity.state === "error";
	return syncHtml(
		<details
			class="context-details ext-activity-details"
			data-preserve-attr="open"
			open={openByDefault}
		>
			<summary class="context-summary ext-activity-summary">
				<StatusDot
					class="tool-state-dot"
					runningClass="status-dot-active"
					state={dotState}
					label={activityStateLabel(activity.state)}
				/>
				<span class="badge ext-activity-ext" data-variant="activity" safe>
					{activity.extension.label}
				</span>
				<span class="context-title">
					<span safe>{activity.title}</span>
					<span class="context-meta" safe>
						{triggerMeta(activity.trigger)}
					</span>
				</span>
				<span class="ext-activity-state" data-activity-state-text safe>
					{activityStateLabel(activity.state)}
				</span>
				{activity.durationText && (
					<span class="tool-meta" safe>
						{activity.durationText}
					</span>
				)}
			</summary>
			{lineText && (
				<p class="ext-activity-progress" safe>
					{lineText}
				</p>
			)}
			{activity.output.length > 0 && (
				<div
					class="tool-output-surface ext-activity-output"
					data-show="!$_toolOutputHidden"
				>
					{activity.output.map((output) => renderActivityOutputSection(output))}
				</div>
			)}
		</details>,
	);
}

/** The minimal-mode one-line summary (Q4's default — the card stays visible,
 * compact, per `DESIGN-ext-activity.md` §4.4). */
function renderActivityMinimalSummary(activity: ExtensionActivityView): string {
	const lineText = activityLineText(activity);
	return syncHtml(
		<p class="ext-activity-minimal-summary">
			<StatusDot
				class="tool-state-dot"
				runningClass="status-dot-active"
				state={activityDotState(activity.state)}
				label={activityStateLabel(activity.state)}
			/>
			<span class="ext-activity-minimal-content">
				<span class="badge ext-activity-ext" data-variant="activity" safe>
					{activity.extension.label}
				</span>
				<span safe>{activity.title}</span>
				{lineText && (
					<span class="context-meta" safe>
						{lineText}
					</span>
				)}
			</span>
		</p>,
	);
}

/** Standalone `.message-ext-activity` card: `role: "extension-activity"` (§4.2). */
export function renderExtensionActivityMessage(message: AppMessage): string {
	const activity = message.activities?.[0];
	if (!activity) return "";
	return syncHtml(
		<article
			class="message message-tool tool-timeline-item message-ext-activity"
			data-message-id={message.id}
			data-activity-id={activity.id}
			data-activity-state={activity.state}
			data-activity-extension={activity.extension.id}
			data-activity-trigger={activity.trigger.kind}
			aria-busy={activity.state === "working" ? "true" : undefined}
		>
			<div data-show="!$_minimalMode">{renderActivityDetails(activity)}</div>
			<div data-show="$_minimalMode">{renderActivityMinimalSummary(activity)}</div>
		</article>,
	);
}

/** Tool-card steps: an `<ol>` of extension-activity steps folded into the owning
 * tool's card, placed right after `.tool-header` (§4.2). Zero activities → "". */
export function renderExtensionActivitySteps(
	activities: readonly ExtensionActivityView[] | undefined,
): string {
	if (!activities || activities.length === 0) return "";
	return syncHtml(
		<ol class="ext-activity-steps">
			{activities.map((activity) => (
				<li
					class="tool-timeline-item ext-activity-step"
					data-activity-id={activity.id}
					data-activity-state={activity.state}
					data-activity-extension={activity.extension.id}
					data-activity-trigger={activity.trigger.kind}
					aria-busy={activity.state === "working" ? "true" : undefined}
				>
					{renderActivityDetails(activity)}
				</li>
			))}
		</ol>,
	);
}

/** The pink pulsing chip row in `#prompt-status` — one per open (started/working)
 * activity, clicking scrolls to its card (§4.1 point 2). */
export function renderExtensionActivityChips(
	chips: readonly ExtensionActivityChip[],
): string {
	if (chips.length === 0) return "";
	return syncHtml(
		<span class="ext-activity-chip-row" id="ext-activity-chips">
			{chips.map((chip) => (
				<button
					type="button"
					class="badge ext-activity-chip"
					data-variant="activity"
					data-activity-chip-id={chip.id}
					data-activity-chip-state={chip.state}
					aria-label={`${chip.extensionLabel} working${
						chip.progress ? `: ${chip.progress}` : ""
					}`}
					data-on:click={
						chip.anchorMessageId
							? `document.querySelector('[data-message-id="${chip.anchorMessageId}"]')?.scrollIntoView({behavior:"smooth",block:"center"})`
							: undefined
					}
				>
					<StatusDot
						class="tool-state-dot"
						runningClass="status-dot-active"
						state="running"
						label="Working"
					/>
					<span class="ext-activity-chip-label" safe>
						{chip.extensionLabel}
					</span>
					{chip.progress && (
						<span class="ext-activity-chip-progress" safe>
							{chip.progress}
						</span>
					)}
				</button>
			))}
		</span>,
	);
}

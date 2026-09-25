import { formatDuration } from "../agent/tool-presentation.ts";
import type {
	ExtensionActivity,
	ExtensionActivityTrigger,
	ExtensionActivityView,
} from "../extension-activity-types.ts";

/**
 * Render-side helpers shared by every consumer of a persisted/live
 * `ExtensionActivity` — `transcript-projector.ts` (replay) and
 * `runtime-controller.ts` (live updates) both need the exact same
 * text/state/duration derivation, so it lives here once instead of twice.
 */
export function toExtensionActivityView(
	activity: ExtensionActivity,
): ExtensionActivityView {
	const durationText = formatActivityDuration(activity);
	return durationText ? { ...activity, durationText } : activity;
}

/** `undefined` while the activity hasn't finished yet — no duration to show.
 * Measured from "Called" (`startedAt`), not the later promotion time, and
 * formatted exactly like a tool card's duration (§4.2). */
export function formatActivityDuration(activity: ExtensionActivity): string | undefined {
	if (activity.finishedAt === undefined) return undefined;
	const duration = formatDuration(
		Math.max(0, activity.finishedAt - activity.startedAt),
	);
	// Same rule as `toolEndMeta`: a "0.0s" badge says nothing.
	return duration === "0.0s" ? undefined : duration;
}

/** The message's one-line text: the result summary once there is one, else
 * the latest progress line, else the activity's own title. */
export function activityMessageText(activity: ExtensionActivity): string {
	return activity.summary ?? activity.progress ?? activity.title;
}

/**
 * Merges one activity's view into a tool card's `activities` step list,
 * keyed by `id` — an anchored `ExtensionActivity` (`anchor.toolCallId` set)
 * folds into the owning tool's own `TranscriptMessage` as a step instead of
 * a standalone `role: "extension-activity"` card (DESIGN-ext-activity.md
 * §2.4 "Anchored"). Both `runtime-controller.ts`'s live path and
 * `transcript-projector.ts`'s replay path call this so a re-run of the same
 * scope (JEV's pre-launch gate, Vision Proxy's `tool_result` rewrite, …)
 * patches its own step in place instead of duplicating it.
 */
export function mergeActivitySteps(
	existing: readonly ExtensionActivityView[] | undefined,
	step: ExtensionActivityView,
): ExtensionActivityView[] {
	const steps = existing ? [...existing] : [];
	const index = steps.findIndex((candidate) => candidate.id === step.id);
	if (index === -1) steps.push(step);
	else steps[index] = step;
	return steps;
}

/** The trigger's one-line meta text, e.g. "before_agent_start", "fake_jev_consult"
 * — shared by the card's `<summary>` (`ui/extension-activity.tsx`) and the Live
 * Workspace Activity-tab log lines (`live-workspace-controller.ts`), which need
 * the identical text with no JSX dependency. */
export function triggerMeta(trigger: ExtensionActivityTrigger): string {
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

/**
 * One Live Workspace Activity-tab log line (`LiveWorkspaceController
 * .recordExtensionActivity`, DESIGN-ext-activity.md §4.1.3): extension
 * label, trigger and title on both edges, plus duration and a result
 * summary once the activity has one to show:
 *   "JEV started Consult · before_agent_start"
 *   "JEV finished Consult · before_agent_start (2.1s) — Consulted jev"
 * A `finish` line with no duration/summary yet (still `working` when the
 * caller wants a line right now, e.g. `cancelAll`'s synthetic finish) just
 * omits the trailing parenthetical rather than printing an empty one.
 */
export function formatExtensionActivityLogLine(
	phase: "start" | "finish",
	activity: ExtensionActivity,
): string {
	const verb = phase === "start" ? "started" : "finished";
	const head = `${activity.extension.label} ${verb} ${activity.title} · ${triggerMeta(activity.trigger)}`;
	if (phase === "start") return head;
	const duration = formatActivityDuration(activity);
	const summary = activity.summary;
	const tail = [
		duration ? `(${duration})` : undefined,
		summary ? `— ${summary}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");
	return tail ? `${head} ${tail}` : head;
}

/** Maps the activity's own five-state machine down to `TranscriptMessage`'s
 * three-value `state` (`"running" | "success" | "error"`): `cancelled` reads
 * as `"error"` too — it is an abnormal outcome, not a clean finish. */
export function activityMessageState(
	activity: ExtensionActivity,
): "running" | "success" | "error" {
	if (activity.state === "error" || activity.state === "cancelled") return "error";
	if (activity.state === "started" || activity.state === "working") return "running";
	return "success";
}

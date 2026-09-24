import type {
	ExtensionActivity,
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

/** `undefined` while the activity hasn't finished yet — no duration to show. */
export function formatActivityDuration(activity: ExtensionActivity): string | undefined {
	if (activity.finishedAt === undefined) return undefined;
	const start = activity.workingAt ?? activity.startedAt;
	const ms = Math.max(0, activity.finishedAt - start);
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The message's one-line text: the result summary once there is one, else
 * the latest progress line, else the activity's own title. */
export function activityMessageText(activity: ExtensionActivity): string {
	return activity.summary ?? activity.progress ?? activity.title;
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

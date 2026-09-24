import {
	extensionActivityEntryType,
	extensionActivitySchemaVersion,
	isExtensionActivityEntryData,
	isTerminalExtensionActivityState,
	type ExtensionActivity,
	type ExtensionActivityEntryData,
} from "../extension-activity-types.ts";

export { extensionActivityEntryType };

/** Never persist a `started` (sub-threshold, invisible) activity — see
 * `DESIGN-ext-activity.md` §2.4's persistence bullet. */
export function isPersistable(activity: ExtensionActivity): boolean {
	return activity.state !== "started";
}

/** Builds the `CustomEntry` payload for `session.appendEntry`/
 * `sessionManager.appendCustomEntry(extensionActivityEntryType, …)`. A
 * `"start"` entry is written once, at promotion; a `"finish"` entry is
 * (re)written at every terminal transition or output refresh — the last
 * write for a given `activity.id` wins on replay (`rebuildActivitiesFromEntries`). */
export function encodeActivityEntry(
	phase: "start" | "finish",
	activity: ExtensionActivity,
): ExtensionActivityEntryData {
	return { v: extensionActivitySchemaVersion, phase, activity };
}

/**
 * Narrows one raw `CustomEntry.data` payload to a well-formed `v: 1` entry.
 * `false` for anything else (an unknown schema version, a `CustomEntry` of a
 * different `customType` the caller passed by mistake, or junk) — an unknown
 * version is ignored, never thrown on. A type predicate (rather than
 * returning `ExtensionActivityEntryData | undefined`) so its own `payload`
 * parameter is the guard's subject, not unparsed `unknown` input — see
 * `isExtensionActivityEntryData`, which this only re-exports under this
 * module's naming.
 */
export function decodeActivityEntry(
	payload: unknown,
): payload is ExtensionActivityEntryData {
	return isExtensionActivityEntryData(payload);
}

export type RebuiltActivity = Readonly<{
	activity: ExtensionActivity;
	/** Index, in `payloads`, of the first entry seen for this activity —
	 * a standalone card is re-emitted at this position (§2.4's "Projection on
	 * load" bullet); an anchored one instead attaches to its `anchor.toolCallId`'s
	 * projected tool message, regardless of this index. */
	firstSeenIndex: number;
}>;

/**
 * Merges every `pi-ui.extension-activity` `CustomEntry` payload found on a
 * session branch (in transcript order) back into the activities they
 * describe, for `transcript-projector.ts` to re-render on load, session
 * switch, restart or `/resume` (§2.4). Per `activity.id`: the *last* phase
 * seen wins (so a re-written `"finish"` after a late panel refresh replaces
 * the earlier one), and an activity that only ever got a `"start"` entry
 * (pi-ui exited mid-run) is reported `cancelled` with an "Interrupted"
 * summary instead of staying `working` forever.
 *
 * Non-activity entries (a different `customType`, or anything `decodeActivityEntry`
 * can't parse) are silently skipped, exactly like `transcript-projector.ts`'s
 * existing "no renderer for this `CustomEntry`" behavior (F13/F14) — this
 * function only ever narrows `payloads`, it never validates the wider entry
 * stream.
 */
export function rebuildActivitiesFromEntries(
	payloads: readonly unknown[],
): readonly RebuiltActivity[] {
	const byId = new Map<
		string,
		{ activity: ExtensionActivity; firstSeenIndex: number; sawFinish: boolean }
	>();
	payloads.forEach((payload, index) => {
		if (!decodeActivityEntry(payload)) return;
		const id = payload.activity.id;
		const existing = byId.get(id);
		if (!existing) {
			byId.set(id, {
				activity: payload.activity,
				firstSeenIndex: index,
				sawFinish: payload.phase === "finish",
			});
			return;
		}
		existing.activity = payload.activity;
		if (payload.phase === "finish") existing.sawFinish = true;
	});
	return [...byId.values()]
		.map(({ activity, firstSeenIndex, sawFinish }) => ({
			activity: sawFinish ? activity : interruptedActivity(activity),
			firstSeenIndex,
		}))
		.sort((a, b) => a.firstSeenIndex - b.firstSeenIndex);
}

function interruptedActivity(activity: ExtensionActivity): ExtensionActivity {
	if (isTerminalExtensionActivityState(activity.state)) return activity;
	const finishedAt = activity.finishedAt ?? activity.startedAt;
	const summary = activity.summary ?? "Interrupted (pi-ui stopped)";
	return { ...activity, state: "cancelled", finishedAt, summary };
}

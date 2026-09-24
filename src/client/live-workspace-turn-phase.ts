/**
 * Pure phase-transition logic behind `watchTurnPhase()` in `live-workspace.ts`, split out so it
 * can be unit tested without faking `MutationObserver`/`document` (mirrors
 * `static/app/notifications.js`'s `createSessionNotifier` split).
 *
 * RM1 audit open issue 3: the "Now" tab's turn banner phase also clears when the *foreground
 * session itself changes* (`/new`, switching sessions — see
 * `LiveWorkspaceController.resetForegroundSession`), not only when a turn actually finishes. A
 * bare "running/retrying → undefined" transition can't tell those apart, so it fired a false
 * "Turn finished" notification on every session switch made while a turn was running.
 *
 * The fix: remember which session was running, and only treat "phase cleared" as a finish when
 * the current session is still that same one. `live-workspace.tsx`'s `renderLiveWorkspaceNowSection`
 * carries the session path purely for this client-side disambiguation (never read server-side).
 */
export function createTurnPhaseWatcher(options: {
	readPhase: () => string | undefined;
	readSessionPath: () => string | undefined;
	notify: (title: string, body: string) => void;
}) {
	let previousPhase = options.readPhase();
	let runningSessionPath =
		previousPhase === "running" || previousPhase === "retrying"
			? options.readSessionPath()
			: undefined;

	function check(): void {
		const phase = options.readPhase();
		if (phase === previousPhase) return;
		const previous = previousPhase;
		const previousSession = runningSessionPath;
		previousPhase = phase;
		if (phase === "running" || phase === "retrying") {
			runningSessionPath = options.readSessionPath();
		}
		if (phase === "waiting-for-extension") {
			options.notify("pi is waiting for input", "Open pi-ui to respond.");
		} else if (
			phase === undefined &&
			(previous === "running" || previous === "retrying") &&
			options.readSessionPath() === previousSession
		) {
			options.notify("Turn finished", "pi has finished the current turn.");
		}
	}

	return { check };
}

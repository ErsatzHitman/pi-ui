/**
 * Client-side companion for the Live Workspace pane: ticks the "Now" and "Activity" tabs'
 * relative/elapsed-time labels (server-rendered timestamps go stale the moment the page sits
 * idle) and moves focus in and out of the pane when it opens and closes, mirroring
 * `workspace-review.ts`'s `applyOpen` pattern without that file's git-availability gating,
 * which Live Workspace has no equivalent of.
 */

const tickIntervalMs = 1000;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}

function tickElapsed(): void {
	const now = Date.now();
	for (const element of document.querySelectorAll<HTMLElement>(
		"[data-live-workspace-elapsed]",
	)) {
		const at = Number(element.dataset.liveWorkspaceElapsed);
		if (!Number.isFinite(at)) continue;
		element.textContent = formatElapsed(now - at);
	}
}

function bindLiveWorkspace() {
	let open = false;
	const applyOpen = (next: boolean) => {
		if (next === open) return;
		open = next;
		const pane = document.getElementById("live-workspace");
		if (!pane) return;
		if (open) {
			requestAnimationFrame(() => {
				pane.querySelector<HTMLElement>(".live-workspace-tab-button")?.focus();
			});
		} else if (pane.contains(document.activeElement)) {
			document.getElementById("live-workspace-toggle")?.focus();
		}
	};
	return { applyOpen };
}

window.piUi.liveWorkspace = bindLiveWorkspace();

tickElapsed();
setInterval(tickElapsed, tickIntervalMs);

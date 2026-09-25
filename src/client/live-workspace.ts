/**
 * Client-side companion for the Live Workspace pane: ticks the "Now" and "Activity" tabs'
 * relative/elapsed-time labels and the retry countdown (server-rendered timestamps go stale
 * the moment the page sits idle — A#26) and moves focus in and out of the pane when it opens
 * and closes, mirroring `workspace-review.ts`'s `applyOpen` pattern without that file's
 * git-availability gating, which Live Workspace has no equivalent of.
 */

import {
	duration,
	easing,
	reducedMotion,
	staggerCap,
	staggerStepMs,
} from "../../static/app/motion.js";
import { formatRetryCountdown } from "../live-workspace-types.ts";
import { bindLiveWorkspace } from "./live-workspace-open.ts";
import {
	createTurnPhaseWatcher,
	turnNotificationWanted,
} from "./live-workspace-turn-phase.ts";
import {
	needsNotificationPermission,
	requestNotificationPermission,
} from "./notification-permission.ts";
import { bindPaneMotion } from "./pane-motion.ts";

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
		const text = formatElapsed(now - at);
		// Only write on change: the MutationObserver below re-ticks on every DOM change, and an
		// unconditional write would itself count as one.
		if (element.textContent !== text) element.textContent = text;
	}
	for (const element of document.querySelectorAll<HTMLElement>(
		"[data-live-workspace-retry-at]",
	)) {
		const at = Number(element.dataset.liveWorkspaceRetryAt);
		if (!Number.isFinite(at)) continue;
		const text = formatRetryCountdown(at - now);
		if (element.textContent !== text) element.textContent = text;
	}
}

/** Reads the toggle's own `aria-pressed`, which the server keeps in sync with the persisted
 * `liveWorkspacePreferences.notifications` signal — avoids a second source of truth here.
 * Exported on `window.piUi.liveWorkspace` so `static/app/notifications.js`'s background-session
 * notifier (round RM1 "notifications") reads the same opt-in instead of a second one. */
export function notificationsOptedIn(): boolean {
	return (
		document
			.getElementById("live-workspace-notifications-toggle")
			?.getAttribute("aria-pressed") === "true"
	);
}

/**
 * Opt-in Notification API integration (Live Workspace depth, Round 2): tells the person a turn
 * finished or is waiting for extension input while they're on another tab or app, so they don't
 * have to keep pi-ui in view. Silently does nothing without permission or opt-in, and never on
 * a visible page — no point interrupting someone already looking at the answer.
 */
function notifyTurnEvent(title: string, body: string): void {
	if (
		typeof Notification === "undefined" ||
		!turnNotificationWanted(title, {
			hidden: document.hidden,
			optedIn: notificationsOptedIn(),
			permission: Notification.permission,
			pushCovers: Boolean(window.piUi.push?.covers()),
		})
	) {
		return;
	}
	try {
		const notification = new Notification(title, {
			body,
			tag: "pi-ui-live-workspace-turn",
		});
		notification.addEventListener("click", () => {
			window.focus();
			notification.close();
		});
	} catch {
		// Some embedders (webviews, permission edge cases) can still throw here; never let a
		// notification failure break the app.
	}
}

/** Watches the always-rendered "Now" tab turn banner for phase transitions, independent of
 * whether the pane itself is open — notifications should fire even while it's closed. Also
 * watches `data-live-workspace-session` (see `live-workspace-turn-phase.ts`) so a session switch
 * while a turn is running is never mistaken for that turn finishing. */
function watchTurnPhase(): void {
	const now = document.getElementById("live-workspace-now");
	if (!now) return;
	const watcher = createTurnPhaseWatcher({
		readPhase: () =>
			now.querySelector<HTMLElement>(".live-workspace-turn-banner")?.dataset
				.turnPhase,
		readSessionPath: () => now.dataset.liveWorkspaceSession,
		notify: notifyTurnEvent,
	});
	new MutationObserver(() => watcher.check()).observe(now, {
		attributeFilter: ["data-turn-phase", "data-live-workspace-session"],
		attributes: true,
		childList: true,
		subtree: true,
	});
}

/** Rows and blocks that settle in when the server adds them (flow-spec B8). */
const enterSelector =
	".live-workspace-activity-row, .live-workspace-agent-row, .live-workspace-tool-row, " +
	".live-workspace-turn-banner, .live-workspace-agent-list, .live-workspace-tool-list, " +
	".live-workspace-activity-list, #live-workspace-workflow-journal > *, #live-workspace-delegate-ledger > *";

/**
 * Entry for Live Workspace rows (flow-spec B8, motion round 2). Rows are id-keyed
 * (`lw-tool-…`, `lw-agent-…`, `lw-activity-…`), so a morph inserts exactly the new row and
 * leaves the others in place; only an id this pane has never shown animates, and only inside
 * the visible tab of an open pane, so a tab reveal or a re-patch never replays it. The first
 * few fresh rows of a burst stagger (40ms, at most 4). Exits stay instant (flow-spec §9).
 */
function watchRowEntries(): void {
	const pane = document.getElementById("live-workspace");
	if (!pane) return;
	const seen = new Set(
		[...pane.querySelectorAll<HTMLElement>("[id^='lw-']")].map(
			(element) => element.id,
		),
	);
	new MutationObserver((records) => {
		const open = document
			.getElementById("app")
			?.classList.contains("live-workspace-open");
		const fresh: HTMLElement[] = [];
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (!(node instanceof HTMLElement) || !node.matches(enterSelector))
					continue;
				if (node.id && seen.has(node.id)) continue;
				if (node.id) seen.add(node.id);
				if (open && node.closest("section")?.checkVisibility()) fresh.push(node);
			}
		}
		const reduce = reducedMotion();
		for (const [index, element] of fresh.slice(0, staggerCap).entries()) {
			element.animate(
				reduce
					? [{ opacity: 0 }, { opacity: 1 }]
					: [
							{ opacity: 0, translate: "0 -0.25rem" },
							{ opacity: 1, translate: "0 0" },
						],
				{
					duration: reduce ? duration.sm : duration.md,
					delay: index * staggerStepMs,
					easing: easing.out,
					fill: "backwards",
				},
			);
		}
	}).observe(pane, { childList: true, subtree: true });
}

window.piUi.liveWorkspace = {
	applyOpen: bindLiveWorkspace().applyOpen,
	requestNotificationPermission,
	needsNotificationPermission,
	notificationsOptedIn,
};

watchTurnPhase();
watchRowEntries();
bindPaneMotion();
tickElapsed();
setInterval(tickElapsed, tickIntervalMs);
// Every SSE patch of a tab re-renders its elapsed/countdown spans empty (the server only
// renders the timestamp); fill them right away instead of leaving them blank until the next
// 1s tick, which made active-tool and activity times flicker on every streamed update.
let tickQueued = false;
const livePane = document.getElementById("live-workspace");
if (livePane) {
	new MutationObserver(() => {
		if (tickQueued) return;
		tickQueued = true;
		queueMicrotask(() => {
			tickQueued = false;
			tickElapsed();
		});
	}).observe(livePane, { childList: true, subtree: true });
}

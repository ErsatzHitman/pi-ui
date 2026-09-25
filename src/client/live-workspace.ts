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
	ghostExit,
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
	".live-workspace-activity-list, .live-workspace-empty, " +
	"#live-workspace-workflow-journal > *, #live-workspace-delegate-ledger > *";

/** A list arriving whole (the first rows replace the empty text) staggers its rows (LW-V2-06). */
const listSelector =
	".live-workspace-agent-list, .live-workspace-tool-list, .live-workspace-activity-list";

/**
 * Placeholders leave at once: the content replacing them is the news, and a fading empty
 * text would double-expose under the first row that settles in at the same spot.
 */
const ghostSkipSelector = ".live-workspace-empty";

/**
 * Styling hooks `ghostExit`'s clone loses with every other `data-*` attribute (it strips them
 * so Datastar never binds the ghost). None is a Datastar plugin name, so putting them back is
 * inert; without them the banner's Abort button, for one, ghosts as a filled primary button.
 */
const presentationalAttributes = [
	"data-variant",
	"data-size",
	"data-turn-phase",
	"data-activity-kind",
	"data-piui-roster-state",
];

function restorePresentation(source: Element, ghost: Element): void {
	const sources = [source, ...source.querySelectorAll("*")];
	const ghosts = [ghost, ...ghost.querySelectorAll("*")];
	for (const [index, element] of sources.entries()) {
		const target = ghosts[index];
		if (!target) break;
		for (const name of presentationalAttributes) {
			const value = element.getAttribute(name);
			if (value !== null) target.setAttribute(name, value);
		}
	}
	// ghostExit measured the clone before this ran: the restored styling must not transition.
	for (const animation of ghost.getAnimations({ subtree: true })) {
		if (animation instanceof CSSTransition) animation.finish();
	}
}

/** Box of a watched node, relative to the scrolled content of `.live-workspace-body`. */
type BodyBox = { left: number; top: number; width: number; height: number };

/**
 * Entry and exit for Live Workspace rows (flow-spec B8, motion round 2). Rows are id-keyed
 * (`lw-tool-…`, `lw-agent-…`, `lw-activity-…`), so a morph inserts exactly the new row and
 * leaves the others in place; only an id this pane has never shown animates, and only inside
 * the visible tab of an open pane, so a tab reveal or a re-patch never replays it. The first
 * few fresh rows of a burst stagger (40ms, at most 4); a list that arrives whole staggers its
 * rows. A removed row, list or banner leaves through a ghost (LW-V2-07), mounted on the pane
 * shell (never re-patched, so a morph cannot sweep the ghost away) at the box it last had.
 */
function watchRowEntries(): void {
	const pane = document.getElementById("live-workspace");
	const body = pane?.querySelector<HTMLElement>(".live-workspace-body");
	if (!pane || !body) return;
	const seen = new Set(
		[...pane.querySelectorAll<HTMLElement>("[id^='lw-']")].map(
			(element) => element.id,
		),
	);
	const isOpen = () =>
		document.getElementById("app")?.classList.contains("live-workspace-open") ===
		true;
	const sessionPath = () =>
		document.getElementById("live-workspace-now")?.dataset.liveWorkspaceSession;
	let boxes = new Map<Element, BodyBox>();
	let lastSession = sessionPath();
	// Boxes are kept relative to the body's scrolled content, so a pane that slid, scrolled
	// or resized since the last patch still ghosts at the right spot.
	const measure = () => {
		const next = new Map<Element, BodyBox>();
		if (isOpen()) {
			const origin = body.getBoundingClientRect();
			for (const section of body.querySelectorAll(":scope > section")) {
				if (!section.checkVisibility()) continue;
				for (const element of section.querySelectorAll(enterSelector)) {
					const rect = element.getBoundingClientRect();
					next.set(element, {
						left: rect.left - origin.left,
						top: rect.top - origin.top + body.scrollTop,
						width: rect.width,
						height: rect.height,
					});
				}
			}
		}
		boxes = next;
	};
	const ghostRemoved = (records: MutationRecord[]) => {
		const session = sessionPath();
		const switchedSession = session !== lastSession;
		lastSession = session;
		// A session switch swaps every row at once: that is a new page, not rows leaving.
		if (!isOpen() || switchedSession) return;
		const origin = body.getBoundingClientRect();
		// SAFETY: motion.js infers `ms` as its default's literal (120); ghostExit accepts any
		// token duration (sidebar-list-motion.js passes xs/md the same way).
		const ms = (reducedMotion() ? duration.xs : duration.sm) as typeof duration.sm;
		for (const record of records) {
			if (!(record.target instanceof Element)) continue;
			// Only rows that left a section still shown; a hidden or replaced section (tab
			// switch, stale-tab patch) and the ghosts themselves never qualify.
			const section = record.target.closest(".live-workspace-body > section");
			if (!section?.isConnected || !section.checkVisibility()) continue;
			for (const node of record.removedNodes) {
				if (!(node instanceof HTMLElement) || !node.matches(enterSelector))
					continue;
				if (node.matches(ghostSkipSelector)) continue;
				const box = boxes.get(node);
				if (!box) continue;
				const ghost = ghostExit(
					node,
					{
						left: origin.left + box.left,
						top: origin.top + box.top - body.scrollTop,
						width: box.width,
						height: box.height,
					},
					{
						translateY: "0",
						scale: 0.97,
						ms,
						host: pane,
					},
				);
				const clone =
					ghost?.effect instanceof KeyframeEffect ? ghost.effect.target : null;
				if (clone) restorePresentation(node, clone);
			}
		}
	};
	measure();
	new MutationObserver((records) => {
		ghostRemoved(records);
		const open = isOpen();
		const fresh: HTMLElement[] = [];
		for (const record of records) {
			if (!(record.target instanceof Element) || !body.contains(record.target))
				continue;
			for (const node of record.addedNodes) {
				if (!(node instanceof HTMLElement) || !node.matches(enterSelector))
					continue;
				const expanded = node.matches(listSelector)
					? [...node.querySelectorAll<HTMLElement>(":scope > li[id^='lw-']")]
					: [];
				const rows = expanded.length > 0 ? expanded : [node];
				const visible = open && node.closest("section")?.checkVisibility();
				for (const row of rows) {
					if (row.id && seen.has(row.id)) continue;
					if (row.id) seen.add(row.id);
					if (visible) fresh.push(row);
				}
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
		// Text-only churn (the 1s elapsed tick, streamed labels) never moves a row's slot.
		const elementsChanged = records.some((record) =>
			[...record.addedNodes, ...record.removedNodes].some(
				(node) => node instanceof Element,
			),
		);
		if (elementsChanged) measure();
	}).observe(pane, { childList: true, subtree: true });
	// Opening the pane and switching tabs (data-show's inline display on a section) change
	// what is visible without a childList change.
	const visibility = new MutationObserver(measure);
	visibility.observe(body, {
		attributeFilter: ["style"],
		attributes: true,
		subtree: true,
	});
	const app = document.getElementById("app");
	if (app) visibility.observe(app, { attributeFilter: ["class"], attributes: true });
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

/**
 * Client-side companion for the Live Workspace pane: ticks the "Now" and "Activity" tabs'
 * relative/elapsed-time labels and the retry countdown (server-rendered timestamps go stale
 * the moment the page sits idle — A#26) and moves focus in and out of the pane when it opens
 * and closes, mirroring `workspace-review.ts`'s `applyOpen` pattern without that file's
 * git-availability gating, which Live Workspace has no equivalent of.
 */

import {
	notifyExternalSurfaceClose,
	notifyExternalSurfaceOpen,
	registerDismissibleSurface,
} from "../../static/app/history-stack.js";
import { formatRetryCountdown } from "../live-workspace-types.ts";

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

/**
 * True only while the pane is both open and presented as an overlay (the mobile sheet or the
 * 48-64rem drawer) rather than grid-docked (>=64rem, see live-workspace.css's `@container`
 * breakpoint) — docked, it's part of the page layout, not a surface a back press should
 * dismiss. Reads the pane's own computed `position` instead of re-deriving the breakpoint
 * here, so this can never drift from the CSS that actually decides it (A#17).
 */
function isOverlayOpen(): boolean {
	const app = document.getElementById("app");
	const pane = document.getElementById("live-workspace");
	if (!app?.classList.contains("live-workspace-open") || !pane) return false;
	return getComputedStyle(pane).position !== "relative";
}

/** Mirrors what `closeLiveWorkspaceAction()` (commands/actions.ts) does from a `data-on` handler. */
function closeLiveWorkspace(): void {
	document
		.getElementById("app")
		?.dispatchEvent(
			new CustomEvent("pi-ui-live-workspace-open", { detail: { open: false } }),
		);
	document.body.dispatchEvent(
		new CustomEvent("pi-ui-live-workspace-preferences", { detail: { open: false } }),
	);
}

function requestNotificationPermission(): void {
	if (typeof Notification === "undefined" || Notification.permission !== "default")
		return;
	void Notification.requestPermission();
}

/** Reads the toggle's own `aria-pressed`, which the server keeps in sync with the persisted
 * `liveWorkspacePreferences.notifications` signal — avoids a second source of truth here. */
function notificationsOptedIn(): boolean {
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
		Notification.permission !== "granted" ||
		!notificationsOptedIn() ||
		!document.hidden
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
 * whether the pane itself is open — notifications should fire even while it's closed. */
function watchTurnPhase(): void {
	const now = document.getElementById("live-workspace-now");
	if (!now) return;
	let previousPhase: string | undefined;
	const readPhase = () =>
		now.querySelector<HTMLElement>(".live-workspace-turn-banner")?.dataset.turnPhase;
	previousPhase = readPhase();
	new MutationObserver(() => {
		const phase = readPhase();
		if (phase === previousPhase) return;
		const previous = previousPhase;
		previousPhase = phase;
		if (phase === "waiting-for-extension") {
			notifyTurnEvent("pi is waiting for input", "Open pi-ui to respond.");
		} else if (
			phase === undefined &&
			(previous === "running" || previous === "retrying")
		) {
			notifyTurnEvent("Turn finished", "pi has finished the current turn.");
		}
	}).observe(now, {
		attributeFilter: ["data-turn-phase"],
		attributes: true,
		childList: true,
		subtree: true,
	});
}

function bindLiveWorkspace() {
	let open = false;
	// Whether opening the pane as an overlay pushed a history entry that closing must pop
	// (A#17: a back press should close the drawer/sheet, not leave the page).
	let historyEntry = false;
	const applyOpen = (next: boolean) => {
		if (next === open) return;
		open = next;
		const pane = document.getElementById("live-workspace");
		if (!pane) return;
		if (open) {
			requestAnimationFrame(() => {
				pane.querySelector<HTMLElement>(".live-workspace-tab-button")?.focus();
				if (open && !historyEntry && isOverlayOpen()) {
					historyEntry = true;
					notifyExternalSurfaceOpen();
				}
			});
			return;
		}
		if (historyEntry) {
			historyEntry = false;
			notifyExternalSurfaceClose();
		}
		if (pane.contains(document.activeElement)) {
			document.getElementById("live-workspace-toggle")?.focus();
		}
	};
	registerDismissibleSurface({
		// A back press already consumed this surface's history entry; don't pop another.
		close: () => {
			historyEntry = false;
			closeLiveWorkspace();
		},
		isOpen: isOverlayOpen,
	});
	// The pane can already be open on page load (its `open` preference is persisted), and
	// `#app`'s first `data-effect` run can land before this module has replaced main.js's
	// no-op `applyOpen` — so nothing registered the history entry, and on a phone/tablet a
	// back press (Android's, via Capacitor) left the app instead of closing the restored
	// sheet/drawer. Adopt that initial open state here, without moving focus (a cold load
	// must not steal focus from the prompt).
	const adoptInitialOpen = () => {
		if (
			open ||
			!document.getElementById("app")?.classList.contains("live-workspace-open")
		)
			return false;
		open = true;
		if (!historyEntry && isOverlayOpen()) {
			historyEntry = true;
			notifyExternalSurfaceOpen();
		}
		return true;
	};
	const app = document.getElementById("app");
	// Only when the server rendered the pane as initially open (the persisted preference) —
	// otherwise a user opening it moments after load must go through `applyOpen` (which also
	// moves focus into the pane), not this focus-less adoption.
	const initiallyOpen =
		app?.getAttribute("data-signals:_live-workspace-open__ifmissing") === "true";
	if (app && initiallyOpen && !adoptInitialOpen()) {
		// Datastar may not have applied `data-class` yet; catch the first class change.
		const observer = new MutationObserver(() => {
			if (adoptInitialOpen() || open) observer.disconnect();
		});
		observer.observe(app, { attributeFilter: ["class"], attributes: true });
		setTimeout(() => observer.disconnect(), 5000);
	}
	return { applyOpen, requestNotificationPermission };
}

window.piUi.liveWorkspace = bindLiveWorkspace();

watchTurnPhase();
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

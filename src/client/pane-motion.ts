/**
 * Pane choreography (flow-spec §4, motion round 2): every docked pane (Sessions, Live
 * Workspace, Review) slides over the chat on `translate` (a CSS transition that retargets),
 * the chat's layout reserve snaps once under the opaque pane, and the chat's centred content
 * glides between its old and new x with a WAAPI FLIP on the pane's own clock.
 *
 * Two halves (flow-critique #1):
 * - `armPaneMotion(pane, willOpen)` runs synchronously as the FIRST statement of every pane
 *   trigger (session-sidebar.tsx's command handler, commands/actions.ts, the Back gesture,
 *   Review's triggers), before any DOM change. It predicts the docked-set change from the live
 *   DOM plus the intent, records the pre-change ("visual") rects, and sets the attributes the
 *   first frame needs: `data-pane-swap` for a Sessions ⇄ Live swap, `data-reserve-hold=P` for
 *   an open. A MutationObserver armed any later loses a style pass to the trigger.
 * - The MutationObserver on `#app` (class) and `#session-sidebar` (open) only commits: it
 *   measures the real post-change layout, locks the column width and runs the FLIP.
 *
 * Unarmed changes (a trigger outside this module's reach) fall back to the purely reactive
 * path of flow-spec §4.3, which still animates, one style pass late.
 *
 * All state lives in client attributes on shell nodes that are never morph targets (`#app`,
 * `#chat-pane`) or in WAAPI objects, so no Datastar patch can strip it (flow-spec §4.3 note).
 */

import { duration, easing, motionReady, reducedMotion } from "../../static/app/motion.js";
import { bindSessionListMotion } from "../../static/app/sidebar-list-motion.js";
import { dockedLiveQuery } from "./live-workspace-layout.ts";

export type Pane = "sessions" | "live" | "review";

/** Everything `dockedPanes` needs to know about the page, read from the live DOM. */
export type PaneLayoutState = {
	appClasses: ReadonlySet<string>;
	sidebarOpen: boolean;
	/** `closedBy === "any"`: the phone drawer, a modal that never reserves layout. */
	sidebarModal: boolean;
	/** `matchMedia("(width >= 64rem)")`: Live Workspace docks (live-workspace.css). */
	wideForLive: boolean;
	/** `#workspace-shell` width >= 88rem: Review docks (workspace-review.css). */
	wideForReview: boolean;
};

export type PaneChange =
	| { kind: "none" }
	| { kind: "swap" }
	| { kind: "compound" }
	| { kind: "open"; pane: Pane }
	| { kind: "close"; pane: Pane };

const flipSelector =
	"#messages > .messages-stack, #prompt-box, .toolbar-actions, .toolbar-end, #session-transition > *";
const flipId = "pane-flip";
const rightPanes: ReadonlySet<Pane> = new Set<Pane>(["sessions", "live"]);
const paneElementIds: Readonly<Record<Pane, string>> = {
	sessions: "session-sidebar",
	live: "live-workspace",
	review: "workspace-review",
};
/** Keep in sync with workspace-review.css's `@container workspace (width >= 88rem)`. */
const reviewDockRem = 88;

/** Pure: which panes reserve layout in a given state (unit-tested). */
export function dockedPanes(state: PaneLayoutState): Set<Pane> {
	const docked = new Set<Pane>();
	if (state.sidebarOpen && !state.sidebarModal) docked.add("sessions");
	const review = state.appClasses.has("review-open");
	if (state.appClasses.has("live-workspace-open") && !review && state.wideForLive) {
		docked.add("live");
	}
	if (review && state.wideForReview) docked.add("review");
	return docked;
}

/** Pure: classify a docked-set change (unit-tested). */
export function classifyChange(
	before: ReadonlySet<Pane>,
	after: ReadonlySet<Pane>,
): PaneChange {
	const opened = [...after].filter((pane) => !before.has(pane));
	const closed = [...before].filter((pane) => !after.has(pane));
	const [openedPane] = opened;
	const [closedPane] = closed;
	if (!openedPane && !closedPane) return { kind: "none" };
	if (
		opened.length === 1 &&
		closed.length === 1 &&
		openedPane &&
		closedPane &&
		rightPanes.has(openedPane) &&
		rightPanes.has(closedPane)
	) {
		return { kind: "swap" };
	}
	if (opened.length + closed.length !== 1) return { kind: "compound" };
	if (openedPane) return { kind: "open", pane: openedPane };
	if (closedPane) return { kind: "close", pane: closedPane };
	return { kind: "none" };
}

/**
 * Pure: the state a trigger is about to produce (unit-tested). Sessions and Live Workspace
 * share the right-hand slot and every trigger that opens one closes the other
 * (PLAN-ux.md "sidebar-exclusive"), so an open predicts both halves of the swap even though
 * the second half runs a moment later in the same task.
 */
export function predictState(
	state: PaneLayoutState,
	pane: Pane,
	willOpen: boolean,
): PaneLayoutState {
	const appClasses = new Set(state.appClasses);
	let sidebarOpen = state.sidebarOpen;
	if (pane === "sessions") {
		sidebarOpen = willOpen;
		if (willOpen) appClasses.delete("live-workspace-open");
	} else if (pane === "live") {
		if (willOpen) {
			appClasses.add("live-workspace-open");
			sidebarOpen = false;
		} else appClasses.delete("live-workspace-open");
	} else if (willOpen) appClasses.add("review-open");
	else appClasses.delete("review-open");
	return { ...state, appClasses, sidebarOpen };
}

/** The layout widths, measured once per change: the reserve itself changes the shell width. */
function readWidths(): Pick<PaneLayoutState, "wideForLive" | "wideForReview"> {
	const shell = document.getElementById("workspace-shell");
	const rootFontSizePx =
		Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	return {
		wideForLive: globalThis.matchMedia?.(dockedLiveQuery).matches === true,
		wideForReview:
			(shell?.getBoundingClientRect().width ?? 0) >= reviewDockRem * rootFontSizePx,
	};
}

function readState(
	widths: Pick<PaneLayoutState, "wideForLive" | "wideForReview">,
	classes: string | undefined,
	sidebarOpen: boolean | undefined,
): PaneLayoutState {
	const app = document.getElementById("app");
	const sidebar = document.getElementById("session-sidebar");
	const modal = sidebar instanceof HTMLDialogElement && sidebar.closedBy === "any";
	return {
		appClasses: new Set(
			(classes ?? app?.getAttribute("class") ?? "").split(/\s+/u).filter(Boolean),
		),
		sidebarOpen: sidebarOpen ?? sidebar?.hasAttribute("open") ?? false,
		sidebarModal: modal,
		...widths,
	};
}

function flipTargets(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(flipSelector)];
}

function lefts(targets: readonly HTMLElement[]): number[] {
	return targets.map((element) => element.getBoundingClientRect().left);
}

function cancelFlips(targets: readonly HTMLElement[]): void {
	for (const element of targets) {
		for (const animation of element.getAnimations()) {
			if (animation.id === flipId) animation.cancel();
		}
	}
}

function lockColumns(targets: readonly HTMLElement[], rects: readonly DOMRect[]): void {
	const chat = document.getElementById("chat-pane");
	if (!chat) return;
	const widthOf = (selector: string) => {
		const index = targets.findIndex((element) => element.matches(selector));
		return index >= 0 ? rects[index]?.width : undefined;
	};
	const stack = widthOf("#messages > .messages-stack");
	const prompt = widthOf("#prompt-box");
	if (stack !== undefined) chat.style.setProperty("--pane-lock-stack", `${stack}px`);
	if (prompt !== undefined) chat.style.setProperty("--pane-lock-prompt", `${prompt}px`);
	chat.setAttribute("data-pane-lock", "");
}

function clearLocks(): void {
	const chat = document.getElementById("chat-pane");
	if (!chat) return;
	chat.removeAttribute("data-pane-lock");
	chat.style.removeProperty("--pane-lock-stack");
	chat.style.removeProperty("--pane-lock-prompt");
}

let generation = 0;
let swapTimer: ReturnType<typeof setTimeout> | undefined;

/** Commits an open: drops the hold, clears the width lock and ends the FLIP, in one block,
 * so the next frame renders the final layout with the content exactly where the FLIP ended. */
export function releasePane(): void {
	document.getElementById("app")?.removeAttribute("data-reserve-hold");
	clearLocks();
	cancelFlips(flipTargets());
}

function markSwap(): void {
	const app = document.getElementById("app");
	if (!app) return;
	app.setAttribute("data-pane-swap", "");
	clearTimeout(swapTimer);
	swapTimer = setTimeout(
		() => app.removeAttribute("data-pane-swap"),
		duration.paneIn + 50,
	);
}

/** Resolves when the pane's own slide ends (or is cancelled), with a timer fallback. */
function paneSettled(pane: Pane): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, duration.paneIn + 100);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		// getAnimations() flushes style, so the slide's transition exists by now.
		const slide = document
			.getElementById(paneElementIds[pane])
			?.getAnimations()
			.find(
				(animation) =>
					animation instanceof CSSTransition &&
					animation.transitionProperty === "translate",
			);
		slide?.finished.then(done, done);
	});
}

/**
 * Open `pane`: the pane slides over the still-wide chat (reserve withheld), the content FLIPs
 * from `visual` (where the eye is, including any in-flight FLIP) to its final x under a width
 * lock, and the reserve lands under the opaque pane when the slide ends.
 */
export function openPane(
	pane: Pane,
	targets: readonly HTMLElement[],
	visual: readonly number[],
): void {
	const app = document.getElementById("app");
	if (!app) return;
	const gen = ++generation;
	cancelFlips(targets);
	clearLocks();
	app.removeAttribute("data-reserve-hold");
	const final = targets.map((element) => element.getBoundingClientRect());
	app.setAttribute("data-reserve-hold", pane);
	lockColumns(targets, final);
	const base = lefts(targets);
	for (const [index, element] of targets.entries()) {
		const from = (visual[index] ?? base[index] ?? 0) - (base[index] ?? 0);
		const to = (final[index]?.left ?? 0) - (base[index] ?? 0);
		element.animate(
			[
				{ transform: `translateX(${from}px)` },
				{ transform: `translateX(${to}px)` },
			],
			{
				duration: duration.paneIn,
				easing: easing.drawer,
				fill: "forwards",
				id: flipId,
			},
		);
	}
	void paneSettled(pane).then(() => {
		if (gen === generation) releasePane();
	});
}

/** Close: the reserve drops at t0 (under the still-opaque pane) and the content glides from
 * `visual` back to its resting x on the pane's exit clock. */
export function closePane(
	targets: readonly HTMLElement[],
	visual: readonly number[],
): void {
	const app = document.getElementById("app");
	if (!app) return;
	generation++;
	// Closed mid-open (or while another pane's open is settling): commit that open first.
	if (app.hasAttribute("data-reserve-hold")) releasePane();
	else cancelFlips(targets);
	const base = lefts(targets);
	for (const [index, element] of targets.entries()) {
		const dx = (visual[index] ?? base[index] ?? 0) - (base[index] ?? 0);
		if (Math.abs(dx) < 0.5) continue;
		element.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], {
			duration: duration.paneOut,
			easing: easing.drawer,
			id: flipId,
		});
	}
}

/**
 * A Sessions ⇄ Live swap that lands while an open is still settling (Ctrl+B, then alt+L
 * within the slide): the incoming pane reserves the same slot at once, so the held open's
 * forwards-filled FLIP would push the content a full FLIP distance past its final x. Commit
 * that open now (closePane releases the hold, the lock and the FLIP) and glide the content
 * from `visual`, where it is drawn, to its resting x. The swap itself still crossfades.
 */
function settleHeldOpen(
	targets: readonly HTMLElement[],
	visual: readonly number[],
): void {
	if (!document.getElementById("app")?.hasAttribute("data-reserve-hold")) return;
	if (reducedMotion()) {
		generation++;
		releasePane();
	} else closePane(targets, visual);
}

type ArmedChange = {
	before: Set<Pane>;
	predicted: PaneLayoutState;
	widths: Pick<PaneLayoutState, "wideForLive" | "wideForReview">;
	targets: HTMLElement[];
	visual: number[];
	hold: Pane | undefined;
};
let armed: ArmedChange | undefined;

function motionBlocked(): boolean {
	return !motionReady() || document.documentElement.classList.contains("is-resizing");
}

/**
 * Synchronous half: call first thing in a pane trigger, before the trigger changes the DOM.
 * Several arms in one task (Live opening closes Sessions through a nested command) merge into
 * one prediction, measured once against the untouched layout.
 */
export function armPaneMotion(pane: Pane, willOpen: boolean): void {
	if (motionBlocked()) return;
	const app = document.getElementById("app");
	if (!app) return;
	if (!armed) {
		const widths = readWidths();
		const state = readState(widths, undefined, undefined);
		const targets = flipTargets();
		const change: ArmedChange = {
			before: dockedPanes(state),
			predicted: state,
			widths,
			targets,
			visual: lefts(targets),
			hold: undefined,
		};
		armed = change;
		// No mutation followed (the trigger was a no-op, or applied later): undo the arm. A
		// mutation in this task always reaches the observer's microtask before this task.
		setTimeout(() => {
			if (armed !== change) return;
			armed = undefined;
			if (change.hold && app.getAttribute("data-reserve-hold") === change.hold) {
				app.removeAttribute("data-reserve-hold");
			}
		}, 0);
	}
	armed.predicted = predictState(armed.predicted, pane, willOpen);
	const change = classifyChange(armed.before, dockedPanes(armed.predicted));
	if (change.kind === "swap") markSwap();
	const hold = change.kind === "open" && !reducedMotion() ? change.pane : undefined;
	if (hold) app.setAttribute("data-reserve-hold", hold);
	else if (armed.hold && app.getAttribute("data-reserve-hold") === armed.hold) {
		app.removeAttribute("data-reserve-hold");
	}
	armed.hold = hold;
}

/** Commit half for an armed change: the DOM has changed, the frame has not rendered yet. */
function commitArmed(change: ArmedChange): void {
	const app = document.getElementById("app");
	if (!app) return;
	const after = dockedPanes(readState(change.widths, undefined, undefined));
	const actual = classifyChange(change.before, after);
	const keepHold = actual.kind === "open" && !reducedMotion();
	if (
		!keepHold &&
		change.hold &&
		app.getAttribute("data-reserve-hold") === change.hold
	) {
		// The prediction was wrong: let the reserve snap rather than hold it forever.
		app.removeAttribute("data-reserve-hold");
	}
	const targets = change.targets.filter((element) => element.isConnected);
	const visual = change.visual.filter((_, index) => change.targets[index]?.isConnected);
	if (actual.kind === "swap") {
		markSwap();
		// Armed before the DOM changed, so `visual` is where the eye is (mid-FLIP included).
		settleHeldOpen(targets, visual);
		return;
	}
	if (reducedMotion()) return;
	if (actual.kind === "open") openPane(actual.pane, targets, visual);
	else if (actual.kind === "close") closePane(targets, visual);
}

/**
 * Reactive fallback (flow-spec §4.3) for a change nobody armed. The first record's oldValue
 * per target is the pre-change state. `restoreSessionSidebar()` (load, breakpoint) removes
 * `data-animate-open` before it toggles the dialog, so it stays instant.
 */
function commitUnarmed(records: readonly MutationRecord[]): void {
	if (motionBlocked()) return;
	const app = document.getElementById("app");
	const sidebar = document.getElementById("session-sidebar");
	if (!app) return;
	let oldClasses: string | undefined;
	let oldSidebarOpen: boolean | undefined;
	for (const record of records) {
		if (record.target === app && oldClasses === undefined) {
			oldClasses = record.oldValue ?? "";
		}
		if (record.target === sidebar && oldSidebarOpen === undefined) {
			oldSidebarOpen = record.oldValue !== null;
		}
	}
	if (oldSidebarOpen !== undefined && !sidebar?.hasAttribute("data-animate-open"))
		return;
	const widths = readWidths();
	const before = dockedPanes(readState(widths, oldClasses, oldSidebarOpen));
	const after = dockedPanes(readState(widths, undefined, undefined));
	const change = classifyChange(before, after);
	const targets = flipTargets();
	if (change.kind === "swap") {
		markSwap();
		const held = app.getAttribute("data-reserve-hold");
		const incoming = [...after].find((pane) => rightPanes.has(pane));
		if (held && incoming) {
			// The DOM already changed: withhold the incoming pane's reserve too, which restores
			// the held (unreserved) layout, to read where the content is drawn right now.
			app.setAttribute("data-reserve-hold", incoming);
			settleHeldOpen(targets, lefts(targets));
		}
		return;
	}
	if (reducedMotion()) return;
	if (change.kind === "open") {
		// Style == the last frame, so this layout is cached.
		app.setAttribute("data-reserve-hold", change.pane);
		openPane(change.pane, targets, lefts(targets));
	} else if (change.kind === "close") {
		let visual: number[];
		if (app.getAttribute("data-reserve-hold") === change.pane) {
			visual = lefts(targets);
		} else {
			app.setAttribute("data-reserve-keep", change.pane);
			visual = lefts(targets);
			app.removeAttribute("data-reserve-keep");
		}
		closePane(targets, visual);
	}
}

/** The observer's callback: commits the armed change, or reacts to an unarmed one. */
export function commitPaneMutations(records: readonly MutationRecord[]): void {
	const change = armed;
	armed = undefined;
	if (change) commitArmed(change);
	else commitUnarmed(records);
}

/** Binds the single production engine (called once by live-workspace.ts). */
export function bindPaneMotion(): void {
	const app = document.getElementById("app");
	if (!app) return;
	window.piUi.paneMotion = { arm: armPaneMotion };
	const observer = new MutationObserver(commitPaneMutations);
	observer.observe(app, { attributeFilter: ["class"], attributeOldValue: true });
	const sidebar = document.getElementById("session-sidebar");
	if (sidebar) {
		observer.observe(sidebar, { attributeFilter: ["open"], attributeOldValue: true });
	}
	// A breakpoint change mid-animation is layout reconfiguration, not a user state change:
	// commit whatever is in flight (flow-spec §9).
	window.addEventListener("resize", () => {
		generation++;
		armed = undefined;
		releasePane();
		clearTimeout(swapTimer);
		app.removeAttribute("data-pane-swap");
	});
	bindSessionListMotion();
}

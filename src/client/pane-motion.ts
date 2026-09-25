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

/** One target's box, read once per layout. */
export type PaneRect = { left: number; width: number };

function rects(targets: readonly HTMLElement[]): PaneRect[] {
	return targets.map((element) => {
		const { left, width } = element.getBoundingClientRect();
		return { left, width };
	});
}

function lefts(targets: readonly HTMLElement[]): number[] {
	return targets.map((element) => element.getBoundingClientRect().left);
}

/**
 * The live FLIP animations, kept as the objects `animate()` returned. Cancelling through
 * `element.getAnimations()` flushed style once per target inside the toggle task (B2).
 */
let flips: Animation[] = [];

function cancelFlips(): void {
	for (const animation of flips) animation.cancel();
	flips = [];
}

function flipsRunning(): boolean {
	return flips.some(
		(animation) =>
			animation.playState === "running" || animation.playState === "paused",
	);
}

function chatLocked(): boolean {
	return document.getElementById("chat-pane")?.hasAttribute("data-pane-lock") === true;
}

/** Pure: the width lock an open needs, or undefined when the column keeps its width. */
export function lockWidths(
	targets: readonly Pick<HTMLElement, "matches">[],
	final: readonly PaneRect[],
	current: readonly PaneRect[] | undefined,
): { stack?: number; prompt?: number } | undefined {
	const indexOf = (selector: string) =>
		targets.findIndex((element) => element.matches(selector));
	const stackIndex = indexOf("#messages > .messages-stack");
	const promptIndex = indexOf("#prompt-box");
	const stack = final[stackIndex]?.width;
	const prompt = final[promptIndex]?.width;
	const changed = (index: number, width: number | undefined) => {
		const now = current?.[index]?.width;
		return width !== undefined && (now === undefined || Math.abs(width - now) >= 1);
	};
	if (current && !changed(stackIndex, stack) && !changed(promptIndex, prompt)) {
		return undefined;
	}
	return { stack, prompt };
}

function lockColumns(widths: { stack?: number; prompt?: number }): void {
	const chat = document.getElementById("chat-pane");
	if (!chat) return;
	if (widths.stack !== undefined) {
		chat.style.setProperty("--pane-lock-stack", `${widths.stack}px`);
	}
	if (widths.prompt !== undefined) {
		chat.style.setProperty("--pane-lock-prompt", `${widths.prompt}px`);
	}
	chat.setAttribute("data-pane-lock", "");
}

function clearLocks(): void {
	const chat = document.getElementById("chat-pane");
	if (!chat?.hasAttribute("data-pane-lock")) return;
	chat.removeAttribute("data-pane-lock");
	chat.style.removeProperty("--pane-lock-stack");
	chat.style.removeProperty("--pane-lock-prompt");
}

let generation = 0;
let swapTimer: ReturnType<typeof setTimeout> | undefined;
let swapToken = 0;

/** Commits an open: drops the hold, clears the width lock and ends the FLIP, in one block,
 * so the next frame renders the final layout with the content exactly where the FLIP ended.
 * Writes only what is set, so a settled page takes no relayout here. */
export function releasePane(): void {
	const app = document.getElementById("app");
	if (app?.hasAttribute("data-reserve-hold")) app.removeAttribute("data-reserve-hold");
	clearLocks();
	cancelFlips();
}

function clearSwap(): void {
	swapToken++;
	clearTimeout(swapTimer);
	swapTimer = undefined;
	document.getElementById("app")?.removeAttribute("data-pane-swap");
}

/** The first CSS transition of `property` on `element` (flushes style, see paneSlide). */
function cssTransition(element: Element | null, property: string): Animation | undefined {
	return element
		?.getAnimations()
		.find(
			(animation) =>
				animation instanceof CSSTransition &&
				animation.transitionProperty === property,
		);
}

/**
 * Marks a Sessions ⇄ Live swap. The attribute stays until the incoming pane's fade has
 * actually run: a wall-clock timer armed in the toggle task expired during a stalled first
 * frame and the panes slid instead of crossfading (B3). With a fade to follow, its
 * `finished` (which also settles on cancel) is the only clock: a timer can fire while
 * rendering is stalled, before the fade's end (and the outgoing pane's `display: none`) is
 * processed, and dropping the swap then starts a translate transition on the outgoing pane.
 * After a stalled frame both fades end in the same style update, so the swap is dropped two
 * frames after `finished`, once a style update has applied the outgoing pane's
 * `display: none`. With no fade, a fallback timer starts from the first frame.
 */
function markSwap(): void {
	const app = document.getElementById("app");
	if (!app) return;
	app.setAttribute("data-pane-swap", "");
	const token = ++swapToken;
	clearTimeout(swapTimer);
	swapTimer = undefined;
	const clear = () => {
		if (token === swapToken) clearSwap();
	};
	requestAnimationFrame(() => {
		if (token !== swapToken) return;
		const incoming = app.classList.contains("live-workspace-open")
			? "live-workspace"
			: "session-sidebar";
		const fade = cssTransition(document.getElementById(incoming), "opacity");
		const afterStyle = () =>
			requestAnimationFrame(() => requestAnimationFrame(clear));
		if (fade) fade.finished.then(afterStyle, afterStyle);
		else swapTimer = setTimeout(clear, duration.paneIn + 50);
	});
}

/** The pane's own slide. `getAnimations()` flushes style, and under the chat's size
 * container queries a style flush is a layout: call it only where layout is clean. */
function paneSlide(pane: Pane): Animation | undefined {
	return cssTransition(document.getElementById(paneElementIds[pane]), "translate");
}

/**
 * Puts the FLIPs on the pane slide's clock: same start time and same duration, so a
 * reversed (shortened) slide on a reopen mid-close and the content move together (B4).
 * A reversed transition takes its start time from the timeline at once, while a new WAAPI
 * animation waits for the next frame, so syncing only after `ready` left the content one
 * frame behind the pane.
 */
function syncFlips(slide: Animation, own: readonly Animation[]): void {
	const slideMs = Number(slide.effect?.getComputedTiming().duration);
	for (const flip of own) {
		if (Number.isFinite(slideMs) && slideMs > 0) {
			flip.effect?.updateTiming({ duration: slideMs });
		}
		if (slide.startTime !== null) flip.startTime = slide.startTime;
	}
}

/**
 * Follows the pane's own slide: syncs the FLIPs to it and, for an open, commits when it
 * ends (or is cancelled). `found` is the slide looked up right after the change's last
 * forced layout (style is clean there, so the lookup costs no style pass); without one the
 * lookup runs in the first frame. The fallback timer starts only once the slide has started,
 * so a stalled first frame cannot release the reserve before the slide ran (B3).
 */
function followSlide(
	pane: Pane,
	gen: number,
	own: readonly Animation[],
	commit: boolean,
	found: Animation | undefined,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const done = () => {
		clearTimeout(timer);
		if (commit && gen === generation) releasePane();
	};
	const fallback = () => {
		if (commit && gen === generation) timer = setTimeout(done, duration.paneIn + 100);
	};
	const follow = (slide: Animation) => {
		syncFlips(slide, own);
		if (commit) slide.finished.then(done, done);
		slide.ready.then(
			() => {
				if (gen !== generation) return;
				syncFlips(slide, own);
				fallback();
			},
			() => {},
		);
	};
	if (found) {
		follow(found);
		return;
	}
	requestAnimationFrame(() => {
		if (gen !== generation) return;
		const slide = paneSlide(pane);
		if (slide) follow(slide);
		else fallback();
	});
}

function animateFlips(
	targets: readonly HTMLElement[],
	deltas: readonly ({ from: number; to: number } | undefined)[],
	options: KeyframeAnimationOptions,
): Animation[] {
	const own: Animation[] = [];
	for (const [index, element] of targets.entries()) {
		const delta = deltas[index];
		if (!delta) continue;
		const to = delta.to === 0 ? "none" : `translateX(${delta.to}px)`;
		own.push(
			element.animate(
				[{ transform: `translateX(${delta.from}px)` }, { transform: to }],
				{ ...options, id: flipId },
			),
		);
	}
	flips.push(...own);
	return own;
}

/**
 * Open `pane`: the pane slides over the still-wide chat (reserve withheld), the content FLIPs
 * from `visual` (where the eye is, including any in-flight FLIP) to its final x, and the
 * reserve lands under the opaque pane when the slide ends.
 *
 * Cost (B2): one forced layout (the real post-open layout) in the toggle task. A second one
 * runs only when the column changes width (the lock re-wraps it) or when `visual` is not
 * the held layout (`settled` false: a FLIP, hold or lock was live when it was read).
 */
export function openPane(
	pane: Pane,
	targets: readonly HTMLElement[],
	visual: readonly PaneRect[],
	settled = false,
): void {
	const app = document.getElementById("app");
	if (!app) return;
	const gen = ++generation;
	cancelFlips();
	clearLocks();
	app.removeAttribute("data-reserve-hold");
	const final = rects(targets);
	// Style and layout are clean here and the slide already exists: a lookup after the hold
	// write would flush style, and style under a size container query is a layout.
	const slide = paneSlide(pane);
	app.setAttribute("data-reserve-hold", pane);
	const lock = lockWidths(targets, final, settled ? visual : undefined);
	if (lock) lockColumns(lock);
	// Settled and unlocked: the held layout is the pre-change layout that `visual` measured.
	const base = settled && !lock ? visual.map((rect) => rect.left) : lefts(targets);
	const own = animateFlips(
		targets,
		targets.map((_, index) => {
			const left = base[index] ?? 0;
			return {
				from: (visual[index]?.left ?? left) - left,
				to: (final[index]?.left ?? left) - left,
			};
		}),
		{ duration: duration.paneIn, easing: easing.drawer, fill: "forwards" },
	);
	followSlide(pane, gen, own, true, slide);
}

/** Close: the reserve drops at t0 (under the still-opaque pane) and the content glides from
 * `visual` back to its resting x on the pane's exit clock. */
export function closePane(
	targets: readonly HTMLElement[],
	visual: readonly PaneRect[],
	pane?: Pane,
): void {
	const app = document.getElementById("app");
	if (!app) return;
	const gen = ++generation;
	// Closed mid-open (or while another pane's open is settling): commit that open first.
	releasePane();
	const base = lefts(targets);
	const slide = pane ? paneSlide(pane) : undefined;
	const own = animateFlips(
		targets,
		targets.map((_, index) => {
			const left = base[index] ?? 0;
			const from = (visual[index]?.left ?? left) - left;
			return Math.abs(from) < 0.5 ? undefined : { from, to: 0 };
		}),
		{ duration: duration.paneOut, easing: easing.drawer },
	);
	if (pane && own.length > 0) followSlide(pane, gen, own, false, slide);
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
	visual: readonly PaneRect[],
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
	visual: PaneRect[];
	/** No hold, lock or FLIP was live when `visual` was read (see openPane). */
	settled: boolean;
	hold: Pane | undefined;
};
let armed: ArmedChange | undefined;

function motionBlocked(): boolean {
	return !motionReady() || document.documentElement.classList.contains("is-resizing");
}

/**
 * Synchronous half: call first thing in a pane trigger, before the trigger changes the DOM.
 * Several arms in one task (Live opening closes Sessions through a nested command) merge into
 * one prediction, measured once against the untouched layout. Every read happens here,
 * before any attribute write, so it hits the last frame's layout.
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
			visual: rects(targets),
			settled:
				!app.hasAttribute("data-reserve-hold") &&
				!chatLocked() &&
				!flipsRunning(),
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
	if (actual.kind === "open") openPane(actual.pane, targets, visual, change.settled);
	// The armed `visual` is the pre-close layout: no data-reserve-keep measurement needed.
	else if (actual.kind === "close") closePane(targets, visual, actual.pane);
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
			settleHeldOpen(targets, rects(targets));
		}
		return;
	}
	if (reducedMotion()) return;
	if (change.kind === "open") {
		// Style == the last frame, so this layout is cached.
		const settled =
			!app.hasAttribute("data-reserve-hold") && !chatLocked() && !flipsRunning();
		app.setAttribute("data-reserve-hold", change.pane);
		openPane(change.pane, targets, rects(targets), settled);
	} else if (change.kind === "close") {
		let visual: PaneRect[];
		if (app.getAttribute("data-reserve-hold") === change.pane) {
			visual = rects(targets);
		} else {
			app.setAttribute("data-reserve-keep", change.pane);
			visual = rects(targets);
			app.removeAttribute("data-reserve-keep");
		}
		closePane(targets, visual, change.pane);
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
		clearSwap();
	});
	bindSessionListMotion();
}

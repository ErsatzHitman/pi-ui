/**
 * Open/close state for the Live Workspace pane, split out of `live-workspace.ts` (which binds
 * listeners and starts a ticking interval at import time) so it can be DOM-tested (O11).
 */

import {
	notifyExternalSurfaceClose,
	notifyExternalSurfaceOpen,
	registerDismissibleSurface,
} from "../../static/app/history-stack.js";
import { duration, easing, reducedMotion } from "../../static/app/motion.js";
import { isDockedLayout } from "./live-workspace-layout.ts";
import { armPaneMotion } from "./pane-motion.ts";

/**
 * True only while the pane is both open and presented as an overlay (the mobile sheet or the
 * 48-64rem drawer) rather than grid-docked (>=64rem, see live-workspace.css's `@media`
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

/**
 * Mirrors what `closeLiveWorkspaceAction()` (commands/actions.ts) does from a `data-on` handler.
 * Reached through the Back gesture and the sheet's drag-to-dismiss while the pane floats as an
 * overlay; like every trigger it arms the pane choreography first (pane-motion.ts).
 */
function closeLiveWorkspace(): void {
	armPaneMotion("live", false);
	document
		.getElementById("app")
		?.dispatchEvent(
			new CustomEvent("pi-ui-live-workspace-open", { detail: { open: false } }),
		);
	document.body.dispatchEvent(
		new CustomEvent("pi-ui-live-workspace-preferences", { detail: { open: false } }),
	);
}

/** Pure (unit-tested): a released sheet drag dismisses on a flick or past 30% of its height. */
export function sheetRelease(
	dy: number,
	height: number,
	velocityPxPerMs: number,
): "dismiss" | "restore" {
	return velocityPxPerMs > 0.11 || dy > 0.3 * height ? "dismiss" : "restore";
}

/** Pure (unit-tested): upward over-drag rubber-bands; downward tracks 1:1. */
export function rubberBand(raw: number, height: number): number {
	return raw >= 0 ? raw : -(1 - 1 / ((-raw * 0.55) / height + 1)) * height;
}

type SheetDrag = {
	id: number;
	x: number;
	y: number;
	base: number;
	dy: number;
	t: number;
	v: number;
	active: boolean;
	hold: Animation | undefined;
	/** The scrim's opacity, following the sheet down (LW-V2-09). */
	scrim: Animation | undefined;
	raf: number;
};

/** Pure (unit-tested): the scrim fades with the sheet's downward travel, never above 1. */
export function scrimOpacity(dy: number, height: number): number {
	if (height <= 0) return 1;
	return Math.min(1, Math.max(0, 1 - Math.max(0, dy) / height));
}

/**
 * Sheet mode only (≤48rem): the grabber and the header's empty area drag the sheet down to
 * dismiss it (B-X1). The drag offset lives in ONE WAAPI animation on `transform`, so it composes
 * with the CSS `translate` transition that owns open/close (flow-spec §2 rule 6), and no morph or
 * style attribute can reset it mid-drag.
 */
function bindSheetDrag(pane: HTMLElement): void {
	const sheet = globalThis.matchMedia?.("(width <= 48rem)");
	let drag: SheetDrag | undefined;
	const backdrop = () => document.getElementById("live-workspace-backdrop");
	const offsetNow = () =>
		new DOMMatrixReadOnly(getComputedStyle(pane).transform).m42 || 0;
	const setKeyframe = (animation: Animation | undefined, keyframe: Keyframe) => {
		const effect = animation?.effect;
		if (effect instanceof KeyframeEffect) effect.setKeyframes([keyframe]);
	};
	const setHeld = (current: SheetDrag, dy: number) => {
		setKeyframe(current.hold, { transform: `translateY(${dy}px)` });
		const height = pane.getBoundingClientRect().height;
		setKeyframe(current.scrim, { opacity: scrimOpacity(dy, height) });
	};
	pane.addEventListener("pointerdown", (event) => {
		if (!sheet?.matches || drag || event.button !== 0) return;
		const target = event.target instanceof Element ? event.target : null;
		if (!target?.closest("#live-workspace-drag-handle, .live-workspace-header"))
			return;
		if (target.closest("button, a, input, [role='tab']")) return;
		drag = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			base: 0,
			dy: 0,
			t: event.timeStamp,
			v: 0,
			active: false,
			hold: undefined,
			scrim: undefined,
			raf: 0,
		};
	});
	pane.addEventListener("pointermove", (event) => {
		if (!drag || event.pointerId !== drag.id) return;
		if (!drag.active) {
			if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
			drag.active = true;
			// A re-grab mid-snap continues from where the sheet is drawn.
			drag.base = offsetNow();
			const scrim = backdrop();
			for (const animation of [
				...pane.getAnimations(),
				...(scrim?.getAnimations() ?? []),
			]) {
				if (animation.id === "sheet-drag") animation.cancel();
			}
			pane.setPointerCapture(drag.id);
			drag.hold = pane.animate([{ transform: `translateY(${drag.base}px)` }], {
				duration: 0,
				fill: "forwards",
				id: "sheet-drag",
			});
			// The scrim follows the sheet down instead of holding at 1 until release.
			drag.scrim = scrim?.animate(
				[
					{
						opacity: scrimOpacity(
							drag.base,
							pane.getBoundingClientRect().height,
						),
					},
				],
				{ duration: 0, fill: "forwards", id: "sheet-drag" },
			);
		}
		const height = pane.getBoundingClientRect().height;
		const dy = rubberBand(drag.base + event.clientY - drag.y, height);
		const dt = Math.max(1, event.timeStamp - drag.t);
		drag.v = (dy - drag.dy) / dt;
		drag.dy = dy;
		drag.t = event.timeStamp;
		if (!drag.raf) {
			drag.raf = requestAnimationFrame(() => {
				if (!drag) return;
				drag.raf = 0;
				setHeld(drag, drag.dy);
			});
		}
	});
	const end = (event: PointerEvent) => {
		if (!drag || event.pointerId !== drag.id) return;
		const current = drag;
		drag = undefined;
		cancelAnimationFrame(current.raf);
		const hold = current.hold;
		const scrim = current.scrim;
		if (!current.active || !hold) return;
		setHeld(current, current.dy);
		const height = pane.getBoundingClientRect().height;
		const scrimFrom = scrimOpacity(current.dy, height);
		const scrimElement = backdrop();
		if (
			event.type !== "pointercancel" &&
			sheetRelease(current.dy, height, current.v) === "dismiss"
		) {
			// Close as every other trigger does: the CSS translate exit (or the reduced-motion
			// fade) runs while the held transform keeps the sheet at the finger's offset. The
			// scrim finishes its fade from where the finger left it, alongside the exit.
			closeLiveWorkspace();
			const scrimOut = scrimElement?.animate(
				[{ opacity: scrimFrom }, { opacity: 0 }],
				{
					duration: duration.paneOut,
					easing: easing.out,
					fill: "forwards",
					id: "sheet-drag",
				},
			);
			scrim?.cancel();
			setTimeout(() => {
				hold.cancel();
				scrimOut?.cancel();
			}, duration.paneOut + 60);
			return;
		}
		if (reducedMotion()) {
			hold.cancel();
			scrim?.cancel();
			return;
		}
		pane.animate(
			[{ transform: `translateY(${current.dy}px)` }, { transform: "none" }],
			{
				duration: duration.lg,
				easing: easing.drawer,
				id: "sheet-drag",
			},
		);
		scrimElement?.animate([{ opacity: scrimFrom }, { opacity: 1 }], {
			duration: duration.lg,
			easing: easing.drawer,
			id: "sheet-drag",
		});
		// Same frame: the snap-back animations take over from the finger's offset.
		hold.cancel();
		scrim?.cancel();
	};
	pane.addEventListener("pointerup", end);
	pane.addEventListener("pointercancel", end);
}

/**
 * Binds the pane's open/close behaviour: focus handoff, the Back-button history entry while it
 * floats as an overlay, and adopting (or, per O10, declining) a persisted open state on load.
 * Side-effect free until called, so it can be DOM-tested (O11); `live-workspace.ts` binds the
 * single production instance.
 */
export function bindLiveWorkspace() {
	const livePane = document.getElementById("live-workspace");
	if (livePane) bindSheetDrag(livePane);
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
			// Cleared before the focus below: an inert pane cannot take it (C6).
			pane.inert = false;
			requestAnimationFrame(() => {
				// preventScroll: the pane is still sliding in from off-screen; a scroll-into-view
				// here lurched the whole app sideways (LW-P0-FOCUS-SCROLL-LURCH).
				pane.querySelector<HTMLElement>(".live-workspace-tab-button")?.focus({
					preventScroll: true,
				});
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
		// The pane keeps `display` through its slide-out: after focus has left it, take it out
		// of the Tab order and the accessibility tree until it reopens (C6).
		pane.inert = true;
	};
	const unregisterSurface = registerDismissibleSurface({
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
		const app = document.getElementById("app");
		if (open || !app?.classList.contains("live-workspace-open")) return false;
		// O10: the persisted `open` preference doesn't distinguish a desktop-docked pane from a
		// phone/tablet overlay — restoring it as an overlay would cover the chat the instant the
		// page loads. Only the docked layout auto-restores; elsewhere close it again (without
		// persisting, so the docked preference survives for next time the window is that wide).
		if (!isDockedLayout()) {
			app.dispatchEvent(
				new CustomEvent("pi-ui-live-workspace-open", { detail: { open: false } }),
			);
			return true;
		}
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
	let observer: MutationObserver | undefined;
	if (app && initiallyOpen && !adoptInitialOpen()) {
		// Datastar may not have applied `data-class` yet; catch the first class change.
		const classObserver = new MutationObserver(() => {
			if (adoptInitialOpen() || open) classObserver.disconnect();
		});
		classObserver.observe(app, { attributeFilter: ["class"], attributes: true });
		setTimeout(() => classObserver.disconnect(), 5000);
		observer = classObserver;
	}
	return {
		applyOpen,
		/** Test-only teardown; the production instance lives for the page's lifetime. */
		dispose: () => {
			unregisterSurface();
			observer?.disconnect();
		},
	};
}

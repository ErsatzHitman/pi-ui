/**
 * Generic browser-history integration for dismissible surfaces (dialogs,
 * the session sidebar drawer, future sheets): pushes a history entry when one
 * opens and pops it again when it closes, so a phone's hardware/gesture back
 * button (Capacitor's `App` plugin falls back to `window.history.back()`)
 * closes the top-most open surface instead of leaving the app with no history
 * to pop on the first press. Every `<dialog>` in this app already fires the
 * native `toggle` event with `evt.newState` (relied on directly by several
 * `data-on:toggle` handlers in page.tsx), so a single capturing listener here
 * covers all of them — including ones added later — with no per-dialog markup.
 */
export function createDismissibleHistoryGuard(options = {}) {
	const pushState = options.pushState ?? ((state) => history.pushState(state, ""));
	const back = options.back ?? (() => history.back());
	let pendingPop = false;

	/** Call when a dismissible surface has just opened. */
	function notifyOpen() {
		if (pendingPop) return;
		pushState({ piUiDismissible: true });
	}

	/** Call when a dismissible surface has just closed, for any reason. */
	function notifyClose() {
		if (pendingPop) return;
		back();
	}

	/**
	 * Call on a `popstate` navigation. If a dismissible surface is still open,
	 * the back button reached it before the underlying page: close the
	 * top-most one and suppress the matching `notifyClose()` history pop that
	 * its own `toggle` event will fire next, since the entry is already gone.
	 */
	function handlePopstate(hasOpenSurface, closeTopmost) {
		if (!hasOpenSurface()) return;
		pendingPop = true;
		try {
			closeTopmost();
		} finally {
			queueMicrotask(() => {
				pendingPop = false;
			});
		}
	}

	return { notifyOpen, notifyClose, handlePopstate };
}

/**
 * A#17: dismissible surfaces that are not a `<dialog>` — today, the Live Workspace pane when
 * it floats as a drawer/sheet instead of being grid-docked (docked, it's part of the layout,
 * not something a back press should dismiss). `bindDismissibleHistory` folds these into the
 * same back-button handling every `<dialog>` already gets, without needing to know their
 * markup. Each entry reports its own open state, since only its owner knows when that's true.
 */
const externalSurfaces = new Set();

/** Registers a `{ isOpen(), close() }` surface; returns a function that unregisters it. */
export function registerDismissibleSurface(surface) {
	externalSurfaces.add(surface);
	return () => externalSurfaces.delete(surface);
}

function openExternalSurface() {
	for (const surface of externalSurfaces) {
		if (surface.isOpen()) return surface;
	}
	return undefined;
}

function closeTopmostDismissible() {
	const modal = document.querySelector(":modal");
	if (modal instanceof HTMLDialogElement) {
		modal.close();
		return true;
	}
	const openDialog = document.querySelector("dialog[open]");
	if (openDialog instanceof HTMLDialogElement) {
		openDialog.close();
		return true;
	}
	const surface = openExternalSurface();
	if (surface) {
		surface.close();
		return true;
	}
	return false;
}

function hasOpenDismissible() {
	return (
		document.querySelector("dialog[open]") !== null ||
		openExternalSurface() !== undefined
	);
}

/** True for an `<dialog open>` node, or one that contains one, so a removed subtree counts too. */
function containsOpenDialog(node) {
	if (!(node instanceof Element)) return false;
	if (node instanceof HTMLDialogElement) return node.open;
	return node.querySelector("dialog[open]") !== null;
}

export function bindDismissibleHistory(
	guard = createDismissibleHistoryGuard(),
	documentTarget = document,
	windowTarget = window,
) {
	documentTarget.addEventListener(
		"toggle",
		(event) => {
			if (!(event.target instanceof HTMLDialogElement)) return;
			if (event.newState === "open") guard.notifyOpen();
			else if (event.newState === "closed") guard.notifyClose();
		},
		true,
	);
	windowTarget.addEventListener("popstate", () => {
		guard.handlePopstate(hasOpenDismissible, closeTopmostDismissible);
	});
	// A#17: a dialog REMOVED from the DOM while still open (e.g. a PIUI sheet element the
	// extension retired, or the server simply stopped rendering it on the next morph) never
	// fires `toggle`, so its history entry would otherwise be orphaned. Pop it the same way a
	// normal close would, generically, for every dialog rather than one-off per caller.
	const body = documentTarget.body ?? documentTarget.documentElement ?? documentTarget;
	if (typeof MutationObserver !== "undefined" && body) {
		new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of mutation.removedNodes) {
					if (containsOpenDialog(node)) {
						guard.notifyClose();
						return;
					}
				}
			}
		}).observe(body, { childList: true, subtree: true });
	}
}

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
	return false;
}

function hasOpenDialog() {
	return document.querySelector("dialog[open]") !== null;
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
		guard.handlePopstate(hasOpenDialog, closeTopmostDismissible);
	});
}

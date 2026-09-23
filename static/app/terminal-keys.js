// Browser keyboard/paste/wheel events → the terminal byte sequences a pi-tui `Component`
// expects in `handleInput(data)` (xterm-style legacy encoding, which pi-tui's key parser
// understands). Used by extension terminal surfaces (`custom()` overlays and component
// widgets — see src/ui/terminal-surface.tsx).

const csi = "\u001b[";

/** @type {Record<string, string>} */
const cursorKeys = {
	ArrowUp: "A",
	ArrowDown: "B",
	ArrowRight: "C",
	ArrowLeft: "D",
	Home: "H",
	End: "F",
};
/** @type {Record<string, string>} */
const tildeKeys = { Insert: "2", Delete: "3", PageUp: "5", PageDown: "6" };

/**
 * xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4).
 * @param {{ shiftKey: boolean, altKey: boolean, ctrlKey: boolean }} event
 */
function modifierParameter(event) {
	return (
		1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0)
	);
}

/**
 * Encodes one keydown. Returns `undefined` for keys the terminal should not receive
 * (pure modifier presses, IME composition, and Meta/Cmd shortcuts left to the browser).
 * @param {{ key: string, ctrlKey: boolean, altKey: boolean, shiftKey: boolean, metaKey: boolean, isComposing?: boolean }} event
 * @returns {string | undefined}
 */
export function encodeTerminalKey(event) {
	if (event.isComposing || event.metaKey) return undefined;
	const { key } = event;
	const modifier = modifierParameter(event);
	const cursor = cursorKeys[key];
	if (cursor) return modifier > 1 ? `${csi}1;${modifier}${cursor}` : `${csi}${cursor}`;
	const tilde = tildeKeys[key];
	if (tilde) return modifier > 1 ? `${csi}${tilde};${modifier}~` : `${csi}${tilde}~`;
	const alt = event.altKey ? "\u001b" : "";
	switch (key) {
		case "Enter":
			return `${alt}\r`;
		case "Escape":
			return "\u001b";
		case "Backspace":
			return `${alt}${event.ctrlKey ? "\b" : "\u007f"}`;
		case "Tab":
			return event.shiftKey ? `${csi}Z` : `${alt}\t`;
	}
	if (key.length !== 1) return undefined;
	if (event.ctrlKey) {
		const code = key.toUpperCase().charCodeAt(0);
		// Ctrl+@..Ctrl+_ map onto C0 controls; Ctrl+Space sends NUL.
		if (key === " ") return `${alt}\u0000`;
		if (code >= 64 && code <= 95) return `${alt}${String.fromCharCode(code - 64)}`;
		return undefined;
	}
	return `${alt}${key}`;
}

/**
 * Wraps pasted text in bracketed-paste markers so a component can tell it from typing.
 * @param {string} text
 */
export function encodeTerminalPaste(text) {
	return `${csi}200~${text}${csi}201~`;
}

/**
 * Maps a wheel gesture to arrow keys (one per ~40px of travel, at most 5), matching how
 * terminals scroll full-screen apps that don't enable mouse reporting.
 * @param {{ deltaY: number }} event
 */
export function encodeTerminalWheel(event) {
	if (event.deltaY === 0) return undefined;
	const steps = Math.min(5, Math.max(1, Math.round(Math.abs(event.deltaY) / 40)));
	return (event.deltaY < 0 ? `${csi}A` : `${csi}B`).repeat(steps);
}

/**
 * How many monospace cells fit the space a terminal surface can occupy: the viewport
 * (minus dialog chrome) for an overlay inside a `<dialog>`, otherwise the element's own
 * content box. Returns `undefined` while the element has no layout (e.g. a closed dialog
 * or a detached node), so callers skip the resize instead of shrinking to nothing.
 * @param {HTMLElement} element
 * @returns {number | undefined}
 */
export function fitTerminalColumns(element) {
	const probe = document.createElement("span");
	probe.textContent = "0".repeat(10);
	probe.style.position = "absolute";
	probe.style.visibility = "hidden";
	element.append(probe);
	const cellWidth = probe.getBoundingClientRect().width / 10;
	probe.remove();
	if (!(cellWidth > 0)) return undefined;
	const style = getComputedStyle(element);
	const padding =
		Number.parseFloat(style.paddingInlineStart) +
		Number.parseFloat(style.paddingInlineEnd);
	const available = element.closest("dialog")
		? // Dialog panel: 1rem margin each side, 1rem padding each side, 1px border each side.
			document.documentElement.clientWidth - 4 * 16 - 2 - padding
		: element.clientWidth - padding;
	const columns = Math.floor(available / cellWidth);
	return columns >= 20 ? columns : undefined;
}

/** @type {Map<string, string[]>} Keys waiting to be sent, per surface, in typing order. */
const pendingTerminalInput = new Map();

/**
 * Posts encoded terminal input to a surface in the order it was typed. Each key is its own
 * request (a component's `handleInput()` expects one key sequence per call), but a surface
 * only ever has one request in flight: parallel posts can reach the server out of order, and
 * Datastar's `@post` cancels an in-flight request to the same URL, dropping keys typed faster
 * than a network round trip.
 * @param {string} endpoint
 * @param {string} surfaceId
 * @param {string} data
 * @param {typeof fetch} [send]
 */
export function sendTerminalInput(endpoint, surfaceId, data, send = fetch) {
	const queued = pendingTerminalInput.get(surfaceId);
	if (queued) {
		queued.push(data);
		return;
	}
	const queue = [data];
	pendingTerminalInput.set(surfaceId, queue);
	return (async () => {
		try {
			for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
				try {
					await send(endpoint, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"datastar-request": "true",
						},
						body: JSON.stringify({ surfaceId, data: next }),
					});
				} catch {
					// The connection is gone; later keys are still tried in order.
				}
			}
		} finally {
			pendingTerminalInput.delete(surfaceId);
		}
	})();
}

// Browser keyboard/paste/wheel events → the terminal byte sequences a pi-tui `Component`
// expects in `handleInput(data)` (xterm-style legacy encoding, which pi-tui's key parser
// understands). Used by extension terminal surfaces (`custom()` overlays and component
// widgets — see src/ui/terminal-surface.tsx).

const csi = "\u001b[";

/** @type {Record<string, string>} */
const cursorKeys = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
/** @type {Record<string, string>} */
const tildeKeys = { Insert: "2", Delete: "3", PageUp: "5", PageDown: "6" };

/**
 * xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4).
 * @param {{ shiftKey: boolean, altKey: boolean, ctrlKey: boolean }} event
 */
function modifierParameter(event) {
	return 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
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

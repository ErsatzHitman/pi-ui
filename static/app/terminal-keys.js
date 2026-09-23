import { endpoints } from "../../src/server/routes/endpoints.ts";

/**
 * Client-side companion for the terminal-surface host (see
 * `src/ui/terminal-surface.tsx`, `src/agent/terminal-surface/*`): encodes
 * browser `KeyboardEvent`s into the terminal byte sequences pi-tui's
 * `Component.handleInput()` expects (legacy VT100/xterm sequences plus the
 * standard `CSI 1;<mod>` extended-modifier and `CSI 27;<mod>;<code>~`
 * "modifyOtherKeys" forms pi-tui's own parser accepts — see
 * `@earendil-works/pi-tui`'s `dist/keys.js`), measures each surface's
 * monospace cell grid and reports resizes, and drives the coarse-pointer
 * soft-key bar. Every mounted surface is driven through a single hidden
 * `<textarea>` proxy per surface (the classic xterm.js technique) so real
 * IME composition and mobile predictive text both work, even though the
 * visible content is a read-only `<pre>`.
 */

const gridSelector = "[data-terminal-surface-grid]";
const bodySelector = "[data-terminal-surface-body]";
const inputSelector = "[data-terminal-surface-input]";
const keysBarSelector = "[data-terminal-surface-keys]";

const MOD = { shift: 1, alt: 2, ctrl: 4 };

/** `key.toLowerCase().charCodeAt(0) & 0x1f` — mirrors pi-tui's `rawCtrlChar()`. */
function rawCtrlChar(key) {
	const char = key.toLowerCase();
	const code = char.charCodeAt(0);
	if (
		(code >= 97 && code <= 122) ||
		char === "[" ||
		char === "\\" ||
		char === "]" ||
		char === "_"
	) {
		return String.fromCharCode(code & 0x1f);
	}
	if (char === "-") return String.fromCharCode(31);
	return null;
}

function modifierValue(event) {
	let mod = 0;
	if (event.shiftKey) mod |= MOD.shift;
	if (event.altKey) mod |= MOD.alt;
	if (event.ctrlKey) mod |= MOD.ctrl;
	return mod;
}

/** `CSI 1;<mod+1><final>` for arrows/home/end, or the plain 3-byte form when unmodified. */
function csiCursor(mod, final) {
	return mod === 0 ? `\x1b[${final}` : `\x1b[1;${mod + 1}${final}`;
}

/** `CSI <num>;<mod+1>~` for delete/insert/pgup/pgdn, or the plain form when unmodified. */
function csiFunctional(num, mod) {
	return mod === 0 ? `\x1b[${num}~` : `\x1b[${num};${mod + 1}~`;
}

/** xterm's `modifyOtherKeys` form — the fallback pi-tui's parser accepts for a
 * modified printable/enter/tab/escape/space/backspace it has no simpler encoding for. */
function modifyOtherKeys(codepoint, mod) {
	return `\x1b[27;${mod + 1};${codepoint}~`;
}

/**
 * Encodes one `KeyboardEvent` (already merged with any sticky Ctrl/Alt from
 * the mobile soft-key bar) into terminal bytes, or `null` if this key isn't
 * part of the supported contract (e.g. a bare modifier keydown, or a
 * function key outside the soft-key bar's scope) and should fall through to
 * the browser / a regular `input` event instead.
 */
export function encodeKeyEvent(event) {
	const mod = modifierValue(event);
	switch (event.key) {
		case "Escape":
			return mod === 0 ? "\x1b" : null;
		case "Enter":
			if (mod === 0) return "\r";
			if (mod === MOD.shift) return "\x1b\r";
			if (mod === MOD.alt) return "\x1b\r";
			return modifyOtherKeys(13, mod);
		case "Tab":
			if (mod === 0) return "\t";
			if (mod === MOD.shift) return "\x1b[Z";
			return modifyOtherKeys(9, mod);
		case "Backspace":
			if (mod === MOD.alt) return "\x1b\x7f";
			return "\x7f";
		case "Delete":
			return csiFunctional(3, mod);
		case "Insert":
			return csiFunctional(2, mod);
		case "Home":
			return csiCursor(mod, "H");
		case "End":
			return csiCursor(mod, "F");
		case "PageUp":
			return csiFunctional(5, mod);
		case "PageDown":
			return csiFunctional(6, mod);
		case "ArrowUp":
			return csiCursor(mod, "A");
		case "ArrowDown":
			return csiCursor(mod, "B");
		case "ArrowRight":
			return csiCursor(mod, "C");
		case "ArrowLeft":
			return csiCursor(mod, "D");
		case " ":
			if (mod === MOD.ctrl) return "\x00";
			if (mod === MOD.alt) return "\x1b ";
			if (mod === 0) return " ";
			return modifyOtherKeys(32, mod);
		default:
			break;
	}
	if (event.key.length !== 1) return null;
	const ctrl = (mod & MOD.ctrl) !== 0;
	const alt = (mod & MOD.alt) !== 0;
	if (ctrl) {
		const ctrlChar = rawCtrlChar(event.key);
		if (ctrlChar) return alt ? `\x1b${ctrlChar}` : ctrlChar;
	}
	if (alt) return `\x1b${event.key}`;
	return event.key;
}

const softKeyToEvent = {
	escape: { key: "Escape" },
	tab: { key: "Tab" },
	up: { key: "ArrowUp" },
	down: { key: "ArrowDown" },
	left: { key: "ArrowLeft" },
	right: { key: "ArrowRight" },
	enter: { key: "Enter" },
};

/** Sticky Ctrl/Alt state (mobile soft-key bar), consumed by the next dispatched key. */
const sticky = { ctrl: false, alt: false };

function stickyModifiers() {
	return { ctrlKey: sticky.ctrl, altKey: sticky.alt, shiftKey: false };
}

function clearSticky() {
	if (!sticky.ctrl && !sticky.alt) return;
	sticky.ctrl = false;
	sticky.alt = false;
	for (const button of document.querySelectorAll(".terminal-key-sticky")) {
		button.setAttribute("aria-pressed", "false");
	}
}

let probe;
function ensureProbe() {
	if (probe?.isConnected) return probe;
	probe = document.createElement("pre");
	probe.className = "terminal-surface-body terminal-surface-probe";
	probe.setAttribute("aria-hidden", "true");
	probe.style.cssText =
		"position:absolute;visibility:hidden;left:-9999px;top:-9999px;pointer-events:none;height:auto;flex:none;";
	probe.textContent = "M".repeat(20);
	document.body.appendChild(probe);
	return probe;
}

function inlinePadding(element) {
	const style = getComputedStyle(element);
	return (
		(Number.parseFloat(style.paddingInlineStart) || 0) +
		(Number.parseFloat(style.paddingInlineEnd) || 0)
	);
}

function measureCell() {
	const element = ensureProbe();
	const rect = element.getBoundingClientRect();
	// The probe shares `.terminal-surface-body`'s padding; measure its content box only,
	// or every cell reads ~padding/20 px too wide and grids fit ~10% short of the pane.
	const width = (rect.width - inlinePadding(element)) / 20;
	const height =
		rect.height || Number.parseFloat(getComputedStyle(element).lineHeight) || 0;
	if (!width || !height) return undefined;
	return { width, height };
}

async function postJson(url, body) {
	try {
		await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		// Best-effort: a dropped keystroke/resize on a flaky connection isn't
		// worth surfacing — the next one (or the SSE reconnect) catches up.
	}
}

/** Per-surface input not yet posted; sends are serialized so keystrokes can't arrive out of order. */
const queuedInput = new Map();
const sendingSurfaces = new Set();

async function flushInput(surfaceId) {
	sendingSurfaces.add(surfaceId);
	while (queuedInput.has(surfaceId)) {
		const data = queuedInput.get(surfaceId);
		queuedInput.delete(surfaceId);
		await postJson(endpoints.terminalSurfaceInput, { surfaceId, data });
	}
	sendingSurfaces.delete(surfaceId);
}

function sendInput(surfaceId, data) {
	if (!surfaceId || !data) return;
	// Keys typed while a post is in flight are batched into the next one, in order.
	queuedInput.set(surfaceId, (queuedInput.get(surfaceId) ?? "") + data);
	if (!sendingSurfaces.has(surfaceId)) void flushInput(surfaceId);
}

const pendingResize = new Map();

function surfaceIdOf(element) {
	return element?.closest(gridSelector)?.dataset.terminalSurfaceGrid;
}

function scheduleResize(grid) {
	const id = grid.dataset.terminalSurfaceGrid;
	if (!id) return;
	clearTimeout(pendingResize.get(id));
	pendingResize.set(
		id,
		setTimeout(() => {
			pendingResize.delete(id);
			sendResize(id, grid);
		}, 120),
	);
}

/**
 * The height a grid's terminal reports as its rows. An overlay's dialog is sized to what the
 * component rendered, so its current height says nothing about the terminal: pi-tui lays
 * overlays out against the whole terminal (`maxHeight: "85%"` of its rows), and a component
 * that sizes itself from `terminal.rows` (ask_user's overlay) would see a few rows, render a
 * "terminal too short" stub, and keep the dialog that small. Report the height the dialog can
 * grow to instead; it stays the same as the dialog grows, so this can't feed back on itself.
 */
function availableHeight(grid, rect) {
	if (grid.dataset.terminalSurfaceKind !== "overlay") return rect.height;
	const content = grid.closest(".terminal-surface-dialog-content");
	if (!content) return rect.height;
	const maxHeight = Number.parseFloat(getComputedStyle(content).maxHeight);
	if (!Number.isFinite(maxHeight)) return rect.height;
	const chrome = content.getBoundingClientRect().height - rect.height;
	return Math.max(rect.height, maxHeight - chrome);
}

function sendResize(surfaceId, grid) {
	const cell = measureCell();
	if (!cell) return;
	const rect = grid.getBoundingClientRect();
	const body = grid.querySelector(bodySelector);
	// The body's client box (inside its border and any scrollbar, minus padding) is
	// what lines actually get; the grid's border box over-fits by a column on phones.
	const available = body ? body.clientWidth - inlinePadding(body) : rect.width;
	const cols = Math.max(20, Math.floor(available / cell.width));
	const rows = Math.max(3, Math.floor(availableHeight(grid, rect) / cell.height));
	const previousCols = Number(body?.dataset.cols);
	const previousRows = Number(body?.dataset.rows);
	if (cols === previousCols && rows === previousRows) return;
	postJson(endpoints.terminalSurfaceResize, { surfaceId, cols, rows });
}

let resizeObserver;
function ensureResizeObserver() {
	if (resizeObserver || typeof ResizeObserver === "undefined") return resizeObserver;
	resizeObserver = new ResizeObserver((entries) => {
		for (const entry of entries) scheduleResize(entry.target);
	});
	return resizeObserver;
}

const observedGrids = new WeakSet();
function observeNewGrids(root = document) {
	const observer = ensureResizeObserver();
	if (!observer) return;
	for (const grid of root.querySelectorAll(gridSelector)) {
		if (observedGrids.has(grid)) continue;
		observedGrids.add(grid);
		observer.observe(grid);
		// A freshly mounted surface hasn't told the server its measured size
		// yet — resize immediately rather than waiting for the next layout
		// change, so it starts at the right column/row count.
		scheduleResize(grid);
		// A non-overlay `custom()` surface takes the prompt editor's place (and its
		// focus) in the TUI, so it takes keyboard focus here too as soon as it mounts;
		// overlays get it from `terminalSurfaceOverlayOpenScript` when their dialog opens.
		if (grid.dataset.terminalSurfaceKind === "inline") {
			grid.querySelector(inputSelector)?.focus({ preventScroll: true });
		}
	}
}

/** Surfaces whose hidden input proxy holds keyboard focus while mounted. */
const focusHoldingSurfaceSelector =
	".terminal-surface-inline, .terminal-surface-overlay, .terminal-surface-dialog";

/**
 * Restores focus to the prompt editor once an inline `custom()` surface or an overlay's
 * dialog unmounts (it resolved/was replaced; an overlay closed with Esc is removed by the
 * server while its input proxy still has focus): that proxy is gone, so without this the
 * browser drops focus to `<body>` and keyboard interaction stalls (m5).
 */
export function restoreFocusAfterSurfaceUnmount(removedNodes) {
	if (document.activeElement !== document.body && document.activeElement !== null)
		return;
	const unmounted = [...removedNodes].some(
		(node) =>
			node instanceof Element &&
			(node.matches(focusHoldingSurfaceSelector) ||
				node.querySelector(focusHoldingSurfaceSelector)),
	);
	if (!unmounted) return;
	document.getElementById("prompt-input")?.focus({ preventScroll: true });
}

function handleKeydown(event) {
	const input = event.target;
	if (!(input instanceof HTMLElement) || !input.matches(inputSelector)) return;
	if (event.isComposing) return;
	const surfaceId = surfaceIdOf(input);
	if (!surfaceId) return;
	const merged = {
		key: event.key,
		shiftKey: event.shiftKey,
		ctrlKey: event.ctrlKey || sticky.ctrl,
		altKey: event.altKey || sticky.alt,
	};
	const encoded = encodeKeyEvent(merged);
	if (encoded === null) return;
	event.preventDefault();
	if (input instanceof HTMLTextAreaElement) input.value = "";
	clearSticky();
	sendInput(surfaceId, encoded);
}

/** Handles printable text the IME/mobile keyboard commits via `input`/`compositionend`
 * rather than `keydown` (predictive text, autocomplete, most non-Latin IMEs). */
function handleCompositionEnd(event) {
	const input = event.target;
	if (!(input instanceof HTMLTextAreaElement) || !input.matches(inputSelector)) return;
	const surfaceId = surfaceIdOf(input);
	const text = event.data ?? input.value;
	input.value = "";
	if (surfaceId && text) sendInput(surfaceId, text);
}

function handleInput(event) {
	const input = event.target;
	if (!(input instanceof HTMLTextAreaElement) || !input.matches(inputSelector)) return;
	if (event.isComposing) return;
	// `keydown` already handled and cleared this input for every key this
	// module recognizes; anything that still lands here (soft-keyboard
	// autocomplete/emoji picker insertions, `insertText` without a `keydown`)
	// is forwarded as plain text.
	if (!event.inputType?.startsWith("insertText") || !input.value) return;
	const surfaceId = surfaceIdOf(input);
	const text = input.value;
	input.value = "";
	if (surfaceId) sendInput(surfaceId, text);
}

function handlePaste(event) {
	const input = event.target;
	if (!(input instanceof HTMLElement) || !input.matches(inputSelector)) return;
	const surfaceId = surfaceIdOf(input);
	if (!surfaceId) return;
	const text = event.clipboardData?.getData("text");
	if (!text) return;
	event.preventDefault();
	sendInput(surfaceId, `\x1b[200~${text}\x1b[201~`);
}

const wheelLineSequence = { up: "\x1b[A", down: "\x1b[B" };

function handleWheel(event) {
	const grid =
		event.target instanceof Element ? event.target.closest(gridSelector) : null;
	if (!grid) return;
	const surfaceId = grid.dataset.terminalSurfaceGrid;
	if (!surfaceId || event.deltaY === 0) return;
	event.preventDefault();
	const usePage = event.ctrlKey || Math.abs(event.deltaY) > 240;
	if (usePage) {
		sendInput(surfaceId, event.deltaY > 0 ? "\x1b[6~" : "\x1b[5~");
		return;
	}
	const lines = Math.max(1, Math.min(3, Math.round(Math.abs(event.deltaY) / 40)));
	const sequence = event.deltaY > 0 ? wheelLineSequence.down : wheelLineSequence.up;
	sendInput(surfaceId, sequence.repeat(lines));
}

/**
 * A light-dismissed overlay (`closedby="any"`: Esc, backdrop click, close button) sends the
 * dialog's `close` handler an Esc byte, but an extension `custom()` that doesn't treat Esc as
 * "done" (a long-running `Component` with its own exit key) never tears the surface down —
 * it just keeps running behind a now-hidden dialog. Reopen it non-modally shortly after, if
 * its grid is still mounted, instead of leaving it silently stuck (m10).
 */
function reopenIfStillRunning(dialog) {
	setTimeout(() => {
		if (dialog.open || !dialog.isConnected) return;
		if (dialog.querySelector(gridSelector)) dialog.show();
	}, 400);
}

function handleClick(event) {
	const target = event.target instanceof Element ? event.target : null;
	if (!target) return;
	const keyButton = target.closest("[data-terminal-key]");
	if (keyButton) {
		handleSoftKey(keyButton);
		return;
	}
	const grid = target.closest(gridSelector);
	if (grid && !target.closest(keysBarSelector)) {
		grid.querySelector(inputSelector)?.focus();
	}
}

function handleSoftKey(button) {
	const action = button.dataset.terminalKey;
	const grid = button.closest(gridSelector);
	const surfaceId = grid?.dataset.terminalSurfaceGrid;
	const input = grid?.querySelector(inputSelector);
	if (action === "ctrl" || action === "alt") {
		sticky[action] = !sticky[action];
		button.setAttribute("aria-pressed", sticky[action] ? "true" : "false");
		input?.focus();
		return;
	}
	const base = softKeyToEvent[action];
	if (!base || !surfaceId) return;
	const encoded = encodeKeyEvent({ key: base.key, ...stickyModifiers() });
	clearSticky();
	if (encoded !== null) sendInput(surfaceId, encoded);
	input?.focus();
}

export function bindTerminalSurfaces() {
	observeNewGrids();
	const mutationObserver = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			// A re-mounted surface keeps its slot id (`setHeader`/`setWidget` called again,
			// or every surface re-bound after /reload or a session switch), so the morph
			// reuses the already-observed grid element while the server resets it to the
			// default grid size; the ResizeObserver never fires for that. Re-fit whenever
			// the server-reported size changes (a no-op when it already matches).
			if (mutation.type === "attributes" && mutation.target instanceof Element) {
				const grid = mutation.target.closest(gridSelector);
				if (grid) scheduleResize(grid);
				continue;
			}
			if (mutation.addedNodes.length > 0) observeNewGrids(document);
			if (mutation.removedNodes.length > 0) {
				restoreFocusAfterSurfaceUnmount(mutation.removedNodes);
			}
		}
	});
	for (const root of [
		document.getElementById("terminal-surface-overlays"),
		document.getElementById("terminal-surface-persistent"),
		// Footer and `belowEditor` widget surfaces live in this sibling container
		// (after the prompt editor); without observing it, a surface mounted there
		// after page load is never ResizeObserver-fitted and stays at the default grid.
		document.getElementById("terminal-surface-persistent-below"),
	]) {
		if (root) {
			mutationObserver.observe(root, {
				childList: true,
				subtree: true,
				attributeFilter: ["data-cols", "data-rows"],
			});
		}
	}
	document.addEventListener("keydown", handleKeydown);
	document.addEventListener("compositionend", handleCompositionEnd);
	document.addEventListener("input", handleInput);
	document.addEventListener("paste", handlePaste, true);
	document.addEventListener("wheel", handleWheel, { passive: false });
	document.addEventListener("click", handleClick);
	document.addEventListener(
		"close",
		(event) => {
			const dialog = event.target;
			if (
				dialog instanceof HTMLElement &&
				dialog.matches(".terminal-surface-dialog")
			) {
				reopenIfStillRunning(dialog);
			}
		},
		true,
	);
}

import { endpoints } from "../../src/server/routes/endpoints.ts";
import { promptInput } from "./prompt.js";
import { encodeKeyEvent } from "./terminal-keys.js";

/**
 * Client-side companion for `pi.registerShortcut()` (F1 §1) and prompt-level
 * `ctx.ui.onTerminalInput` forwarding (F1 §2). Both read the hidden data
 * island `prompt-status.tsx` renders (`#extension-shortcuts-data`) fresh on
 * every keydown rather than caching it, so a session/extension switch never
 * leaves this module holding a stale shortcut list.
 *
 * Precedence ("never overriding pi-ui's own keybinds unless pi's TUI would
 * give the extension precedence — mirror the TUI's precedence rules", plan
 * F1 §1): the server already excludes any extension shortcut that collides
 * with pi-ui's own keybind catalog or a reserved pi-tui built-in (see
 * `extension-shortcuts.ts`), so a matched shortcut here can never be one of
 * pi-ui's own. On top of that, `handleShortcutKeydown` only ever matches
 * AFTER pi-ui's own handlers for the SAME event have run (any handler that
 * already called `preventDefault()` — including the prompt textarea's own
 * inline Escape/Enter handling — is skipped via `event.defaultPrevented`) —
 * mirroring the *shape* of the TUI's own layered dispatch (raw
 * `onTerminalInput` listeners first, then focused-component handling) without
 * needing to reproduce every one of its internal precedence rules, since the
 * exclusion above already prevents the cases where getting that order wrong
 * would matter.
 *
 * Prompt-level `onTerminalInput` forwarding only intercepts a bounded
 * "candidate" set — Escape unconditionally, and arrows/a single unmodified
 * character only while the prompt is empty — so ordinary multi-line typing
 * and cursor movement never pay a round trip; see `isForwardCandidate`'s doc
 * comment. Forwarding a candidate always preventDefault()s it up front (the
 * round trip has to decide first), which also stands down prompt-box.tsx's
 * own target-phase handling for that same keypress — including its
 * Escape-blurs-the-prompt convenience, since that handler runs on the
 * textarea itself and always fires before this module's `document`-level
 * listener ever sees the event (see `promptLevelInputActive`'s doc comment).
 * A consumed key never reaches the textarea; an unconsumed one is inserted
 * (or, for Escape, blurs the prompt via `blurPromptIfIdle`) exactly as if
 * this module had never intercepted it.
 */

const dataIslandId = "extension-shortcuts-data";
const promptInputId = "prompt-input";
const captureIndicatorId = "extension-capture-indicator";
const captureIndicatorMs = 1500;

const keyIdTokenAliases = {
	escape: "Escape",
	esc: "Escape",
	enter: "Enter",
	return: "Enter",
	tab: "Tab",
	space: " ",
	backspace: "Backspace",
	delete: "Delete",
	insert: "Insert",
	clear: "Clear",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	f1: "F1",
	f2: "F2",
	f3: "F3",
	f4: "F4",
	f5: "F5",
	f6: "F6",
	f7: "F7",
	f8: "F8",
	f9: "F9",
	f10: "F10",
	f11: "F11",
	f12: "F12",
};

/** Matches a base (non-modifier) `KeyId` token — everything after the last
 * `+` — against a `KeyboardEvent`. Special-key tokens compare against
 * `event.key`'s named form; a single-character token compares
 * case-insensitively for a letter (pi-tui's `KeyId` letters are always
 * lowercase regardless of Shift, which is its own explicit modifier bit) and
 * literally otherwise (pi-tui's `SymbolKey` union already lists shifted
 * punctuation like `"!"` as its own base key, so `event.key` — which a
 * browser already reports as `"!"` when Shift+1 is pressed on a US layout —
 * needs no further shift handling here). */
function matchesBaseToken(event, token) {
	const mapped = keyIdTokenAliases[token];
	if (mapped !== undefined) return event.key === mapped;
	if (token.length !== 1) return false;
	if (/[a-z]/.test(token)) return event.key.toLowerCase() === token;
	return event.key === token;
}

/**
 * Matches a `KeyboardEvent` against a pi-tui `KeyId` string (`"alt+o"`,
 * `"ctrl+shift+p"`, `"escape"`) the way `ExtensionRunner.getShortcuts()` keys
 * its map and `matchesKey()`/`parseKey()` (`@earendil-works/pi-tui`'s
 * `dist/keys.js`) would over the raw terminal bytes those same keys encode
 * to. Every modifier the `KeyId` names must be held, and every one it
 * doesn't must NOT be held — an unqualified `"o"` never matches Alt+O, and
 * `"alt+o"` never matches Ctrl+Alt+O.
 */
export function matchesKeyId(event, keyId) {
	const parts = keyId.toLowerCase().split("+");
	const base = parts.pop();
	if (base === undefined) return false;
	const mods = new Set(parts);
	if (event.ctrlKey !== mods.has("ctrl")) return false;
	if (event.altKey !== mods.has("alt")) return false;
	if (event.metaKey !== mods.has("super")) return false;
	if (event.shiftKey !== mods.has("shift")) return false;
	return matchesBaseToken(event, base);
}

/**
 * Whether `event` is a candidate for prompt-level `onTerminalInput`
 * forwarding (F1 §2). Escape is always a candidate — extension state (a
 * pending confirmation, a manage-mode toggle) can legitimately want it
 * regardless of what else is in the prompt, and forwarding it costs nothing:
 * it never inserts a character, so preventing its (nonexistent) default and
 * awaiting the server's answer is invisible either way. Arrows and a single
 * unmodified character are candidates only while the prompt is empty — the
 * only state where every extension observed using them (`bash-background.ts`,
 * `subagents.ts` manage mode) actually reads them — so a normal multi-line
 * edit's cursor movement and typing never wait on a round trip.
 */
export function isForwardCandidate(event, promptEmpty) {
	if (event.ctrlKey || event.metaKey || event.altKey) return false;
	if (event.key === "Escape") return true;
	if (!promptEmpty) return false;
	if (
		event.key === "ArrowUp" ||
		event.key === "ArrowDown" ||
		event.key === "ArrowLeft" ||
		event.key === "ArrowRight"
	) {
		return true;
	}
	return event.key.length === 1;
}

function dataIsland() {
	return document.getElementById(dataIslandId);
}

/** Only shortcuts pi-ui's own keybinds don't already claim — one flagged
 * `reachableByKeyboard: false` (colliding with a pi-ui bind) is still listed
 * in the data island for the `/hotkeys` dialog and command palette, but is
 * never matched here; see `AppExtensionShortcut`'s doc comment. */
function currentShortcutKeys() {
	const container = dataIsland();
	if (!container) return [];
	return [...container.children].flatMap((el) => {
		const keyId = el.dataset.key ?? "";
		return keyId && el.dataset.reachable !== undefined ? [keyId] : [];
	});
}

/**
 * Whether some `ctx.ui.onTerminalInput` listener is currently registered
 * outside a focused terminal surface — exposed on `window.piUi.extensionKeys`
 * (see `main.js`) so `prompt-box.tsx`'s own inline Escape-blurs-the-prompt
 * handling can stand down while an extension *might* want the very next
 * Escape, instead of racing this module's own (bubble-phase, later-running)
 * forwarding for the same keypress: prompt-box.tsx's handler is on the
 * textarea itself, so it always runs (at the "target" phase) before this
 * module's `document`-level (bubble-phase) listener ever sees the event, and
 * whether an extension actually wants THIS keypress can only be known after
 * an async round trip — too late for prompt-box.tsx's synchronous handler to
 * wait on. So this flag is necessarily coarser than one keypress: it stays
 * true for as long as `bash-background.ts`/`subagents.ts`-style extensions
 * keep a listener registered, which in practice is the whole session, not
 * just while their own "manage mode" is active — meaning most forwarded keys
 * still come back `{consumed: false}`. `handlePromptLevelKeydown` restores
 * prompt-box.tsx's own Escape-blur behavior itself in exactly that case (see
 * its doc comment and `blurPromptIfIdle`) — round-5 runtime-validation
 * finding, fixed in two parts across both modules.
 */
export function promptLevelInputActive() {
	return dataIsland()?.dataset.terminalInputActive !== undefined;
}

/** Only while focus is the prompt itself (or nothing/`<body>`, e.g. right
 * after a page load) — never while a dialog, a terminal surface's hidden
 * input proxy, or any other native control owns it. */
function focusInScope() {
	const active = document.activeElement;
	if (active === null || active === document.body) return true;
	return active.id === promptInputId;
}

async function postJson(url, body) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return response;
}

function invokeShortcut(keyId) {
	// Fire-and-forget, like pi-tui's own `Promise.resolve(handler(...)).catch(...)`
	// (`setupExtensionShortcuts`): the server runs the handler asynchronously and
	// reports a failure as a notice, so there is nothing useful to await here.
	void postJson(endpoints.extensionShortcutInvoke, { keyId }).catch(() => {
		// Best-effort, matching terminal-keys.js's `postJson`: a dropped
		// keystroke on a flaky connection isn't worth surfacing.
	});
}

let captureIndicatorTimer;

function flashCaptureIndicator() {
	const indicator = document.getElementById(captureIndicatorId);
	if (!indicator) return;
	indicator.hidden = false;
	clearTimeout(captureIndicatorTimer);
	captureIndicatorTimer = setTimeout(() => {
		indicator.hidden = true;
	}, captureIndicatorMs);
}

/** Inserts `text` at the caret the way native typing would, for a candidate
 * key this module preventDefault()'d but no listener consumed — the prompt is
 * always empty when this runs (see `isForwardCandidate`), so this is just
 * "set the value to the typed character" plus a real `input` event for
 * Datastar's `data-bind:prompt` to pick up. */
function insertUnconsumedChar(input, text) {
	input.value = text;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.selectionStart = input.value.length;
	input.selectionEnd = input.value.length;
}

/** Replicates `prompt-box.tsx`'s own inline Escape-blurs-the-prompt handling,
 * for an Escape this module forwarded (and preventDefault()'d) but no
 * `ctx.ui.onTerminalInput` listener consumed. Needed because forwarding a
 * candidate Escape always preventDefault()s it before awaiting the server's
 * answer — see `handlePromptLevelKeydown`'s doc comment — which stands down
 * prompt-box.tsx's own target-phase handler for that same keypress (it never
 * sees `defaultPrevented` false to act on). Same gating prompt-box.tsx's own
 * handler uses, minus the modifier checks `isForwardCandidate` already made
 * (ctrl/meta/alt) — only Shift needs rechecking here, since Escape is a
 * forward candidate regardless of it. */
function blurPromptIfIdle(input, event) {
	if (event.shiftKey) return;
	if (window.piUi.pickers.isOpen()) return;
	if (!document.querySelector("[data-send-trigger]")) return;
	input?.blur();
}

async function handlePromptLevelKeydown(event) {
	if (event.defaultPrevented || event.isComposing) return;
	if (!promptLevelInputActive() || !focusInScope()) return;
	const input = promptInput();
	const promptEmpty = !input || input.value.length === 0;
	if (!isForwardCandidate(event, promptEmpty)) return;
	const encoded = encodeKeyEvent(event);
	if (encoded === null) return;
	event.preventDefault();
	let consumed = false;
	try {
		const response = await postJson(endpoints.extensionPromptInput, {
			data: encoded,
		});
		consumed = Boolean((await response.json()).consumed);
	} catch {
		// Best-effort: treat a dropped request as "not consumed" below, the
		// same as an extension that declined the key.
	}
	if (consumed) {
		flashCaptureIndicator();
		return;
	}
	if (event.key === "Escape") {
		blurPromptIfIdle(input, event);
		return;
	}
	if (promptEmpty && event.key.length === 1 && input) {
		insertUnconsumedChar(input, event.key);
	}
}

function handleShortcutKeydown(event) {
	if (event.defaultPrevented || event.isComposing || !focusInScope()) return;
	for (const keyId of currentShortcutKeys()) {
		if (!matchesKeyId(event, keyId)) continue;
		event.preventDefault();
		invokeShortcut(keyId);
		return;
	}
}

export function bindExtensionKeys() {
	document.addEventListener("keydown", async (event) => {
		// Prompt-level `onTerminalInput` forwarding goes first, mirroring the
		// real TUI's raw `inputListeners`, which see every keystroke before any
		// focused-component dispatch (including `registerShortcut`'s own
		// editor-level `onExtensionShortcut` check) — see this module's doc
		// comment. In practice this ordering costs nothing for the vast
		// majority of shortcuts (anything with a modifier held fails
		// `isForwardCandidate`'s very first check and returns before ever
		// awaiting a request).
		await handlePromptLevelKeydown(event);
		if (!event.defaultPrevented) handleShortcutKeydown(event);
	});
}

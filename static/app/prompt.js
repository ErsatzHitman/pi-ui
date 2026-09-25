import { duration, easing, reducedMotion } from "./motion.js";

export function promptInput() {
	const input = document.getElementById("prompt-input");
	return input instanceof HTMLTextAreaElement ? input : undefined;
}

export function setPromptValue(value) {
	const input = promptInput();
	if (!input) return;
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** How long the placeholder stays hidden after a send clear (the ghost's first half). */
const placeholderHoldMs = 80;
/** A failed first send keeps its empty state: the fade is undone after this long. */
const emptyStateRestoreMs = 1500;

/**
 * Send-time clear (Enter, Send click, /copy): the typed text lifts off as a ghost while
 * the composer collapses, and the empty state (first message) fades out, all at t=0 with
 * no network wait (flow-spec §6, C5).
 */
export function clearPromptForSend() {
	const input = promptInput();
	if (!input) return;
	const text = input.value;
	const reduce = reducedMotion();
	if (text) ghostPromptText(input, reduce);
	const before = input.offsetHeight;
	setPromptValue("");
	const after = input.offsetHeight;
	if (text) holdPlaceholder(input);
	if (!reduce && before - after > 1) {
		input.animate([{ height: `${before}px` }, { height: `${after}px` }], {
			duration: duration.md,
			easing: easing.out,
		});
	}
	const empty = document.querySelector("#messages .messages-empty-state");
	if (empty instanceof HTMLElement && fadesEmptyState(text)) {
		const fade = empty.animate(
			[
				{ opacity: 1, transform: "none" },
				reduce
					? { opacity: 0 }
					: { opacity: 0, transform: "translateY(-0.25rem)" },
			],
			{ duration: duration.sm, easing: easing.out, fill: "forwards" },
		);
		setTimeout(() => {
			if (empty.isConnected) fade.cancel();
		}, emptyStateRestoreMs);
	}
}

/** Pure (unit-tested): `/copy` is local, so it never fades the empty state away. */
export function fadesEmptyState(text) {
	return text.trim() !== "/copy";
}

/**
 * Pure (unit-tested): inline style for the send ghost, a fixed copy of the textarea's
 * text box at `rect` using the textarea's computed type metrics.
 */
export function promptGhostStyle(rect, style) {
	return {
		position: "fixed",
		left: `${rect.left}px`,
		top: `${rect.top}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`,
		margin: "0",
		boxSizing: "border-box",
		overflow: "hidden",
		pointerEvents: "none",
		zIndex: "90",
		font: style.font,
		lineHeight: style.lineHeight,
		letterSpacing: style.letterSpacing,
		padding: style.padding,
		color: style.color,
		whiteSpace: "pre-wrap",
		overflowWrap: style.overflowWrap,
		textAlign: style.textAlign,
	};
}

function ghostPromptText(input, reduce) {
	const ghost = document.createElement("div");
	ghost.className = "prompt-ghost";
	ghost.setAttribute("aria-hidden", "true");
	const inner = document.createElement("div");
	inner.textContent = input.value;
	inner.style.translate = `0 ${-input.scrollTop}px`;
	ghost.append(inner);
	Object.assign(
		ghost.style,
		promptGhostStyle(input.getBoundingClientRect(), getComputedStyle(input)),
	);
	document.body.append(ghost);
	const animation = ghost.animate(
		[
			{ opacity: 1, transform: "none" },
			reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(-0.5rem)" },
		],
		{ duration: duration.sm, easing: easing.out, fill: "forwards" },
	);
	const remove = () => ghost.remove();
	animation.finished.then(remove, remove);
}

/**
 * Hides only the placeholder while the ghost lifts (messages.css), so the caret and any
 * fast follow-up typing stay visible (flow-critique #23).
 */
function holdPlaceholder(input) {
	input.setAttribute("data-placeholder-hold", "");
	setTimeout(() => input.removeAttribute("data-placeholder-hold"), placeholderHoldMs);
}

export function focusPromptEnd() {
	const input = promptInput();
	if (!input) return;
	input.focus({ preventScroll: true });
	input.selectionStart = input.value.length;
	input.selectionEnd = input.value.length;
}

/**
 * Places a notice element above the whole editor row (a flex row: the voice panel, the
 * textarea, and the editor actions) instead of directly before the textarea within that
 * row. Inserting it inside the row turns it into a flex column that squeezes the
 * textarea — at 390px down to a couple of words per line, and even at 1280px by roughly a
 * third — instead of the notice spanning the full prompt surface above everything. Shared
 * by every prompt notice with this shape: voice.js's errors/blocked explanations
 * (DESIGN-voice.md's original fix) and file-transfer.js's showTransferError (the same bug,
 * fixed the same way — AUDIT-voice.md remaining #1).
 */
export function placeNoticeAbovePromptRow(el, input) {
	(input.closest(".prompt-editor-row") ?? input).before(el);
}

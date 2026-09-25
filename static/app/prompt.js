import { setComposerSettle } from "./message-scroll.js";
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

/** How long the placeholder stays hidden once the ghost has started lifting. */
const placeholderHoldMs = 80;
/** The empty state starts fading when the user article lands, or after this long. */
const emptyStateHandoffMs = 150;
/** The lifted ghost waits this long at most for its user article before it exits. */
const ghostHoldMs = 1500;
/** A live-appended user article (messages.tsx markEntering): the send has landed. */
const userArrivalSelector = "#message-list > .message-user[data-enter]";

/**
 * Send-time clear (Enter, Send click, /copy): the typed text lifts off as a ghost while
 * the composer collapses, all at t=0 with no network wait (flow-spec §6, C5). A send that
 * appends a message hands off on the server's clock, not a timer's: the ghost holds,
 * lifted and dimmed, and the empty state (first message) stays until the user article
 * lands (or briefly), so a slow send never shows a blank transcript. A failed send fades
 * the empty state back (file-transfer.js `pi-ui-prompt-send-failed`).
 */
export function clearPromptForSend() {
	const input = promptInput();
	if (!input) return;
	const text = input.value;
	const reduce = reducedMotion();
	const appends = fadesEmptyState(text);
	const box = document.getElementById("prompt-box");
	const boxBefore = box instanceof HTMLElement ? box.offsetHeight : undefined;
	const ghost = text ? ghostPromptText(input, reduce, appends) : undefined;
	// Hidden before the value clears, so the placeholder never paints over the ghost.
	if (ghost) holdPlaceholder(input, ghost.animation);
	const before = input.offsetHeight;
	setPromptValue("");
	const after = input.offsetHeight;
	// The composer's settled height, for the prompt spacer (message-scroll.js). Read
	// before the clear, so it holds whether or not the collapse below tweens (reduced
	// motion steps the whole difference at once).
	if (boxBefore !== undefined)
		setComposerSettle(boxBefore - (before - after), performance.now() + duration.md);
	if (!reduce && before - after > 1) {
		input.animate([{ height: `${before}px` }, { height: `${after}px` }], {
			duration: duration.md,
			easing: easing.out,
		});
	}
	if (appends) awaitSendArrival(ghost, reduce);
}

/**
 * Waits for the send's user article (one-shot observer on #messages' subtree, since
 * #message-list can be replaced). On arrival, or after `ghostHoldMs`, the ghost exits.
 * The empty state starts fading on arrival or after `emptyStateHandoffMs`, whichever
 * comes first, and fades back in if the send fails.
 */
function awaitSendArrival(ghost, reduce) {
	const messages = document.getElementById("messages");
	const emptyNode = document.querySelector("#messages .messages-empty-state");
	const empty = emptyNode instanceof HTMLElement ? emptyNode : undefined;
	const seen = new Set(document.querySelectorAll(userArrivalSelector));
	let fade;
	let settled = false;
	let fadeTimer;
	let holdTimer;
	let observer;
	const fadeEmpty = () => {
		clearTimeout(fadeTimer);
		if (fade || !empty?.isConnected) return;
		fade = empty.animate(
			[
				{ opacity: 1, transform: "none" },
				reduce
					? { opacity: 0 }
					: { opacity: 0, transform: "translateY(-0.25rem)" },
			],
			{ duration: duration.sm, easing: easing.out, fill: "forwards" },
		);
	};
	const settle = () => {
		if (settled) return;
		settled = true;
		observer?.disconnect();
		clearTimeout(holdTimer);
		ghost?.exit();
	};
	const failed = () => {
		settle();
		clearTimeout(fadeTimer);
		if (fade && empty?.isConnected) fade.reverse();
		ghost?.remove();
	};
	// file-transfer.js reports a failure before it reports the submit finished.
	const finished = () =>
		setTimeout(() =>
			document.removeEventListener("pi-ui-prompt-send-failed", failed),
		);
	const arrived = () => {
		settle();
		fadeEmpty();
		document.removeEventListener("pi-ui-prompt-send-failed", failed);
		document.removeEventListener("pi-ui-prompt-submit-finished", finished);
	};
	if (empty) fadeTimer = setTimeout(fadeEmpty, emptyStateHandoffMs);
	if (messages instanceof HTMLElement) {
		observer = new MutationObserver(() => {
			for (const article of document.querySelectorAll(userArrivalSelector)) {
				if (!seen.has(article)) {
					arrived();
					return;
				}
			}
		});
		observer.observe(messages, { childList: true, subtree: true });
	}
	holdTimer = setTimeout(settle, ghostHoldMs);
	document.addEventListener("pi-ui-prompt-send-failed", failed, { once: true });
	document.addEventListener("pi-ui-prompt-submit-finished", finished, { once: true });
}

/**
 * Pure (unit-tested): whether a send appends a message. Slash commands (`/copy` is local,
 * `/model` opens a picker, ...) append none, so they never fade the empty state.
 */
export function fadesEmptyState(text) {
	return !text.trimStart().startsWith("/");
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

/**
 * Pure (unit-tested): the ghost's keyframes. `hold`: the lift stops dimmed (0.35), waiting
 * for the send to land; `exit` is one keyframe, so it starts from wherever the lift is.
 * Reduced motion: opacity only.
 */
export function promptGhostKeyframes(reduce, hold) {
	const gone = reduce
		? { opacity: 0 }
		: { opacity: 0, transform: "translateY(-0.5rem)" };
	const held = reduce
		? { opacity: 0.35 }
		: { opacity: 0.35, transform: "translateY(-0.5rem)" };
	return {
		lift: [{ opacity: 1, transform: "none" }, hold ? held : gone],
		exit: [gone],
	};
}

function ghostPromptText(input, reduce, hold) {
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
	const keyframes = promptGhostKeyframes(reduce, hold);
	const timing = { duration: duration.sm, easing: easing.out, fill: "forwards" };
	const animation = ghost.animate(keyframes.lift, timing);
	const remove = () => ghost.remove();
	if (!hold) animation.finished.then(remove, remove);
	return {
		animation,
		remove,
		exit() {
			if (!ghost.isConnected) return;
			ghost.animate(keyframes.exit, timing).finished.then(remove, remove);
		},
	};
}

/**
 * Hides only the placeholder while the ghost lifts (messages.css), so the caret and any
 * fast follow-up typing stay visible (flow-critique #23). Released on the ghost's clock,
 * `placeholderHoldMs` after its lift actually starts, not on the send's wall clock.
 */
function holdPlaceholder(input, ghostAnimation) {
	input.setAttribute("data-placeholder-hold", "");
	const release = () =>
		setTimeout(
			() => input.removeAttribute("data-placeholder-hold"),
			placeholderHoldMs,
		);
	ghostAnimation.ready.then(release, release);
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

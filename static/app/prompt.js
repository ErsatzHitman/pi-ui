import { setComposerSettle } from "./message-scroll.js";
import { duration, easing, ghostExit, reducedMotion } from "./motion.js";

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

/** How long the placeholder stays hidden once the ghost has started lifting: until the
 * ghost has all but faded (it is gone at `duration.md`), then the placeholder's own fade. */
const placeholderHoldMs = duration.sm;
/** The empty state waits this long at most for the send's user article before it fades. */
const emptyStateHoldMs = 1500;
/** How far the empty state's handoff exit is already into its fade when its first frame
 * paints: about one frame, so it is under a third of its opacity at once (flow-critique
 * first-message handoff). */
export const handoffLeadMs = 16;
/** The first user article's fade waits this long (messages.css, `transition-delay` on the
 * session's first `.message-user[data-enter]`): the exit above is then all but done, so the
 * heading is gone before the bubble is visible over it. Mirrored in messages.css. */
export const handoffArticleDelayMs = 40;
/** A live-appended user article (messages.tsx markEntering): the send has landed. */
const userArrivalSelector = "#message-list > .message-user[data-enter]";

/**
 * Send-time clear (Enter, Send click, /copy): the typed text lifts off as a ghost while
 * the composer collapses, all at t=0 with no network wait (flow-spec §6, C5). The ghost is
 * never held: it lifts and fades out over `duration.md` on every send (steers, queued and
 * slow sends too), so it can never sit over the settled composer or its placeholder. On the
 * first message the empty state bridges a slow send instead: it stays until the first
 * article lands (`emptyStateHoldMs` at most), then hands off to it: gone within 80ms, before
 * the article is legible. A failed send keeps it (file-transfer.js
 * `pi-ui-prompt-send-failed`).
 */
export function clearPromptForSend() {
	const input = promptInput();
	if (!input) return;
	const text = input.value;
	const reduce = reducedMotion();
	// Placed and the placeholder hidden before the value clears, so the placeholder never
	// paints over the ghost; the ghost starts once the collapse is measured.
	const ghost = text ? placePromptGhost(input) : undefined;
	if (ghost) input.setAttribute("data-placeholder-hold", "");
	const before = input.offsetHeight;
	setPromptValue("");
	const after = input.offsetHeight;
	if (ghost) {
		const lift = ghost.animate(promptGhostKeyframes(reduce, before - after), {
			duration: duration.md,
			easing: easing.out,
			fill: "forwards",
		});
		const remove = () => ghost.remove();
		lift.finished.then(remove, remove);
		releasePlaceholder(input, lift);
	}
	// The textarea's settled height, for the prompt spacer (message-scroll.js): while it
	// collapses the spacer is sized as if it already had, and every other change of the
	// composer (a queued steer easing in) is still tracked live. Under reduced motion the
	// textarea steps, so there is nothing to discount.
	setComposerSettle(after, performance.now() + duration.md);
	if (!reduce && before - after > 1) {
		input.animate([{ height: `${before}px` }, { height: `${after}px` }], {
			duration: duration.md,
			easing: easing.out,
		});
	}
	if (fadesEmptyState(text)) holdEmptyStateForSend(reduce);
}

/**
 * First message only (a no-op without an empty state): keeps the empty state fully visible
 * until the send's first article lands (a one-shot observer on #messages' subtree, since
 * #message-list can be replaced), so a slow send never shows a blank transcript. That
 * morph removes the node, so it then exits as a ghost at its last painted rect
 * (tracked per frame: the composer's collapse moves it). The two share the transcript's
 * middle, so the exit is a handoff, not a crossfade: `duration.xs`, already `handoffLeadMs`
 * in when it first paints, while the article's fade waits `handoffArticleDelayMs`, so the
 * heading is gone before the bubble shows.
 * After `emptyStateHoldMs` without an article it fades in place (`duration.sm`). A failed
 * send keeps it, or fades it back.
 */
export function holdEmptyStateForSend(reduce = reducedMotion()) {
	const messages = document.getElementById("messages");
	const node = document.querySelector("#messages .messages-empty-state");
	if (!(messages instanceof HTMLElement) || !(node instanceof HTMLElement)) return;
	const seen = new Set(document.querySelectorAll(userArrivalSelector));
	const lift = reduce ? "0" : "-0.25rem";
	let rect = node.getBoundingClientRect();
	const hidden = hiddenParts(node);
	let fade;
	let settled = false;
	let raf = 0;
	let capTimer;
	const track = () => {
		if (node.isConnected) rect = node.getBoundingClientRect();
		raf = requestAnimationFrame(track);
	};
	raf = requestAnimationFrame(track);
	const fadeInPlace = (ms = duration.sm) => {
		if (!node.isConnected) return undefined;
		fade = node.animate(
			[
				{ opacity: 1, transform: "none" },
				{ opacity: 0, transform: `translateY(${lift})` },
			],
			{ duration: ms, easing: easing.out, fill: "forwards" },
		);
		return fade;
	};
	const observer = new MutationObserver(() => {
		// Whatever lands first (an extension card before the user article) removes it.
		if (!node.isConnected) {
			arrived();
			return;
		}
		for (const article of document.querySelectorAll(userArrivalSelector)) {
			if (!seen.has(article)) {
				arrived();
				return;
			}
		}
	});
	const stop = () => {
		settled = true;
		observer.disconnect();
		clearTimeout(capTimer);
		cancelAnimationFrame(raf);
	};
	const failed = () => {
		stop();
		if (fade && node.isConnected) fade.reverse();
	};
	// file-transfer.js reports a failure before it reports the submit finished.
	const finished = () =>
		setTimeout(() =>
			document.removeEventListener("pi-ui-prompt-send-failed", failed),
		);
	function arrived() {
		if (settled) return;
		stop();
		document.removeEventListener("pi-ui-prompt-send-failed", failed);
		document.removeEventListener("pi-ui-prompt-submit-finished", finished);
		const exit = node.isConnected
			? fadeInPlace(duration.xs)
			: ghostExit(ghostSource(node, hidden), rect, {
					translateY: lift,
					ms: duration.xs,
				});
		if (exit) exit.currentTime = handoffLeadMs;
	}
	observer.observe(messages, { childList: true, subtree: true });
	// No article yet (a very slow server): fade in place; its morph then removes an
	// already invisible node. A failure after this fades it back.
	capTimer = setTimeout(() => {
		stop();
		fadeInPlace();
	}, emptyStateHoldMs);
	document.addEventListener("pi-ui-prompt-send-failed", failed, { once: true });
	document.addEventListener("pi-ui-prompt-submit-finished", finished, { once: true });
}

/**
 * The indexes (in `querySelectorAll("*")` order) of `root`'s parts hidden by an attribute
 * rule (`[data-keybind-hint]` under a narrow screen or with hints off): ghostExit strips
 * `data-*` from its clone, which would show them and re-lay the ghost out, the heading
 * jumping up by the hint's row. Read while `root` is still rendered.
 */
function hiddenParts(root) {
	const parts = [...(root.querySelectorAll?.("*") ?? [])];
	const hidden = [];
	parts.forEach((part, index) => {
		if (getComputedStyle(part).display === "none") hidden.push(index);
	});
	return hidden;
}

/**
 * Pure (unit-tested): the node a ghost is cloned from, `root` itself when nothing was
 * hidden, else a copy with those parts (hiddenParts) pinned hidden inline, which survives
 * ghostExit's attribute strip, so the ghost is laid out exactly as it was painted.
 */
export function ghostSource(root, hidden) {
	if (hidden.length === 0) return root;
	const copy = root.cloneNode(true);
	const parts = [...copy.querySelectorAll("*")];
	for (const index of hidden) parts[index]?.style.setProperty("display", "none");
	return copy;
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
 * Pure (unit-tested): the ghost's keyframes, one lift that fades fully out (it is never
 * held). The textarea collapses from its top by `collapse` px on the same curve (the
 * composer is bottom-anchored), bringing the widget row above it down through the ghost's
 * box: the ghost is clipped to the collapsing text box, so its lines slide up under that
 * row instead of printing over it. Reduced motion: opacity only, and the box has already
 * collapsed (no height tween), so the clip is fixed there.
 */
export function promptGhostKeyframes(reduce, collapse = 0) {
	const settled = `inset(${Math.max(0, collapse)}px 0px 0px 0px)`;
	if (reduce) {
		return [
			{ opacity: 1, clipPath: settled },
			{ opacity: 0, clipPath: settled },
		];
	}
	return [
		{ opacity: 1, transform: "none", clipPath: "inset(0px 0px 0px 0px)" },
		{
			opacity: 0,
			transform: "translateY(-0.75rem)",
			// In the ghost's own (lifted) space: the collapse plus the lift.
			clipPath: `inset(calc(${Math.max(0, collapse)}px + 0.75rem) 0px 0px 0px)`,
		},
	];
}

/** The ghost's layer, a fixed copy of the textarea's text at its rect (not yet animated). */
function placePromptGhost(input) {
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
	return ghost;
}

/**
 * Releases the placeholder hold (`data-placeholder-hold`, messages.css: only the
 * placeholder is hidden, so the caret and any fast follow-up typing stay visible,
 * flow-critique #23) on the ghost's clock, `placeholderHoldMs` after its lift actually
 * starts (by then it has all but faded), not on the send's wall clock.
 */
function releasePlaceholder(input, ghostAnimation) {
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

import { bindDetailsMotion } from "./details-motion.js";
import { duration, easeOut, easing, motionReady, reducedMotion } from "./motion.js";

const liveEdgeThresholdPx = 8;
const promptSpacerClearancePx = 48;
const scrollControlThresholdPx = 48;
const state = {
	middleScrolling: false,
	pinnedToBottom: true,
	pointerScrolling: false,
	scrollTop: 0,
};
const bottomScrollTimers = new Set();
let anchor;
let historyLoading = false;
let observedMessageStack;
let observedPrompt;
let messageResizeObserver;
let pointerStart;
let blockObserver;
let observedMessageList;

// Pinned follow (flow-spec C3) and explicit jump-to-latest (C-X2 + flow-critique #8):
// rAF tweens of `#messages.scrollTop`, never a native smooth scroll while pinned.
let follow; // { from, to, start, raf }
let jump; // { from, start, raf }

// Send-time spacer hold (flow-critique #7): the composer's collapse is not given back to
// the spacer until the transcript has grown into it, so the pinned transcript never steps
// down. It expires after `spacerHoldMs` whatever happens (failed send, queued steer).
const spacerHoldMs = 1500;
let held; // { px, baseTop, until }
let heldTimer;
let spacerRelease; // { from, start, raf }: a released hold gliding closed

// Transcript-quiet gate (flow-spec C2 + flow-critique #19).
const quietSafetyMs = 5000;
let quietGeneration = 0;
let quietSafetyTimer;

export function bindMessageScroll() {
	document.addEventListener(
		"scroll",
		(event) => {
			const messages = document.getElementById("messages");
			// Ignore captured scroll events from nested tool and code outputs. Layout
			// changes alone never re-arm following; any downward scroll that reaches
			// the live edge does, whatever gesture produced it.
			if (!(messages instanceof HTMLElement) || event.target !== messages) return;
			if (
				(state.middleScrolling || state.pointerScrolling) &&
				messages.scrollTop < state.scrollTop
			)
				markUnpinned();
			const distance =
				messages.scrollHeight - messages.scrollTop - messages.clientHeight;
			if (
				shouldRearmAfterScroll(
					state.pinnedToBottom,
					state.scrollTop,
					messages.scrollTop,
					distance,
				)
			) {
				state.pinnedToBottom = true;
				messages.scrollTop = messages.scrollHeight;
			}
			if (historyLoading && anchor) {
				anchor.userScrollDelta += messages.scrollTop - anchor.lastScrollTop;
				anchor.lastScrollTop = messages.scrollTop;
			}
			state.scrollTop = messages.scrollTop;
			updateScrollControl();
		},
		true,
	);

	// Release follow mode from explicit reader interactions, never from scroll
	// position changes alone: streamed tables, code, and other blocks can resize.
	const releasePointerScroll = (event) => {
		// Browser autoscroll can begin outside the transcript's DOM event path,
		// so middle-button intent is global. Primary drags inside the transcript
		// cover scrollbar movement and text selection without treating clicks as scrolls.
		if (event.button === 1) {
			state.middleScrolling = true;
			markUnpinned();
		} else if (event.button === 0 && isMessageInteraction(event.target)) {
			state.middleScrolling = false;
			state.pointerScrolling = true;
			pointerStart = { x: event.clientX, y: event.clientY };
			const messages = document.getElementById("messages");
			if (messages instanceof HTMLElement) state.scrollTop = messages.scrollTop;
		}
	};
	document.addEventListener("pointerdown", releasePointerScroll, {
		capture: true,
		passive: true,
	});
	document.addEventListener(
		"pointermove",
		(event) => {
			if (
				state.pointerScrolling &&
				pointerStart &&
				hasPointerDragIntent(
					pointerStart.x,
					pointerStart.y,
					event.clientX,
					event.clientY,
				)
			) {
				pointerStart = undefined;
				markUnpinned();
			}
		},
		{ capture: true, passive: true },
	);
	for (const type of ["pointerup", "pointercancel"]) {
		document.addEventListener(
			type,
			() => {
				// Middle-button intent is global (autoscroll, X11 paste), so releasing
				// the button must drop it. Otherwise a later layout clamp during
				// streaming reads as an upward scroll and silently unpins follow mode.
				state.middleScrolling = false;
				state.pointerScrolling = false;
				pointerStart = undefined;
			},
			{ capture: true, passive: true },
		);
	}
	document.addEventListener(
		"wheel",
		(event) => {
			if (!isMessageInteraction(event.target)) return;
			state.middleScrolling = false;
			if (event.deltaY < 0) markUnpinned();
		},
		{ capture: true, passive: true },
	);
	document.addEventListener(
		"touchmove",
		(event) => {
			if (isMessageInteraction(event.target)) markUnpinned();
		},
		{ capture: true, passive: true },
	);
	document.addEventListener(
		"keydown",
		(event) => {
			if (isUpwardScrollKey(event) && isMessageInteraction(event.target))
				markUnpinned();
		},
		true,
	);

	// A live-appended message's `data-enter` is a one-shot marker: once its entry has
	// played, drop it, so user articles (never re-morphed) don't keep it and later morphs
	// match the server markup (flow-critique #4).
	const settleEntry = (event) => {
		if (
			event.propertyName === "opacity" &&
			event.target instanceof Element &&
			event.target.matches(
				"#message-list > .message[data-enter], #message-list + .message-pending[data-enter]",
			)
		)
			event.target.removeAttribute("data-enter");
	};
	document.addEventListener("transitionend", settleEntry, true);
	document.addEventListener("transitioncancel", settleEntry, true);

	bindDetailsMotion();
	bindMessageResize();
	scrollBottom();
}

export function captureAnchor() {
	if (historyLoading) return false;
	const messages = document.getElementById("messages");
	if (!(messages instanceof HTMLElement)) return false;
	const viewport = messages.getBoundingClientRect();
	const visibleMessage = messageAtViewportTop(messages, viewport);
	anchor = {
		lastScrollTop: messages.scrollTop,
		message: visibleMessage,
		offset: visibleMessage
			? visibleMessage.getBoundingClientRect().top - viewport.top
			: undefined,
		pinnedToBottom: state.pinnedToBottom,
		scrollHeight: messages.scrollHeight,
		scrollTop: messages.scrollTop,
		userScrollDelta: 0,
	};
	// Held until restoreAnchor() (the batch has landed), with a safety release.
	quietTranscript({ hold: true });
	historyLoading = true;
	messages.style.overflowAnchor = "none";
	updateScrollControl();
	return true;
}

export function restoreAnchor() {
	restoreAnchorPosition();
	// The older batch is in: stay quiet for its insertion frame plus two.
	quietTranscript();
}

function restoreAnchorPosition() {
	const saved = anchor;
	anchor = undefined;
	historyLoading = false;
	const messages = document.getElementById("messages");
	if (!(messages instanceof HTMLElement)) return;
	if (!saved) {
		messages.style.removeProperty("overflow-anchor");
		return;
	}
	if (saved.pinnedToBottom && state.pinnedToBottom) {
		messages.style.removeProperty("overflow-anchor");
		scrollBottom();
		return;
	}
	const retainedMessage = saved.message;
	if (
		retainedMessage instanceof HTMLElement &&
		messages.contains(retainedMessage) &&
		saved.offset !== undefined
	) {
		const targetOffset = saved.offset - saved.userScrollDelta;
		const applyAnchor = () => {
			if (!messages.contains(retainedMessage)) return;
			const currentOffset =
				retainedMessage.getBoundingClientRect().top -
				messages.getBoundingClientRect().top;
			messages.scrollTop = retainedAnchorScrollTop(
				messages.scrollTop,
				currentOffset,
				targetOffset,
			);
			messages.style.removeProperty("overflow-anchor");
			state.scrollTop = messages.scrollTop;
			updateScrollControl();
		};
		applyAnchor();
		// Datastar applies `data-show` after inserting the batch, which shrinks the
		// rows above the anchor. Re-measure once the DOM has settled.
		requestAnimationFrame(applyAnchor);
		return;
	}
	messages.scrollTop =
		saved.scrollTop +
		saved.userScrollDelta +
		messages.scrollHeight -
		saved.scrollHeight;
	messages.style.removeProperty("overflow-anchor");
	state.scrollTop = messages.scrollTop;
	updateScrollControl();
}

export function trimOldMessages() {
	if (!state.pinnedToBottom) return;
	const messages = document.getElementById("messages");
	const trigger = document.getElementById("messages-trim");
	if (!(messages instanceof HTMLElement) || !(trigger instanceof HTMLButtonElement))
		return;
	const messageElements = document.querySelectorAll(
		"#message-list > [data-message-id]",
	);
	const excess = messageElements.length - 100;
	const lastCandidate = messageElements[excess - 1];
	if (
		!lastCandidate ||
		!shouldTrimOldMessages(
			excess,
			lastCandidate.getBoundingClientRect().bottom,
			messages.getBoundingClientRect().top,
		)
	)
		return;
	trigger.click();
}

export function retainedAnchorScrollTop(scrollTop, currentOffset, targetOffset) {
	return scrollTop + currentOffset - targetOffset;
}

export function shouldTrimOldMessages(excess, candidateBottom, viewportTop) {
	return excess > 0 && candidateBottom <= viewportTop;
}

function messageAtViewportTop(messages, viewport) {
	for (const yOffset of [8, 32, 64, 128]) {
		for (const xRatio of [0.25, 0.5, 0.75]) {
			const message = document
				.elementFromPoint(
					viewport.left + viewport.width * xRatio,
					viewport.top + yOffset,
				)
				?.closest("[data-message-id]");
			if (message instanceof HTMLElement && messages.contains(message))
				return message;
		}
	}
	return messages
		.querySelectorAll("[data-message-id]")
		.values()
		.find((message) => message.getBoundingClientRect().bottom > viewport.top);
}

export function hasPointerDragIntent(startX, startY, currentX, currentY) {
	return Math.hypot(currentX - startX, currentY - startY) >= 8;
}

export function shouldRearmAfterScroll(wasPinned, previousTop, scrollTop, distance) {
	return !wasPinned && scrollTop > previousTop && distance <= liveEdgeThresholdPx;
}

export function scrollBottom(behavior = "auto") {
	// A CSS `scroll-behavior` can't override an explicit smooth scroll, so honour
	// reduced motion here.
	if (behavior === "smooth" && reducedMotion()) {
		behavior = "instant";
	}
	clearBottomScrollTimers();
	// An in-flight follow would pull the snap back up toward its stale target next frame.
	cancelFollow();
	cancelJump();
	anchor = undefined;
	historyLoading = false;
	state.middleScrolling = false;
	state.pinnedToBottom = true;
	state.pointerScrolling = false;
	const scroll = () => {
		const messages = document.getElementById("messages");
		if (!(messages instanceof HTMLElement) || !state.pinnedToBottom) return;
		messages.style.removeProperty("overflow-anchor");
		messages.scrollTo({ top: messages.scrollHeight, behavior });
		updateScrollControl();
	};
	// Late layout (images, enhancement) after the first snap glides instead of stepping.
	const followOrSnap = () => {
		const messages = document.getElementById("messages");
		if (!(messages instanceof HTMLElement) || !state.pinnedToBottom) return;
		messages.style.removeProperty("overflow-anchor");
		followBottom(messages);
		updateScrollControl();
	};
	if (behavior === "smooth") {
		const messages = document.getElementById("messages");
		if (messages instanceof HTMLElement) {
			messages.style.removeProperty("overflow-anchor");
			startJump(messages);
		}
		updateScrollControl();
		return;
	}
	scroll();
	if (behavior === "auto") {
		for (const delay of [16, 80, 180]) {
			const timer = setTimeout(() => {
				bottomScrollTimers.delete(timer);
				followOrSnap();
			}, delay);
			bottomScrollTimers.add(timer);
		}
	}
}

export function markUnpinned() {
	clearBottomScrollTimers();
	cancelFollow();
	cancelJump();
	state.pinnedToBottom = false;
	const messages = document.getElementById("messages");
	if (messages instanceof HTMLElement) state.scrollTop = messages.scrollTop;
	updateScrollControl();
}

function clearBottomScrollTimers() {
	for (const timer of bottomScrollTimers) clearTimeout(timer);
	bottomScrollTimers.clear();
}

/**
 * Pinned follow: glides `#messages` to its bottom over `duration.lg` on `easeOut`, so a
 * new article's fade-and-rise and the transcript glide read as one upward gesture. A new
 * target mid-flight retargets from the current position. Snaps when there is nothing to
 * glide, while history loads, under reduced motion, or when the step is a screen or more.
 */
export function followBottom(messages) {
	// An explicit jump owns scrollTop and already tracks the live bottom.
	if (jump) return;
	const target = messages.scrollHeight - messages.clientHeight;
	const delta = target - messages.scrollTop;
	if (
		delta <= 0.5 ||
		historyLoading ||
		reducedMotion() ||
		delta >= messages.clientHeight
	) {
		cancelFollow();
		messages.scrollTop = messages.scrollHeight;
		return;
	}
	if (follow && Math.abs(follow.to - target) < 0.5) return;
	cancelFollow();
	const run = {
		from: messages.scrollTop,
		to: target,
		start: performance.now(),
		raf: 0,
	};
	const step = (now) => {
		if (follow !== run || !state.pinnedToBottom) return;
		const t = Math.min(1, Math.max(0, (now - run.start) / duration.lg));
		messages.scrollTop = run.from + (run.to - run.from) * easeOut(t);
		if (t < 1) run.raf = requestAnimationFrame(step);
		else follow = undefined;
	};
	follow = run;
	run.raf = requestAnimationFrame(step);
}

function cancelFollow() {
	if (follow) cancelAnimationFrame(follow.raf);
	follow = undefined;
}

/**
 * Explicit jump to latest (the ↓ button): from far away, first land one screen above the
 * bottom, then tween over `duration.xl`, re-reading the live bottom every frame so
 * streaming growth never cuts or overshoots it (flow-critique #8, addendum C-X2).
 */
function startJump(messages) {
	cancelFollow();
	cancelJump();
	const target = messages.scrollHeight - messages.clientHeight;
	const distance = target - messages.scrollTop;
	if (distance <= 0.5) return;
	if (distance > 2 * messages.clientHeight)
		messages.scrollTop = target - messages.clientHeight;
	const run = { from: messages.scrollTop, start: performance.now(), raf: 0 };
	const step = (now) => {
		if (jump !== run || !state.pinnedToBottom) return;
		const t = Math.min(1, Math.max(0, (now - run.start) / duration.xl));
		const live = messages.scrollHeight - messages.clientHeight;
		messages.scrollTop = run.from + (live - run.from) * easeOut(t);
		if (t < 1) run.raf = requestAnimationFrame(step);
		else jump = undefined;
	};
	jump = run;
	run.raf = requestAnimationFrame(step);
}

function cancelJump() {
	if (jump) cancelAnimationFrame(jump.raf);
	jump = undefined;
}

/**
 * Marks the transcript quiet so nested entry animations (stopped note, tool output,
 * block reveal, recent-session rows) don't replay while a whole transcript or an older
 * batch is inserted. Default: the insertion frame plus two. `hold`: until the next
 * unheld call (restoreAnchor), with a safety release.
 */
export function quietTranscript({ hold = false } = {}) {
	const root = document.documentElement;
	quietGeneration += 1;
	const generation = quietGeneration;
	root.setAttribute("data-transcript-quiet", "");
	clearTimeout(quietSafetyTimer);
	const release = () => {
		if (generation === quietGeneration) root.removeAttribute("data-transcript-quiet");
	};
	if (hold) {
		quietSafetyTimer = setTimeout(release, quietSafetyMs);
		return;
	}
	setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(release)), 0);
}

/**
 * Arms the send-time spacer hold. Called by the real submit paths (prompt-box.tsx Enter,
 * prompt-action.tsx Send) right before the composer clears; never by `/copy`.
 */
export function holdSpacerForSend() {
	const spacer = document.getElementById("messages-prompt-spacer");
	if (!(spacer instanceof HTMLElement) || !state.pinnedToBottom) return;
	held = {
		px: spacer.offsetHeight,
		baseTop: spacer.offsetTop,
		until: performance.now() + spacerHoldMs,
	};
	clearTimeout(heldTimer);
	heldTimer = setTimeout(updatePromptSpacer, spacerHoldMs + 50);
}

/**
 * Pure (unit-tested): the spacer height for the composer's `needed` clearance while a
 * send hold may be active. `contentTop` is the spacer's offsetTop (everything above it),
 * so transcript growth since the hold is given back from the held height. The hold ends
 * once the transcript has grown into it, when it expires, or when unpinned.
 */
export function nextSpacerHeight(needed, hold, contentTop, now, pinned, waiting = false) {
	if (!hold) return { height: needed, hold: undefined };
	const growth = Math.max(0, contentTop - hold.baseTop);
	const floor = hold.px - growth;
	if (floor <= needed || !pinned) return { height: needed, hold: undefined };
	// While the "thinking..." row still waits for the response, the hold outlives its
	// timer: the response is what grows into it. Only a true expiry releases (glides).
	if (now > hold.until && !waiting)
		return { height: needed, hold: undefined, release: floor };
	return { height: floor, hold };
}

/**
 * Retires the pending "thinking..." row (messages.tsx renderPendingResponse) in place.
 * `replaced`: a response article was just appended to #message-list, right above the
 * row, into the slot the row occupied (same `.message + .message` offset) and pushing it
 * down. The row is lifted out of flow back onto that slot, so the article holds its place
 * with no layout jump, and fades out from its current opacity while the article fades in
 * (flow-decisions §10.1). In minimal mode a thought's first row IS the pending row, so
 * that swap is made pixel-identical instead. Without `replaced` (the turn ended with no
 * response: abort, settle) the row fades where it is, still in flow, and its space is then
 * handed to the prompt spacer and glided closed, so the pinned transcript never steps.
 */
export function retirePending(replaced = false) {
	const row = document.getElementById("message-pending");
	if (!(row instanceof HTMLElement)) return;
	row.removeAttribute("id");
	const incoming = replaced
		? document.getElementById("message-list")?.lastElementChild
		: undefined;
	if (
		document.body?.hasAttribute("data-minimal-mode") &&
		incoming?.matches(".message-thought[data-enter]")
	) {
		incoming.removeAttribute("data-enter");
		row.remove();
		return;
	}
	const rect = row.getBoundingClientRect();
	if (
		!(row.parentElement instanceof HTMLElement) ||
		rect.height === 0 ||
		!motionReady()
	) {
		row.remove();
		return;
	}
	const from = Number.parseFloat(getComputedStyle(row).opacity);
	if (incoming instanceof HTMLElement) {
		// Layout offsets, not rects: the article's @starting-style translate is already
		// in its rect. The offsetParent is the position: relative `.messages-stack`, which
		// is also the absolute row's containing block.
		Object.assign(row.style, {
			position: "absolute",
			top: `${incoming.offsetParent ? incoming.offsetTop : row.offsetTop}px`,
			left: `${row.offsetLeft}px`,
			width: `${rect.width}px`,
			margin: "0",
			pointerEvents: "none",
		});
	}
	const fade = row.animate(
		[{ opacity: Number.isFinite(from) ? from : 1 }, { opacity: 0 }],
		{ duration: duration.sm, easing: easing.out, fill: "forwards" },
	);
	const remove = () => (incoming ? row.remove() : removeIntoSpacer(row));
	fade.finished.then(remove, remove);
}

/** Removes an in-flow node at the transcript's foot without a step: its height and
 * margin move to the prompt spacer, which then glides back to its needed height. */
function removeIntoSpacer(node) {
	const spacer = document.getElementById("messages-prompt-spacer");
	if (!node.isConnected || !(spacer instanceof HTMLElement)) {
		node.remove();
		return;
	}
	const gap =
		node.offsetHeight + (Number.parseFloat(getComputedStyle(node).marginTop) || 0);
	const from = spacer.offsetHeight + gap;
	node.remove();
	releaseSpacer(spacer, from);
}

/**
 * Glides the prompt spacer from `from` down to its needed height (updatePromptSpacer).
 * Shrinking it at the transcript's foot while pinned lowers the scroll bottom, so the
 * transcript eases down instead of stepping (followBottom cannot glide a clamp). Snaps
 * under reduced motion, before motion is ready, or when the reader is not pinned.
 */
function releaseSpacer(spacer, from) {
	held = undefined;
	cancelSpacerRelease();
	if (state.pinnedToBottom && motionReady() && !reducedMotion()) {
		spacer.style.height = `${from}px`;
		const run = { from, start: performance.now(), raf: 0 };
		const step = () => {
			if (spacerRelease !== run) return;
			updatePromptSpacer();
			if (spacerRelease === run) run.raf = requestAnimationFrame(step);
		};
		spacerRelease = run;
		run.raf = requestAnimationFrame(step);
	}
	updatePromptSpacer();
}

function cancelSpacerRelease() {
	if (spacerRelease) cancelAnimationFrame(spacerRelease.raf);
	spacerRelease = undefined;
}

/**
 * Pure (unit-tested): the spacer height a release glide asks for at `now`, easing from
 * `release.from` to the live `needed` over `duration.lg`; `undefined` once it is done
 * (or the reader scrolled away), when the spacer simply takes `needed`.
 */
export function releasedSpacerHeight(release, needed, now, pinned) {
	if (!release || !pinned || release.from <= needed) return undefined;
	const t = Math.max(0, (now - release.start) / duration.lg);
	if (t >= 1) return undefined;
	return release.from + (needed - release.from) * easeOut(t);
}

/**
 * Pure (unit-tested): the new markdown blocks a batch of mutation records should fade
 * in (flow-critique #6). Only pure appends under a streaming narrative's
 * `.markdown-content`: when the same batch also removed an element there (a paragraph
 * turning into a table), the replacement snaps in place with no blank frame. Existing
 * blocks and tokens inside a block never animate.
 */
export function blockRevealTargets(records) {
	const byTarget = new Map();
	for (const record of records) {
		const target = record.target;
		if (
			!(target instanceof Element) ||
			!target.classList.contains("markdown-content")
		)
			continue;
		const entry = byTarget.get(target) ?? { added: [], removed: false };
		for (const node of record.addedNodes)
			if (node instanceof Element) entry.added.push(node);
		for (const node of record.removedNodes)
			if (node instanceof Element) entry.removed = true;
		byTarget.set(target, entry);
	}
	const targets = [];
	for (const [target, entry] of byTarget) {
		if (entry.removed || entry.added.length === 0) continue;
		if (!target.closest(".message-narrative:not([data-ignore-morph], [data-enter])"))
			continue;
		targets.push(...entry.added);
	}
	return targets;
}

/** Scoped to `#message-list` (never Datastar's helper node after <body>, M9d). */
function observeBlockReveal(list) {
	if (list === observedMessageList) return;
	blockObserver ??= new MutationObserver((records) => {
		if (
			!motionReady() ||
			document.documentElement.hasAttribute("data-transcript-quiet")
		)
			return;
		for (const block of blockRevealTargets(records)) {
			if (block.isConnected)
				block.animate([{ opacity: 0 }, { opacity: 1 }], {
					duration: duration.sm,
					easing: easing.out,
				});
		}
	});
	blockObserver.disconnect();
	observedMessageList = list;
	blockObserver.observe(list, { childList: true, subtree: true });
}

function isMessageInteraction(target) {
	const messages = document.getElementById("messages");
	return (
		messages instanceof HTMLElement &&
		target instanceof Node &&
		messages.contains(target)
	);
}

function isUpwardScrollKey(event) {
	return (
		event.key === "ArrowUp" ||
		event.key === "PageUp" ||
		event.key === "Home" ||
		(event.key === " " && event.shiftKey)
	);
}

export function bindMessageResize() {
	// Runs via `data-init` whenever a new #messages is inserted (load, session switch,
	// code theme): its nested entries must not replay.
	quietTranscript();
	const list = document.getElementById("message-list");
	if (list instanceof HTMLElement) observeBlockReveal(list);
	const stack = document.querySelector("#messages > .messages-stack");
	const prompt = document.getElementById("prompt-box");
	if (!(stack instanceof HTMLElement) || !(prompt instanceof HTMLElement)) return;
	if (stack === observedMessageStack && prompt === observedPrompt) return;
	if (stack !== observedMessageStack) {
		// A new transcript has its own spacer: a hold measured on the old one is void.
		held = undefined;
		cancelSpacerRelease();
	}
	messageResizeObserver ??= new ResizeObserver(() => {
		updatePromptSpacer();
		const messages = document.getElementById("messages");
		if (messages instanceof HTMLElement && state.pinnedToBottom)
			followBottom(messages);
		updateScrollControl();
	});
	if (observedMessageStack) messageResizeObserver.unobserve(observedMessageStack);
	if (observedPrompt) messageResizeObserver.unobserve(observedPrompt);
	observedMessageStack = stack;
	observedPrompt = prompt;
	messageResizeObserver.observe(stack);
	messageResizeObserver.observe(prompt);
}

function updatePromptSpacer() {
	const prompt = document.getElementById("prompt-box");
	const spacer = document.getElementById("messages-prompt-spacer");
	if (!(prompt instanceof HTMLElement) || !(spacer instanceof HTMLElement)) return;
	const needed = prompt.offsetHeight + promptSpacerClearancePx;
	const next = nextSpacerHeight(
		needed,
		held,
		spacer.offsetTop,
		performance.now(),
		state.pinnedToBottom,
		document.getElementById("message-pending") !== null,
	);
	held = next.hold;
	// An expired hold glides closed rather than stepping (flow-critique #7 "on expiry").
	if (next.release !== undefined) {
		releaseSpacer(spacer, next.release);
		return;
	}
	const glide = releasedSpacerHeight(
		spacerRelease,
		needed,
		performance.now(),
		state.pinnedToBottom,
	);
	if (glide === undefined) cancelSpacerRelease();
	const height = `${Math.max(next.height, glide ?? 0)}px`;
	if (spacer.style.height !== height) spacer.style.height = height;
}

function updateScrollControl() {
	const messages = document.getElementById("messages");
	const button = document.getElementById("messages-latest");
	if (!(messages instanceof HTMLElement) || !(button instanceof HTMLButtonElement))
		return;
	const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
	const active = !state.pinnedToBottom && distance >= scrollControlThresholdPx;
	button.hidden = !active;
	button.inert = !active;
	button.tabIndex = active ? 0 : -1;
}

export function hydratePierreDiff(host) {
	if (!(host instanceof HTMLElement)) return;
	const template = host.querySelector('template[shadowrootmode="open"]');
	if (!(template instanceof HTMLTemplateElement)) return;
	// Pierre may create the shadow root before Datastar inserts its template.
	const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
	shadow.append(template.content.cloneNode(true));
	template.remove();
}

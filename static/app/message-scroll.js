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
// rAF tweens of `#messages.scrollTop`, never a native smooth scroll while pinned. A clock
// starts at its first frame (`start ??= now`), so a long frame between scheduling and
// that frame never collapses the glide into a snap (SF2-07).
// - `ease`: the first move after a newly appended message (or any large one), 200ms
//   `--ease-out`, so the article's fade-and-rise and the glide read as one gesture.
// - `chase`: streaming growth and every retarget, a critically damped spring on the live
//   bottom whose per-frame step is capped, so it never restarts a front-loaded curve
//   (SF2-04). A retarget of an `ease` hands over its position and velocity.
let follow; // { mode: "ease", messages, from, to, start, last, t, raf } | { mode: "chase", messages, pos, v, to, cap, last, raf }
let jump; // { from, start, raf }
/** Below this, a new non-append follow chases rather than eases (streaming growth). */
const chaseMaxPx = 96;
/** Chase stiffness k (s⁻²); critically damped, so ω = √k. */
const chaseStiffness = 400;
/** A chase never steps less than this per frame when the target is further away. */
const chaseMinStepPx = 8;
/** Frame time cap for the chase integrator: a long frame advances one nominal frame. */
const chaseFrameS = 1 / 60;
/** The eased tweens' clocks advance at most this much per frame (SS3-05). */
const tweenFrameCapMs = 1000 / 30;
/** Set by the #message-list observer when a live `.message[data-enter]` lands; read by the
 * next resize pass's follow and cleared after it (it only shapes that frame's move). */
let appendPending = false;
/** Accordion holds (holdFollow): while any is active the bottom edge is pinned per frame. */
const followHolds = new Set();
/** Last observed `.messages-stack` content width, to tell a reflow from appended content. */
let lastStackWidth;
/** A new transcript's first resize pass pins its bottom instead of following (PN3-1). */
let freshStack = false;

// The composer's send-time collapse (prompt.js clearPromptForSend → setComposerSettle):
// while it animates, the spacer is sized for the settled composer, so the release of the
// send hold happens once, in the same resize pass as the growth (SF2-02).
let composerSettle; // { height, until }

// Session switch (SP-5): the transcript's live opacity is mirrored into
// `--messages-enter-from` on #chat-pane (watchSessionLoading), which the incoming
// #messages' `@starting-style` reads (messages.css), so the new one continues from it.
let loadingObserver;
let enterFromRaf = 0;
/** A fast switch (the outgoing transcript never dimmed) still enters: a short fade from
 * this opacity instead of a hard cut, and never the slow switch's dip to 0.5 (SS3-06). */
const enterFromCap = 0.6;

// Send-time spacer hold (flow-critique #7): the composer's collapse is not given back to
// the spacer until the transcript has grown into it, so the pinned transcript never steps
// down. It expires (gliding closed) once `spacerHoldMs` has passed and the transcript has
// been quiet that long (failed send, queued steer, a reply shorter than the collapse).
const spacerHoldMs = 1500;
let held; // { px, baseTop, until }
let heldTimer;
let contentTop;
let contentChangedAt = Number.NEGATIVE_INFINITY;
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
	// A replaced #messages (session switch) drops its marker the same way, which reopens
	// messages.css's `#messages:not([data-enter])` gate for nested entries (SF2-09c).
	const settleEntry = (event) => {
		if (
			event.propertyName === "opacity" &&
			event.target instanceof Element &&
			event.target.matches(
				"#message-list > .message[data-enter], #message-list + .message-pending[data-enter], #messages[data-enter]",
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
	const requested = behavior;
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
		// A reduced-motion jump to latest teleports: mask a long one like startJump does.
		if (requested === "smooth") maskLongJump(messages);
		messages.scrollTo({ top: messages.scrollHeight, behavior });
		updateScrollControl();
	};
	// Late layout (images, enhancement) after the first snap glides instead of stepping.
	// Like the resize pass: the spacer is resolved first (a send hold must not be snapped
	// to), and a live append still waiting for that pass keeps its land-and-glide (SS3-03).
	const followOrSnap = () => {
		const messages = document.getElementById("messages");
		if (!(messages instanceof HTMLElement) || !state.pinnedToBottom) return;
		messages.style.removeProperty("overflow-anchor");
		updatePromptSpacer();
		followBottom(messages, appendPending);
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
 * Pinned follow: glides `#messages` to its bottom (see `follow` above for the two modes).
 * A new target mid-flight retargets the running follow without restarting it. Snaps when
 * there is nothing to glide, while history loads, under reduced motion, or when the step
 * is a screen or more; a newly appended message taller than a screen first lands one
 * screen above its bottom and glides that last screen (SF2-10), as startJump does.
 */
export function followBottom(messages, appended = false) {
	// An explicit jump owns scrollTop and already tracks the live bottom.
	if (jump) return;
	const target = messages.scrollHeight - messages.clientHeight;
	const delta = target - messages.scrollTop;
	// An accordion in flight (holdFollow) keeps the bottom edge fixed every frame instead.
	if (delta <= 0.5 || historyLoading || reducedMotion() || followHolds.size > 0) {
		cancelFollow();
		messages.scrollTop = messages.scrollHeight;
		return;
	}
	if (follow?.messages === messages) {
		retargetFollow(messages, target);
		return;
	}
	cancelFollow();
	if (delta >= messages.clientHeight) {
		if (!appended) {
			messages.scrollTop = messages.scrollHeight;
			return;
		}
		messages.scrollTop = target - messages.clientHeight;
	}
	if (appended || delta >= chaseMaxPx) startEase(messages, target);
	else startChase(messages, messages.scrollTop, 0, target);
}

/**
 * Pure (unit-tested): a tween's start time for the frame at `now`, given its previous
 * frame at `last`. Starts at the first frame (`start` undefined), then is pushed forward
 * by whatever a frame took beyond `tweenFrameCapMs`, so no single frame (a long task, a
 * throttled or stale rAF timestamp) advances a tween by more than a nominal frame's worth:
 * it glides on, never teleports (SS3-05).
 */
export function frameClampedStart(start, last, now) {
	if (start === undefined || last === undefined) return start ?? now;
	return start + Math.max(0, now - last - tweenFrameCapMs);
}

/** The `ease` follow: `duration.lg` on `easeOut` from where it is to `to`. */
function startEase(messages, to) {
	const run = {
		mode: "ease",
		messages,
		from: messages.scrollTop,
		to,
		start: undefined,
		last: undefined,
		t: 0,
		raf: 0,
	};
	const step = (now) => {
		if (follow !== run || !state.pinnedToBottom) return;
		run.start = frameClampedStart(run.start, run.last, now);
		run.last = now;
		run.t = Math.min(1, Math.max(0, (now - run.start) / duration.lg));
		messages.scrollTop = run.from + (run.to - run.from) * easeOut(run.t);
		if (run.t < 1) run.raf = requestAnimationFrame(step);
		else follow = undefined;
	};
	follow = run;
	run.raf = requestAnimationFrame(step);
}

/**
 * The `chase` follow from `pos` at velocity `v` (px/s) toward the live bottom. `last` is
 * the previous frame's time when it takes over a running follow, so it moves on its first
 * frame instead of stalling for one.
 */
function startChase(messages, pos, v, to, cap = 0, last = undefined) {
	const run = {
		mode: "chase",
		messages,
		pos,
		v,
		to,
		cap: Math.max(chaseMinStepPx, (to - pos) / 12, cap),
		last,
		raf: 0,
	};
	const step = (now) => {
		if (follow !== run || !state.pinnedToBottom) return;
		run.to = messages.scrollHeight - messages.clientHeight;
		const dt =
			run.last === undefined ? 0 : Math.min(chaseFrameS, (now - run.last) / 1000);
		run.last = now;
		const next = chaseStep(run.pos, run.v, run.to, dt, run.cap);
		run.pos = next.pos;
		run.v = next.v;
		messages.scrollTop = run.pos;
		if (next.done) follow = undefined;
		else run.raf = requestAnimationFrame(step);
	};
	follow = run;
	run.raf = requestAnimationFrame(step);
}

/**
 * Pure (unit-tested): one frame of the chase. The exact critically damped solution
 * (`x'' = -k·x - 2√k·x'`, stable for any `dt`) toward `to`, with the step capped at `cap`
 * px and never past `to` (the scroll bottom clamps there anyway).
 */
export function chaseStep(pos, v, to, dt, cap) {
	const omega = Math.sqrt(chaseStiffness);
	const x0 = pos - to;
	const decay = Math.exp(-omega * dt);
	const b = v + omega * x0;
	let step = (x0 + b * dt) * decay - x0;
	let velocity = (v - omega * b * dt) * decay;
	if (Math.abs(step) > cap) {
		step = Math.sign(step) * cap;
		velocity = step / dt;
	}
	const next = pos + step;
	// Arrived (or would pass the target): land on it exactly.
	if (
		(to - pos) * (to - next) <= 0 ||
		(Math.abs(to - next) < 0.5 && Math.abs(velocity) < 30)
	)
		return { pos: to, v: 0, done: true };
	return { pos: next, v: velocity, done: false };
}

/**
 * A new bottom while a follow runs: a chase simply chases it (and may step faster for a
 * bigger gap); an ease keeps its clock, and a higher bottom takes over its current
 * position and velocity in a chase, so the glide continues without a restart or a
 * discontinuity (SF2-04).
 */
function retargetFollow(messages, target) {
	const run = follow;
	if (run.mode === "chase") {
		run.to = target;
		run.cap = Math.max(run.cap, (target - run.pos) / 12);
		return;
	}
	// A lower bottom (a spacer gliding closed) needs nothing: the scroll clamp follows it
	// and the ease still ends there. Only a higher one hands over.
	if (target < run.to + 0.5) return;
	const pos = run.from + (run.to - run.from) * easeOut(run.t);
	const velocity = run.start === undefined ? 0 : easeVelocity(run.from, run.to, run.t);
	cancelFollow();
	startChase(
		messages,
		pos,
		velocity,
		target,
		Math.abs(velocity) * chaseFrameS,
		run.last,
	);
}

/** Pure: the `ease` follow's velocity (px/s) at progress `t`. */
export function easeVelocity(from, to, t) {
	const h = 0.01;
	const a = Math.max(0, t - h);
	const b = Math.min(1, t + h);
	if (b <= a) return 0;
	return (((to - from) * (easeOut(b) - easeOut(a))) / (b - a) / duration.lg) * 1000;
}

function cancelFollow() {
	if (follow) cancelAnimationFrame(follow.raf);
	follow = undefined;
}

/**
 * Explicit jump to latest (the ↓ button): from far away, first land one screen above the
 * bottom, under an 80ms opacity dip that masks the teleport (SF2-10), then tween over
 * `duration.xl`, re-reading the live bottom every frame so streaming growth never cuts or
 * overshoots it (flow-critique #8, addendum C-X2).
 */
function startJump(messages) {
	cancelFollow();
	cancelJump();
	const target = messages.scrollHeight - messages.clientHeight;
	const distance = target - messages.scrollTop;
	if (distance <= 0.5) return;
	if (maskLongJump(messages)) messages.scrollTop = target - messages.clientHeight;
	const run = { from: messages.scrollTop, start: undefined, last: undefined, raf: 0 };
	const step = (now) => {
		if (jump !== run || !state.pinnedToBottom) return;
		run.start = frameClampedStart(run.start, run.last, now);
		run.last = now;
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
 * A jump to latest from more than two screens away teleports part of the way; an 80ms
 * opacity dip on the stack (0.6 → 1, opacity only so reduced-motion safe) masks the cut.
 * Returns whether the jump is that long.
 */
function maskLongJump(messages) {
	const distance = messages.scrollHeight - messages.clientHeight - messages.scrollTop;
	if (distance <= 2 * messages.clientHeight) return false;
	messages
		.querySelector?.(":scope > .messages-stack")
		?.animate([{ opacity: 0.6 }, { opacity: 1 }], {
			duration: duration.xs,
			easing: easing.out,
		});
	return true;
}

/**
 * Accordion hold (details-motion.js, S5): while `anim` runs, the pinned transcript's
 * bottom edge stays put every frame, so an expanding details grows upward and the reply
 * below it never dips; the resize-driven follow stands down until `anim.finished` settles.
 */
export function holdFollow(anim) {
	const messages = document.getElementById("messages");
	if (!(messages instanceof HTMLElement) || !state.pinnedToBottom || !anim?.finished)
		return;
	cancelFollow();
	const hold = { raf: 0 };
	followHolds.add(hold);
	const pin = () => {
		if (!followHolds.has(hold)) return;
		// Read in rAF, scrollHeight already reflects this frame's animation sample.
		if (state.pinnedToBottom)
			messages.scrollTop = messages.scrollHeight - messages.clientHeight;
		hold.raf = requestAnimationFrame(pin);
	};
	hold.raf = requestAnimationFrame(pin);
	// Released two frames after `anim` settles, so the resize pass that lays out its last
	// DOM change (a closing details dropping `open`) still runs under the hold.
	const release = () => {
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				followHolds.delete(hold);
				cancelAnimationFrame(hold.raf);
			}),
		);
	};
	anim.finished.then(release, release);
}

/**
 * The composer's send-time collapse (prompt.js): `height` is the #prompt-box's settled
 * offsetHeight and `until` the `performance.now()` time its collapse ends. Until then the
 * spacer is sized for the settled composer, not each frame of the collapse (SF2-02).
 */
export function setComposerSettle(height, until) {
	composerSettle = { height, until };
}

/** Pure (unit-tested): the spacer clearance the composer needs at `now`. */
export function promptClearance(promptHeight, settle, now) {
	const height = settle && now < settle.until ? settle.height : promptHeight;
	return height + promptSpacerClearancePx;
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
	holdSpacer(spacer, spacer.offsetHeight);
}

/** Holds the spacer at `px` above everything now above it (see nextSpacerHeight). */
function holdSpacer(spacer, px) {
	cancelSpacerRelease();
	held = { px, baseTop: spacer.offsetTop, until: performance.now() + spacerHoldMs };
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
 * (flow-decisions §10.1); the space it leaves is held by the prompt spacer until the
 * response grows into it. The #message-list observer calls this synchronously when the
 * article lands, before it is ever painted; the server's call is then a no-op. In minimal mode a thought's first row IS the pending row, so
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
		// The row's in-flow share (height + margin) is measured before it leaves the flow
		// and held in the spacer, which gives it back only as the response grows into it
		// (the send hold's mechanism), so the pinned transcript never steps or glides
		// down when the row is lifted out (SF2-06). A row rendered without `data-enter`
		// (reconnect, replace) retires the same way.
		const gap =
			row.offsetHeight + (Number.parseFloat(getComputedStyle(row).marginTop) || 0);
		const spacer = document.getElementById("messages-prompt-spacer");
		const spacerPx = spacer instanceof HTMLElement ? spacer.offsetHeight : 0;
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
		if (spacer instanceof HTMLElement && state.pinnedToBottom) {
			holdSpacer(spacer, spacerPx + gap);
			updatePromptSpacer();
		}
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
		// The clock starts at the first frame (SF2-07): a long frame never collapses it.
		const run = { from, start: undefined, last: undefined, raf: 0 };
		const step = () => {
			if (spacerRelease !== run) return;
			const now = performance.now();
			run.start = frameClampedStart(run.start, run.last, now);
			run.last = now;
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
	// Not started (its first frame is still to come): hold the release's start height.
	if (release.start === undefined) return release.from;
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

/**
 * Pure (unit-tested): what a batch of mutation records means for the transcript's foot.
 * `appended`: a live message landed, a direct `.message[data-enter]` child of `list`
 * (rows re-rendered without the marker, on reconnect or replace, never count).
 * `replacesRow`: the last such event put an article in the pending row's slot (the list's
 * tail) while the row was already showing, the server's `retirePending(true)` case. A row
 * shown after the article (an extension card that landed before the wait began) stays.
 */
export function transcriptFootChanges(records, list) {
	let appended = false;
	let replacesRow = false;
	for (const record of records)
		for (const node of record.addedNodes) {
			if (!(node instanceof Element)) continue;
			if (record.target === list && node.matches(".message[data-enter]")) {
				appended = true;
				replacesRow = node === list.lastElementChild;
			} else if (node.id === "message-pending") replacesRow = false;
		}
	return { appended, replacesRow };
}

/** Scoped to `#message-list` (never Datastar's helper node after <body>, M9d). */
function observeBlockReveal(list) {
	if (list === observedMessageList) return;
	blockObserver ??= new MutationObserver((records) => {
		// A live article landed. The pending row retires now, before style and layout, so
		// it never paints pushed down below the article; the server's retire script
		// stays as an idempotent fallback (SF2-06). The next follow eases (see `follow`).
		// Only an article in the row's slot (the list's tail) replaces it; one inserted
		// earlier in the list is left to the server's plain fade-in-place retire.
		const foot = transcriptFootChanges(records, observedMessageList);
		if (foot.appended) appendPending = true;
		if (foot.replacesRow && document.getElementById("message-pending"))
			retirePending(true);
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
	// The pending row is the list's next sibling: its arrival orders the retire above.
	if (list.parentElement)
		blockObserver.observe(list.parentElement, { childList: true });
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
	const messages = document.getElementById("messages");
	if (messages instanceof HTMLElement) {
		watchSessionLoading(messages);
		settleUnfadedEntry(messages);
	}
	const stack = document.querySelector("#messages > .messages-stack");
	const prompt = document.getElementById("prompt-box");
	if (!(stack instanceof HTMLElement) || !(prompt instanceof HTMLElement)) return;
	if (stack === observedMessageStack && prompt === observedPrompt) return;
	if (stack !== observedMessageStack) {
		// A new transcript has its own spacer: a hold measured on the old one is void.
		held = undefined;
		cancelSpacerRelease();
		// So are tweens of the old #messages' scrollTop.
		cancelFollow();
		cancelJump();
		lastStackWidth = undefined;
		freshStack = true;
		// A session replace (`data-enter`) opens at its latest message before its first
		// paint (data-init runs before it), never at its top for a frame (PN3-1).
		if (messages instanceof HTMLElement && messages.hasAttribute("data-enter")) {
			state.pinnedToBottom = true;
			messages.scrollTop = messages.scrollHeight - messages.clientHeight;
		}
	}
	messageResizeObserver ??= new ResizeObserver((entries) => {
		let reflowed = false;
		for (const entry of entries) {
			if (entry.target !== observedMessageStack) continue;
			const width = entry.contentRect.width;
			if (lastStackWidth !== undefined && Math.abs(width - lastStackWidth) > 0.5)
				reflowed = true;
			lastStackWidth = width;
		}
		updatePromptSpacer();
		const messages = document.getElementById("messages");
		if (messages instanceof HTMLElement && state.pinnedToBottom) {
			// A narrower or wider stack (Sessions or Live Workspace opening) re-wraps the
			// transcript: that is not new content, so the bottom edge stays put in this
			// same frame instead of gliding back to it (SP-3). Nor is a new transcript's
			// first measurement: it is pinned, not eased or chased into place (PN3-1).
			if ((reflowed || freshStack) && !jump) {
				cancelFollow();
				messages.scrollTop = messages.scrollHeight - messages.clientHeight;
			} else followBottom(messages, appendPending);
		}
		appendPending = false;
		freshStack = false;
		updateScrollControl();
	});
	if (observedMessageStack) messageResizeObserver.unobserve(observedMessageStack);
	if (observedPrompt) messageResizeObserver.unobserve(observedPrompt);
	observedMessageStack = stack;
	observedPrompt = prompt;
	messageResizeObserver.observe(stack);
	messageResizeObserver.observe(prompt);
}

/**
 * Publishes where an incoming #messages' `@starting-style` starts (messages.css, SP-5) on
 * #chat-pane, from the current #messages' opacity: once per frame while it is dimmed by
 * `.messages-loading` or still fading in (`data-enter`), else its resting opacity
 * (enterFrom). Written only when it changes: the properties are inherited by the whole
 * transcript, so an unchanged value never costs a style pass.
 */
function watchSessionLoading(messages) {
	loadingObserver ??= new MutationObserver(trackEnterFrom);
	loadingObserver.disconnect();
	loadingObserver.observe(messages, {
		attributes: true,
		attributeFilter: ["class", "data-enter"],
	});
	trackEnterFrom();
}

function trackEnterFrom() {
	if (enterFromRaf) return;
	const tick = () => {
		enterFromRaf = 0;
		const messages = document.getElementById("messages");
		const pane = document.getElementById("chat-pane");
		if (!(messages instanceof HTMLElement) || !(pane instanceof HTMLElement)) return;
		const entry = enterFrom(Number.parseFloat(getComputedStyle(messages).opacity));
		for (const [name, value] of [
			["--messages-enter-from", entry.from],
			["--messages-enter-duration", entry.duration],
		])
			if (pane.style.getPropertyValue(name) !== value)
				pane.style.setProperty(name, value);
		if (
			messages.classList.contains("messages-loading") ||
			messages.hasAttribute("data-enter")
		)
			enterFromRaf = requestAnimationFrame(tick);
	};
	enterFromRaf = requestAnimationFrame(tick);
}

/**
 * Pure (unit-tested): the incoming transcript's entry for an outgoing one at `opacity`. A
 * slow switch continues from the dim level over `--duration-md`; a fast one (loading never
 * dimmed, or a quick double switch) fades in from `enterFromCap` over `--duration-sm`.
 */
export function enterFrom(opacity) {
	const level = Number.isFinite(opacity) ? Math.round(opacity * 100) / 100 : 1;
	return level < enterFromCap
		? { from: String(level), duration: "var(--duration-md)" }
		: { from: String(enterFromCap), duration: "var(--duration-sm)" };
}

/**
 * A replaced #messages whose `@starting-style` opacity equals its resting one (a fast
 * switch from full opacity) runs no transition, so transitionend never drops its one-shot
 * `data-enter`; two frames after insertion, with no fade running, drop it here (SF2-09c).
 */
function settleUnfadedEntry(messages) {
	if (!messages.hasAttribute("data-enter")) return;
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			if (!messages.isConnected || !messages.hasAttribute("data-enter")) return;
			const fading = messages
				.getAnimations()
				.some(
					(animation) =>
						animation instanceof CSSTransition &&
						animation.transitionProperty === "opacity",
				);
			if (!fading) messages.removeAttribute("data-enter");
		}),
	);
}

/** The spacer's CSS `min-height` in px, read once per spacer node. */
let floorCache; // { spacer, px }
function spacerFloor(spacer) {
	if (floorCache?.spacer !== spacer) {
		const minHeight = globalThis.getComputedStyle?.(spacer).minHeight;
		floorCache = { spacer, px: Number.parseFloat(minHeight ?? "") || 0 };
	}
	return floorCache.px;
}

function updatePromptSpacer() {
	const prompt = document.getElementById("prompt-box");
	const spacer = document.getElementById("messages-prompt-spacer");
	if (!(prompt instanceof HTMLElement) || !(spacer instanceof HTMLElement)) return;
	const now = performance.now();
	if (composerSettle && now >= composerSettle.until) composerSettle = undefined;
	// Never below the spacer's own CSS floor: a hold or a glide aimed under it would be
	// clamped away and read as a drop, not a glide (SS3-04).
	const needed = Math.max(
		spacerFloor(spacer),
		promptClearance(prompt.offsetHeight, composerSettle, now),
	);
	const top = spacer.offsetTop;
	if (top !== contentTop) {
		// An accordion moving while a hold is live (holdFollow) is not the reply growing
		// into the held space: rebase the hold, so the bottom edge, not the reply, stays.
		if (held && followHolds.size > 0 && contentTop !== undefined)
			held.baseTop += top - contentTop;
		contentTop = top;
		contentChangedAt = now;
	}
	// While the transcript is still growing (a reply streaming line by line), only that
	// growth takes the hold back: an expiry glide now would pull the transcript down under
	// the stream and let it climb back on the next line. The hold expires once the
	// transcript has been quiet for as long as the hold itself.
	const growing = now - contentChangedAt < spacerHoldMs;
	const next = nextSpacerHeight(
		needed,
		held,
		top,
		now,
		state.pinnedToBottom,
		document.getElementById("message-pending") !== null || growing,
	);
	held = next.hold;
	if (held && now > held.until) {
		clearTimeout(heldTimer);
		heldTimer = setTimeout(
			updatePromptSpacer,
			contentChangedAt + spacerHoldMs - now + 50,
		);
	}
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
	if (spacer.style.height !== height) {
		// The spacer is a layout owner: its height must land in the same frame as the
		// growth it answers. Reduced motion's blanket 0.01ms `transition-duration` (base.css)
		// applies to the initial `transition-property: all`, which would render the old
		// height for one more frame and step the pinned transcript (SF2-02 under RM).
		spacer.style.transitionProperty = "none";
		spacer.style.height = height;
	}
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

import { duration, easing, reducedMotion } from "./motion.js";

// Accordion: the one sanctioned height animation (animate/RECIPES "Accordion"; flow-spec
// C7 + addendum C-X1). The `<details>` box itself animates between its summary-only and
// its open height, so the content's padding and margin never snap; the content fades.
const summarySelector =
	".context-details > summary.context-summary, .piui-widget-lines-collapsible > summary";
/** Content taller than this share of the viewport fades only (no long height tween). */
const tallRatio = 0.6;
/** details → { animations, wantOpen } for the accordion in flight. */
const running = new WeakMap();

/**
 * The chevron turn each accordion's CSS keys on `[open]` (messages.css
 * `.context-chevron-icon`, pi-ui-elements.css `.piui-widget-lines-collapsible summary::before`;
 * parity pinned by details-motion_test.ts). A close keeps `open` until the body settles,
 * so the CSS turn would trail the body by a whole transition; WAAPI turns the chevron on
 * the body's clock instead, in both directions.
 */
export const chevronTurns = {
	context: {
		selector: ".context-chevron-icon",
		property: "rotate",
		closed: "180deg",
		open: "90deg",
	},
	piui: {
		pseudoElement: "::before",
		property: "transform",
		closed: "none",
		open: "rotate(90deg)",
	},
};

/**
 * Pure (unit-tested): the state a summary click asks for. A click mid-flight reverses the
 * latest intent (not the DOM state, which stays open while either direction animates);
 * otherwise it toggles the current state.
 */
export function nextDetailsIntent(isOpen, inFlight) {
	return inFlight ? !inFlight.wantOpen : !isOpen;
}

/**
 * Pure (unit-tested): the settle step of a finished accordion. Only the latest intent may
 * set `open`; an older animation that a reversal cancelled must not.
 */
export function settleDetails(details, entry, latest) {
	if (latest !== entry) return false;
	details.open = entry.wantOpen;
	return true;
}

export function bindDetailsMotion() {
	// Capture phase: Enter and Space on a focused summary dispatch `click` too.
	document.addEventListener("click", toggleDetails, true);
}

function toggleDetails(event) {
	const summary =
		event.target instanceof Element ? event.target.closest(summarySelector) : null;
	const details = summary?.parentElement;
	if (!(details instanceof HTMLDetailsElement)) return;
	const content = [...details.children].find((child) => child !== summary);
	if (!(content instanceof HTMLElement)) return;
	event.preventDefault();
	const current = running.get(details);
	const wantOpen = nextDetailsIntent(details.open, current);
	// Start from what is on screen: the in-flight height/opacity, or the resting state.
	const fromHeight = details.getBoundingClientRect().height;
	const fromOpacity = current
		? Number.parseFloat(getComputedStyle(content).opacity)
		: details.open
			? 1
			: 0;
	const chevron = chevronOf(summary);
	const fromTurn = chevron
		? getComputedStyle(chevron.target, chevron.pseudoElement)[chevron.turn.property]
		: undefined;
	for (const animation of current?.animations ?? []) animation.cancel();
	// Open synchronously (never a frame of full height before the animation), measure.
	details.open = true;
	const openHeight = details.getBoundingClientRect().height;
	const closedHeight = summary.getBoundingClientRect().height;
	const toHeight = wantOpen ? openHeight : closedHeight;
	const toOpacity = wantOpen ? 1 : 0;
	const reduce = reducedMotion();
	const ms = reduce ? duration.sm : wantOpen ? duration.lg : duration.md;
	const options = { duration: ms, easing: easing.out, fill: "forwards" };
	const animations = [
		content.animate(
			[
				{ opacity: Number.isFinite(fromOpacity) ? fromOpacity : 1 },
				{ opacity: toOpacity },
			],
			options,
		),
	];
	if (chevron && fromTurn) {
		const { property } = chevron.turn;
		const toTurn = wantOpen ? chevron.turn.open : chevron.turn.closed;
		// Reduced motion: no turn; the chevron snaps to its end state at t0 (held by the fill).
		animations.push(
			chevron.target.animate(
				[{ [property]: reduce ? toTurn : fromTurn }, { [property]: toTurn }],
				{ ...options, pseudoElement: chevron.pseudoElement },
			),
		);
	}
	const tall = openHeight - closedHeight > innerHeight * tallRatio;
	if (!reduce && !tall) {
		details.style.overflow = "clip";
		animations.push(
			details.animate(
				[{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
				options,
			),
		);
	}
	const entry = { animations, wantOpen };
	running.set(details, entry);
	Promise.all(animations.map((animation) => animation.finished)).then(
		() => {
			if (!settleDetails(details, entry, running.get(details))) return;
			running.delete(details);
			details.style.removeProperty("overflow");
			if (chevron) settleChevron(chevron);
			for (const animation of animations) animation.cancel();
		},
		() => {},
	);
}

/** The summary's chevron: the context icon, or the PIUI list's `::before` marker. */
function chevronOf(summary) {
	const icon = summary.querySelector(chevronTurns.context.selector);
	if (icon instanceof Element)
		return { target: icon, pseudoElement: undefined, turn: chevronTurns.context };
	if (summary.parentElement?.classList.contains("piui-widget-lines-collapsible"))
		return {
			target: summary,
			pseudoElement: chevronTurns.piui.pseudoElement,
			turn: chevronTurns.piui,
		};
	return undefined;
}

/**
 * The settle's `[open]` flip would start the chevron's own CSS transition toward the value
 * the WAAPI turn already holds; finish it so the chevron never replays. `getAnimations()`
 * flushes style first, while the WAAPI fill still holds the end value.
 */
function settleChevron({ target, pseudoElement, turn }) {
	for (const animation of target.getAnimations({ subtree: Boolean(pseudoElement) })) {
		if (
			animation instanceof CSSTransition &&
			animation.transitionProperty === turn.property &&
			animation.effect?.target === target &&
			(animation.effect.pseudoElement ?? undefined) === pseudoElement
		)
			animation.finish();
	}
}

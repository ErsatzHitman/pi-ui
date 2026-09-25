const triggerSelector = "[data-tooltip]";
const contentSelector = '[data-slot="tooltip-content"]';
const tooltipDelayMs = 600; // keep in sync with overlays.css `transition-delay: 600ms`
/** A tooltip shown within this long of a visible one closing skips its delay and animation. */
const warmWindowMs = 300;
/** When each open tooltip actually becomes visible (after any delay). Per tooltip, because
 * a focused and a hovered tooltip can be open at once. */
const visibleSince = new WeakMap();
/** When the last tooltip that had actually become visible was closed. */
let lastVisibleCloseAt = Number.NEGATIVE_INFINITY;

/** Shows tooltips as top-layer popovers so they stay above panels and inside the viewport. */
export function bindTooltips() {
	if (!("popover" in HTMLElement.prototype)) return;
	document.addEventListener("pointerover", (event) => {
		if (event.pointerType === "touch") return;
		showTooltip(event.target);
	});
	document.addEventListener("pointerout", (event) => {
		hideTooltip(event.target, event.relatedTarget);
	});
	document.addEventListener("focusin", (event) => {
		const trigger = tooltipTrigger(event.target);
		if (!trigger) return;
		// Keyboard focus shows every tooltip; usage indicators also reveal on tap.
		if (!trigger.matches(":focus-visible") && !isUsageTrigger(trigger)) return;
		showTooltip(trigger);
	});
	document.addEventListener("focusout", (event) => {
		hideTooltip(event.target, event.relatedTarget);
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") hideTooltips();
	});
}

function tooltipTrigger(target) {
	return target instanceof Element
		? (target.closest(triggerSelector) ?? undefined)
		: undefined;
}

function tooltipContent(trigger) {
	const content = trigger?.querySelector(contentSelector);
	return content instanceof HTMLElement ? content : undefined;
}

function isUsageTrigger(trigger) {
	return tooltipContent(trigger)?.classList.contains("usage-tooltip") === true;
}

function showTooltip(target) {
	const trigger = tooltipTrigger(target);
	const content = tooltipContent(trigger);
	if (!content || content.matches(":popover-open")) return;
	// Warm row: sweeping along a toolbar after a tooltip was visible shows the next one
	// instantly (overlays.css `[data-instant]`). Not preserved across morphs on purpose:
	// it is recomputed on every show.
	const now = performance.now();
	const warm = now - lastVisibleCloseAt < warmWindowMs;
	content.toggleAttribute("data-instant", warm);
	visibleSince.set(
		content,
		now + (!warm && trigger.hasAttribute("data-tooltip-delay") ? tooltipDelayMs : 0),
	);
	content.showPopover();
}

function hideTooltip(target, related) {
	const content = tooltipContent(tooltipTrigger(target));
	if (!content?.matches(":popover-open")) return;
	if (related instanceof Node && content.contains(related)) return;
	content.hidePopover();
	// Only a tooltip that was actually visible warms the row; a fast sweep keeps the delay.
	const now = performance.now();
	if (now >= (visibleSince.get(content) ?? Number.POSITIVE_INFINITY))
		lastVisibleCloseAt = now;
}

function hideTooltips() {
	for (const content of document.querySelectorAll(`${contentSelector}:popover-open`)) {
		if (content instanceof HTMLElement) content.hidePopover();
	}
	lastVisibleCloseAt = Number.NEGATIVE_INFINITY;
}

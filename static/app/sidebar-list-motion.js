// Session list motion (flow-spec B9, motion round 2): when the server re-sorts, inserts or
// removes sidebar rows, moved rows glide to their new slot (FLIP), new rows settle in and
// removed rows leave through a ghost, instead of teleporting between two frames.
//
// Morph safety: rows are id-keyed (`session-sidebar-row-<path>`), so a reorder reuses nodes
// and only genuinely new or removed ids animate. `aria-disabled` churn on every commit is an
// attribute change, which this observer never sees.
import {
	duration,
	easing,
	ghostExit,
	reducedMotion,
	staggerCap,
	staggerStepMs,
} from "./motion.js";

const rowSelector = 'li[id^="session-sidebar-row-"]';
const flipId = "list-flip";
/** B-X3: a delete-pending row rests at this opacity (session-sidebar.css `[data-deleting]`). */
const deletingOpacity = 0.45;

/**
 * Pure (unit-tested): compares two `id → { top }` layouts (tops relative to the list).
 * `moved` carries the FLIP offset old − new; `added`/`removed` are ids in document order.
 */
export function diffRows(previous, next) {
	const moved = [];
	const added = [];
	const removed = [];
	for (const [id, rect] of next) {
		const old = previous.get(id);
		if (old === undefined) added.push(id);
		else if (Math.abs(old.top - rect.top) > 0.5)
			moved.push({ id, dy: old.top - rect.top });
	}
	for (const id of previous.keys()) {
		if (!next.has(id)) removed.push(id);
	}
	return { moved, added, removed };
}

/**
 * Pure (unit-tested): the FLIP curve for a batch. A removal closes its gap on ease-out, so
 * the rows below start moving in the ghost's first frames instead of idling on the in-out
 * curve's slow start, which left a hole beside a ghost already gone (SP-11). A pure reorder
 * keeps the symmetric in-out glide.
 */
export function flipEasing(removedCount) {
	return removedCount > 0 ? easing.out : easing.inOut;
}

/**
 * Pure (unit-tested): the ghost for a removed row. A delete-pending row (B-X3) was dimmed, and
 * the clone loses `data-deleting`, so the ghost starts from the dimmed opacity instead of
 * flashing back to 1. Reduced motion: a shorter fade (ghostExit drops the movement itself).
 */
export function removedRowGhost(row, reduce) {
	return {
		translateY: "0",
		scale: 0.97,
		// md, not sm: the ghost fades across the gap's collapse instead of ahead of it (SP-11).
		ms: reduce ? duration.xs : duration.md,
		fromOpacity: row.hasAttribute("data-deleting") ? deletingOpacity : 1,
	};
}

/**
 * Layout boxes relative to the list, from offset* (which ignore transforms), so an in-flight
 * FLIP or entry scale never skews the measurement and scrolling never shifts it.
 */
function measureRows(list) {
	const rows = new Map();
	for (const row of list.querySelectorAll(rowSelector)) {
		if (!(row instanceof HTMLElement)) continue;
		rows.set(row.id, {
			top: row.offsetTop - list.offsetTop,
			left: row.offsetLeft - list.offsetLeft,
			width: row.offsetWidth,
			height: row.offsetHeight,
		});
	}
	return rows;
}

function removedRowNodes(records) {
	const nodes = new Map();
	for (const record of records) {
		for (const node of record.removedNodes) {
			if (!(node instanceof Element)) continue;
			const rows = node.matches(rowSelector)
				? [node]
				: node.querySelectorAll(rowSelector);
			for (const row of rows) nodes.set(row.id, row);
		}
	}
	return nodes;
}

/** Binds the single production instance (called by src/client/pane-motion.ts). */
export function bindSessionListMotion() {
	const sidebar = document.getElementById("session-sidebar");
	if (!(sidebar instanceof HTMLDialogElement)) return;
	const listElement = () => document.getElementById("session-sidebar-content");
	let cache = new Map();
	const refresh = () => {
		const list = listElement();
		cache =
			sidebar.open && list instanceof HTMLElement ? measureRows(list) : new Map();
	};
	// A closed dialog has no boxes: forget the layout on close and re-measure once it opens, so
	// the first change after opening already animates (and the first population never does).
	sidebar.addEventListener("toggle", refresh);
	// The desktop sidebar is restored open (and rendered with its rows) before this binds, so
	// its toggle already fired: measure now, or the first delete after a load has no layout to
	// diff against and the row vanishes. An empty SSR list stays unmeasured, so the first
	// catalog population still never animates.
	refresh();

	new MutationObserver((records) => {
		const list = listElement();
		if (!sidebar.open || !(list instanceof HTMLElement) || cache.size === 0) {
			refresh();
			return;
		}
		const next = measureRows(list);
		const { moved, added, removed } = diffRows(cache, next);
		const reduce = reducedMotion();
		const origin = list.getBoundingClientRect();

		if (!reduce) {
			const flipCurve = flipEasing(removed.length);
			for (const { id, dy } of moved) {
				const row = document.getElementById(id);
				const layoutTop = next.get(id)?.top;
				if (!row || layoutTop === undefined) continue;
				// Retarget: a row still gliding from the last change starts from where it is drawn
				// (its old slot plus the running offset), never from its old slot.
				let running = 0;
				const flips = row
					.getAnimations()
					.filter((animation) => animation.id === flipId);
				if (flips.length > 0) {
					running = row.getBoundingClientRect().top - origin.top - layoutTop;
					for (const animation of flips) animation.cancel();
				}
				const offset = dy + running;
				if (Math.abs(offset) <= 0.5) continue;
				row.animate(
					[{ transform: `translateY(${offset}px)` }, { transform: "none" }],
					{
						duration: duration.lg,
						easing: flipCurve,
						id: flipId,
					},
				);
			}
		}

		for (const [index, id] of added.entries()) {
			document.getElementById(id)?.animate(
				reduce
					? [{ opacity: 0 }, { opacity: 1 }]
					: [
							{ opacity: 0, transform: "translateY(-0.25rem) scale(0.97)" },
							{ opacity: 1, transform: "none" },
						],
				{
					duration: reduce ? duration.sm : duration.md,
					easing: easing.out,
					delay: Math.min(index, staggerCap - 1) * staggerStepMs,
					fill: "backwards",
				},
			);
		}

		if (removed.length > 0) {
			const nodes = removedRowNodes(records);
			// The phone drawer is a modal in the top layer: a ghost on <body> would render under it
			// (flow-critique #18). ghostExit corrects for the drawer's own translate.
			const host = sidebar.matches(":modal") ? sidebar : document.body;
			for (const id of removed) {
				const node = nodes.get(id);
				const rect = cache.get(id);
				if (!node || !rect) continue;
				ghostExit(
					node,
					{
						left: origin.left + rect.left,
						top: origin.top + rect.top,
						width: rect.width,
						height: rect.height,
					},
					{ ...removedRowGhost(node, reduce), host },
				);
			}
		}
		cache = next;
	}).observe(sidebar, { childList: true, subtree: true });
}

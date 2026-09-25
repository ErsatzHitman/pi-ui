// Session list motion (flow-spec B9, motion round 2): when the server re-sorts, inserts or
// removes sidebar rows, moved rows glide to their new slot (FLIP), new rows settle in and
// removed rows leave through a ghost, instead of teleporting between two frames.
//
// Nothing draws over anything else (round 4): date-group headings FLIP with the rows, a row
// that leapfrogs others (moved to the top) rides above them on the pane surface, and an item
// entering a slot a displaced neighbour still covers is revealed by a clip that tracks that
// neighbour's glide, so the list visibly makes room instead of printing text on text.
//
// Morph safety: rows and headings are id-keyed (`session-sidebar-row-<path>`,
// `session-sidebar-<day>`), so a reorder reuses nodes and only genuinely new or removed ids
// animate. `aria-disabled` churn on every commit is an attribute change, which this observer
// never sees.
import {
	duration,
	easing,
	ghostExit,
	reducedMotion,
	staggerCap,
	staggerStepMs,
} from "./motion.js";

/** Every id-keyed list item that can move: session rows and date-group headings. */
const rowSelector = 'li[id^="session-sidebar-row-"], .session-group-heading[id]';
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
 * Pure (unit-tested): ids whose glide crosses another item's (their relative order flipped).
 * Of each crossing pair the farther traveller is lifted, so a row moved to the top slides
 * over the rows making room for it instead of through them.
 */
export function liftedRows(previous, next) {
	const lifted = new Set();
	const shared = [];
	for (const [id, rect] of next) {
		const old = previous.get(id);
		if (old !== undefined) shared.push({ id, from: old.top, to: rect.top });
	}
	for (const [index, a] of shared.entries()) {
		for (let other = index + 1; other < shared.length; other++) {
			const b = shared[other];
			if ((a.from - b.from) * (a.to - b.to) >= 0) continue;
			const farther =
				Math.abs(a.to - a.from) >= Math.abs(b.to - b.from) ? a.id : b.id;
			lifted.add(farther);
		}
	}
	return lifted;
}

function round(value) {
	return Math.round(value * 100) / 100;
}

/**
 * Pure (unit-tested): clip keyframes that keep a static item (an entering row or heading in its
 * final slot, or a removed item's ghost in its old one) to the part of its slot no gliding
 * neighbour covers. `slot` is `{ top, height }`; each occupant's drawn top glides `from` → `to`
 * (with its `height`) over the FLIP. Offsets are FLIP *progress*, so the caller runs these on
 * the FLIP's own duration and easing: every bound is then linear in the offset and the
 * sampled keyframes can only clip more than needed, never less. A neighbour on the slot's
 * lower side (leaving downward, or arriving from below) bounds the visible bottom; one on its
 * upper side bounds the visible top. Opacity follows the visible fraction. Returns undefined
 * when no occupant ever covers the slot, so a plain entry or fade is safe.
 */
export function clearFrames(slot, occupants, steps = 12) {
	const bottom = slot.top + slot.height;
	const below = occupants.filter(
		(o) =>
			(o.to > o.from && o.to >= bottom - 0.5) ||
			(o.from > o.to && o.from >= bottom - 0.5),
	);
	const above = occupants.filter(
		(o) =>
			(o.to < o.from && o.to + o.height <= slot.top + 0.5) ||
			(o.from < o.to && o.from + o.height <= slot.top + 0.5),
	);
	const frames = [];
	let covered = false;
	for (let step = 0; step <= steps; step++) {
		const offset = step / steps;
		const at = (o) => o.from + (o.to - o.from) * offset;
		let visibleTop = slot.top;
		let visibleBottom = bottom;
		for (const o of below) visibleBottom = Math.min(visibleBottom, at(o));
		for (const o of above) visibleTop = Math.max(visibleTop, at(o) + o.height);
		const topInset = Math.min(slot.height, Math.max(0, visibleTop - slot.top));
		const visible = Math.max(0, visibleBottom - slot.top - topInset);
		if (visible < slot.height - 0.5) covered = true;
		frames.push({
			offset,
			clipPath: `inset(${round(topInset)}px 0 ${round(slot.height - topInset - visible)}px 0)`,
			opacity: round(visible / slot.height),
		});
	}
	return covered ? frames : undefined;
}

/** The opaque surface the list sits on (the sidebar pane), to back a lifted row. */
function surfaceBehind(element) {
	for (let node = element; node instanceof Element; node = node.parentElement) {
		const color = getComputedStyle(node).backgroundColor;
		if (color && color !== "transparent" && !/\/\s*0\)$|,\s*0\)$/.test(color))
			return color;
	}
	return undefined;
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
		const flipCurve = flipEasing(removed.length);
		/** Every glide this change starts, as drawn: what entering items and ghosts yield to. */
		const occupants = [];

		if (!reduce) {
			const lifted = liftedRows(cache, next);
			const surface = lifted.size > 0 ? surfaceBehind(list) : undefined;
			for (const { id, dy } of moved) {
				const row = document.getElementById(id);
				const layout = next.get(id);
				if (!row || layout === undefined) continue;
				// Retarget: a row still gliding from the last change starts from where it is drawn
				// (its old slot plus the running offset), never from its old slot.
				let running = 0;
				const flips = row
					.getAnimations()
					.filter((animation) => animation.id === flipId);
				if (flips.length > 0) {
					running = row.getBoundingClientRect().top - origin.top - layout.top;
					for (const animation of flips) animation.cancel();
				}
				const offset = dy + running;
				if (Math.abs(offset) <= 0.5) continue;
				occupants.push({
					from: layout.top + offset,
					to: layout.top,
					height: layout.height,
				});
				// A leapfrogging row rides above the rows it crosses, backed by the pane surface,
				// so their text never shows through its own (2 clears the rows' z-index 1 content).
				const lift =
					lifted.has(id) && surface
						? { zIndex: 2, backgroundColor: surface }
						: {};
				row.animate(
					[
						{ transform: `translateY(${offset}px)`, ...lift },
						{ transform: "none", ...lift },
					],
					{
						duration: duration.lg,
						easing: flipCurve,
						id: flipId,
					},
				);
			}
		}

		let plainIndex = 0;
		for (const id of added) {
			const item = document.getElementById(id);
			const slot = next.get(id);
			if (!item || !slot) continue;
			// Entering a slot a displaced neighbour still covers: reveal only what it has vacated,
			// on the FLIP's own clock (duration and curve), so the two never overlap.
			const reveal = reduce ? undefined : clearFrames(slot, occupants);
			if (reveal) {
				item.animate(reveal, { duration: duration.lg, easing: flipCurve });
				continue;
			}
			item.animate(
				reduce
					? [{ opacity: 0 }, { opacity: 1 }]
					: [
							{ opacity: 0, transform: "translateY(-0.25rem) scale(0.97)" },
							{ opacity: 1, transform: "none" },
						],
				{
					duration: reduce ? duration.sm : duration.md,
					easing: easing.out,
					delay: Math.min(plainIndex, staggerCap - 1) * staggerStepMs,
					fill: "backwards",
				},
			);
			plainIndex += 1;
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
				const exit = ghostExit(
					node,
					{
						left: origin.left + rect.left,
						top: origin.top + rect.top,
						width: rect.width,
						height: rect.height,
					},
					{ ...removedRowGhost(node, reduce), host },
				);
				// Neighbours closing the gap slide over the fading ghost: clip it back to the part
				// they have not reached yet (clip only; the ghost keeps its own fade).
				const cover = reduce ? undefined : clearFrames(rect, occupants);
				const ghost = exit?.effect?.target;
				if (cover && ghost instanceof Element) {
					ghost.animate(
						cover.map(({ offset, clipPath }) => ({ offset, clipPath })),
						{ duration: duration.lg, easing: flipCurve, fill: "forwards" },
					);
				}
			}
		}
		cache = next;
	}).observe(sidebar, { childList: true, subtree: true });
}

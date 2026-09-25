// Prompt chrome entries and exits that CSS cannot do morph-safely (flow-spec D2/D6,
// flow-critique #9/#17): keyed nodes the server morphs in and out of #prompt-queue and
// #prompt-status. Entries play only for ids that were not on screen a moment ago, so a
// morph that moves or re-inserts a kept node (engines without `moveBefore`) never replays
// one. Queue items the server removes leave through a client ghost.
import { duration, easing, ghostExit, motionReady, reducedMotion } from "./motion.js";

const queueItemSelector = ".prompt-queue-item[id]";
const statusSelector =
	"#prompt-working-status, .extension-status[id], .ext-activity-chip[id]";
/** How long a "Restore all" press keeps steering removed items down into the composer. */
const restoreWindowMs = 2000;

/** Pure: the ids in `next` that were not present in `previous`. */
export function freshIds(previous, next) {
	return next.filter((id) => !previous.has(id));
}

/** Pure: an item id without its trailing occurrence (`-0`, `-1`…): behavior + text hash. */
export function queueTextKey(id) {
	return id.replace(/-\d+$/, "");
}

/**
 * Pure: which removed queue items leave through a ghost, and which way.
 * - ✕ pressed (id in `removing`, or `data-exit="down"`): back down the way it entered.
 * - ✕ on one of several identical texts: the server re-renders the survivors, so idiomorph
 *   keeps the pressed node and removes the last same-text id. `reassigned` counts pressed
 *   ids still on screen per text key; such a removal also leaves downward.
 * - "Restore all": down into the composer the text returns to.
 * - Otherwise the steer was delivered: it lifts toward the transcript.
 * An id still present was moved or re-inserted by the morph, not removed. An item that was
 * scrolled out of the queue list (`clipTop + clipBottom` covers it) gets no ghost. Offsets
 * are relative to #prompt-box's bottom-left corner (see `measureQueue`).
 */
export function planQueueExits(
	removed,
	presentIds,
	offsets,
	{ restoring = false, reassigned = new Map(), removing = new Set() } = {},
) {
	const plan = [];
	const strips = new Map(reassigned);
	for (const node of removed) {
		const offset = offsets.get(node.id);
		if (!node.id || presentIds.has(node.id) || !offset) continue;
		if (offset.clipTop + offset.clipBottom >= offset.height) continue;
		const pressed =
			removing.has(node.id) || node.getAttribute("data-exit") === "down";
		const key = queueTextKey(node.id);
		const stripped = !pressed && (strips.get(key) ?? 0) > 0;
		if (stripped) strips.set(key, strips.get(key) - 1);
		const translateY =
			pressed || stripped ? "0.25rem" : restoring ? "0.5rem" : "-0.5rem";
		plan.push({ node, offset, translateY });
	}
	return plan;
}

/**
 * Pure: settles one frame of queue mutations. `removedNodes` is every queue item the
 * frame's MutationObserver callbacks reported removed; a morph may remove and re-add the
 * whole list in separate callbacks, so presence is judged once, from the live DOM
 * (`presentIds`). Returns the removed nodes (one per id) that are really gone, the ids
 * that are really new (`fresh`, for entries) and the ✕-pressed ids idiomorph kept for a
 * same-text survivor (`reassigned`, counted per text key; `kept` lists them).
 */
export function settleQueueFrame(previousIds, presentIds, removedNodes, removing) {
	const gone = new Map();
	for (const node of removedNodes)
		if (node.id && !presentIds.has(node.id) && !gone.has(node.id))
			gone.set(node.id, node);
	const goneKeys = new Set([...gone.keys()].map(queueTextKey));
	const reassigned = new Map();
	const kept = [];
	for (const id of removing) {
		if (!presentIds.has(id) || gone.has(id)) continue;
		const key = queueTextKey(id);
		if (!goneKeys.has(key)) continue;
		reassigned.set(key, (reassigned.get(key) ?? 0) + 1);
		kept.push(id);
	}
	return {
		removed: [...gone.values()],
		fresh: freshIds(previousIds, [...presentIds]),
		reassigned,
		kept,
	};
}

/** Ids whose ✕ was pressed and whose POST is in flight (prompt-box.tsx's ✕ handler). */
function queueRemoving() {
	return globalThis.piUi?.queueRemoving ?? new Set();
}

export function bindPromptMotion() {
	if (!globalThis.MutationObserver) return;
	const queue = document.getElementById("prompt-queue");
	const box = document.getElementById("prompt-box");
	if (queue && box) watchQueue(queue, box);
	const status = document.getElementById("prompt-status");
	if (status) watchStatus(status);
}

/** No entries on page load, or while a replaced transcript settles (session switch). */
function entriesAllowed() {
	return (
		motionReady() && !document.documentElement.hasAttribute("data-transcript-quiet")
	);
}

function keyedNodes(root, selector) {
	return [...root.querySelectorAll(selector)];
}

function removedMatches(records, selector) {
	const nodes = [];
	for (const record of records) {
		for (const node of record.removedNodes) {
			if (!(node instanceof Element)) continue;
			if (node.matches(selector)) nodes.push(node);
			else nodes.push(...node.querySelectorAll(selector));
		}
	}
	return nodes;
}

/** Item rects relative to the bottom-anchored prompt box, so a ghost lands where the item
 * was even if the box slid sideways (pane FLIP) since the last measurement. `clipTop` and
 * `clipBottom` are the parts hidden by the scrolling queue list (max-height 10rem). Call it
 * only when no entry is in flight, or its `translate` skews the rect (see `watchQueue`). */
function measureQueue(queue, box) {
	const anchor = box.getBoundingClientRect();
	const list = queue.querySelector(".prompt-queue-list")?.getBoundingClientRect();
	const offsets = new Map();
	for (const item of keyedNodes(queue, queueItemSelector)) {
		const rect = item.getBoundingClientRect();
		offsets.set(item.id, {
			left: rect.left - anchor.left,
			bottom: rect.top - anchor.bottom,
			width: rect.width,
			height: rect.height,
			clipTop: list ? Math.max(0, list.top - rect.top) : 0,
			clipBottom: list ? Math.max(0, rect.bottom - list.bottom) : 0,
		});
	}
	return offsets;
}

function watchQueue(queue, box) {
	let ids = new Set(keyedNodes(queue, queueItemSelector).map((item) => item.id));
	let offsets = measureQueue(queue, box);
	let transcript = document.getElementById("messages");
	let restoringUntil = 0;
	// One frame of removed items: a morph can remove and re-add the list in separate
	// callbacks, so presence is judged once per frame from the live DOM (flow-critique S1).
	let removedBuffer = [];
	let frame = 0;
	// Offsets stay those from before the frame's removals until it settles.
	const remeasure = () => {
		if (!frame) offsets = measureQueue(queue, box);
	};
	document.addEventListener("pi-ui-queue-restore", () => {
		restoringUntil = performance.now() + restoreWindowMs;
	});
	const settle = () => {
		frame = 0;
		const present = keyedNodes(queue, queueItemSelector);
		const presentIds = new Set(present.map((item) => item.id));
		const removing = queueRemoving();
		const { removed, fresh, reassigned, kept } = settleQueueFrame(
			ids,
			presentIds,
			removedBuffer,
			removing,
		);
		removedBuffer = [];
		const restoring = performance.now() < restoringUntil;
		// A session replace marks the new #messages `data-enter` (a code-theme replace does
		// not): the old session's steers were not delivered, so they vanish with it.
		const nextTranscript = document.getElementById("messages");
		const switched =
			nextTranscript !== transcript &&
			nextTranscript?.hasAttribute("data-enter") === true;
		transcript = nextTranscript;
		const plan =
			switched || !entriesAllowed()
				? []
				: planQueueExits(removed, presentIds, offsets, {
						restoring,
						reassigned,
						removing,
					});
		if (plan.length > 0) {
			const anchor = box.getBoundingClientRect();
			for (const { node, offset, translateY } of plan) {
				const ghost = ghostExit(
					node,
					{
						left: anchor.left + offset.left,
						top: anchor.bottom + offset.bottom,
						width: offset.width,
						height: offset.height,
					},
					{ translateY, ms: duration.sm },
				)?.effect?.target;
				// Stay inside the list's visible box: the ghost is fixed on <body>.
				if (
					ghost instanceof HTMLElement &&
					offset.clipTop + offset.clipBottom > 0
				)
					ghost.style.clipPath = `inset(${offset.clipTop}px 0 ${offset.clipBottom}px 0)`;
			}
		}
		// Gone ids no longer need the double-tap guard; a pressed node kept for a same-text
		// survivor is that survivor now, so it takes taps again.
		for (const node of removed) removing.delete(node.id);
		for (const id of kept) {
			removing.delete(id);
			document.getElementById(id)?.removeAttribute("data-exit");
		}
		if (restoring && removed.length > 0) restoringUntil = 0;
		if (entriesAllowed() && fresh.length > 0) {
			const entering = new Set(fresh);
			// Re-measure once each entry settles: its in-flight `translate` skews the rect.
			for (const item of present)
				if (entering.has(item.id))
					enterQueueItem(item).finished.then(remeasure, noop);
		}
		ids = presentIds;
		remeasure();
	};
	new MutationObserver((records) => {
		removedBuffer.push(...removedMatches(records, queueItemSelector));
		if (!frame) frame = requestAnimationFrame(settle);
	}).observe(queue, { childList: true, subtree: true });
	// The composer growing (typing, widgets) moves the bottom-anchored queue up, and scrolling
	// the queue list moves its items.
	new ResizeObserver(remeasure).observe(box);
	queue.addEventListener("scroll", remeasure, { capture: true, passive: true });
}

function noop() {}

function enterQueueItem(item) {
	const reduce = reducedMotion();
	return item.animate(
		reduce
			? [{ opacity: 0 }, { opacity: 1 }]
			: [
					{ opacity: 0, translate: "0 0.25rem" },
					{ opacity: 1, translate: "0 0" },
				],
		{ duration: duration.sm, easing: easing.out, fill: "backwards" },
	);
}

function watchStatus(status) {
	let ids = new Set(keyedNodes(status, statusSelector).map((node) => node.id));
	new MutationObserver(() => {
		const present = keyedNodes(status, statusSelector);
		const presentIds = present.map((node) => node.id);
		if (entriesAllowed()) {
			const fresh = new Set(freshIds(ids, presentIds));
			for (const node of present) if (fresh.has(node.id)) enterStatus(node);
		}
		ids = new Set(presentIds);
	}).observe(status, { childList: true, subtree: true });
}

/** "Working…" and statuses fade in (160ms); activity chips also grow from 0.96 (120ms) on
 * `transform`, which composes with their CSS press `scale`. Reduced motion: opacity 120ms. */
function enterStatus(node) {
	if (reducedMotion()) {
		node.animate([{ opacity: 0 }, { opacity: 1 }], {
			duration: duration.sm,
			easing: easing.out,
			fill: "backwards",
		});
		return;
	}
	node.animate([{ opacity: 0 }, { opacity: 1 }], {
		duration: duration.md,
		easing: easing.out,
		fill: "backwards",
	});
	if (node.classList.contains("ext-activity-chip")) {
		node.animate([{ transform: "scale(0.96)" }, { transform: "none" }], {
			duration: duration.sm,
			easing: easing.out,
			fill: "backwards",
		});
	}
}

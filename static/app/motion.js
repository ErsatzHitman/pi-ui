// JS mirror of src/ui/styles/tokens.css motion values. Parity is pinned by motion_test.ts.
export const duration = Object.freeze({
	xs: 80,
	sm: 120,
	md: 160,
	lg: 200,
	xl: 250,
	paneIn: 200,
	paneOut: 160,
});
export const easing = Object.freeze({
	out: "cubic-bezier(0.23, 1, 0.32, 1)",
	inOut: "cubic-bezier(0.77, 0, 0.175, 1)",
	drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
});
/** List stagger (flow-spec §2 rule 7): 40ms steps, at most 4 rows. */
export const staggerStepMs = 40;
export const staggerCap = 4;

export function reducedMotion() {
	return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Set once, two frames after boot: gates every entry that must not play on page load. */
export function motionReady() {
	return document.documentElement.hasAttribute("data-motion-ready");
}

export function markMotionReady() {
	requestAnimationFrame(() =>
		requestAnimationFrame(() =>
			document.documentElement.setAttribute("data-motion-ready", ""),
		),
	);
}

/** CSS cubic-bezier as a JS timing function (for rAF-driven scroll follow). */
export function cubicBezier(x1, y1, x2, y2) {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
	const sampleY = (t) => ((ay * t + by) * t + cy) * t;
	const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
	return (x) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		// Newton-Raphson first; bisection when the slope is too flat to converge.
		let t = x;
		for (let i = 0; i < 8; i++) {
			const error = sampleX(t) - x;
			if (Math.abs(error) < 1e-5) return sampleY(t);
			const slope = slopeX(t);
			if (Math.abs(slope) < 1e-6) break;
			t -= error / slope;
		}
		let lo = 0;
		let hi = 1;
		t = x;
		while (hi - lo > 1e-5) {
			if (sampleX(t) < x) lo = t;
			else hi = t;
			t = (lo + hi) / 2;
		}
		return sampleY(t);
	};
}
export const easeOut = cubicBezier(0.23, 1, 0.32, 1);

/**
 * One-shot entrance for a node that just appeared (an incoming panel, a dialog step, an
 * error line). Call it at the user's action, or from `data-init` on a freshly inserted,
 * id-stable node. No-op before data-motion-ready (page load). Safe on a node that is
 * still display:none: the animation runs on the document timeline and applies from the
 * frame the node renders. Reduced motion: opacity only, 120ms.
 */
export function enter(el, { from = "rise", delay = 0 } = {}) {
	if (!(el instanceof Element) || !motionReady()) return undefined;
	if (reducedMotion()) {
		return el.animate([{ opacity: 0 }, { opacity: 1 }], {
			duration: duration.sm,
			easing: easing.out,
			fill: "backwards",
		});
	}
	const keyframes = {
		fade: [{ opacity: 0 }, { opacity: 1 }],
		rise: [
			{ opacity: 0, translate: "0 0.25rem" },
			{ opacity: 1, translate: "0 0" },
		],
		pop: [
			{ opacity: 0, scale: 0.97 },
			{ opacity: 1, scale: 1 },
		],
	}[from];
	return el.animate(keyframes, {
		duration: from === "fade" ? duration.sm : duration.md,
		delay,
		easing: easing.out,
		fill: "backwards",
	});
}

/**
 * Strips `id` and every `data-*` attribute from `root` and its descendants, so Datastar
 * never binds or morphs a cloned ghost and no id is duplicated in the document.
 */
export function stripCloneAttributes(root) {
	for (const el of [root, ...root.querySelectorAll("*")]) {
		for (const name of el.getAttributeNames()) {
			if (name === "id" || name.startsWith("data-")) el.removeAttribute(name);
		}
	}
	return root;
}

/**
 * Exit for a node that is already gone (or about to be) and cannot transition itself:
 * clones `node` into a fixed, inert layer at `rect` (viewport coordinates) and fades it out.
 * `fromOpacity` starts the fade from the node's resting dim (e.g. a delete-pending row at
 * 0.45) so the ghost never flashes back to 1. `host` is where the ghost is mounted: pass the
 * open modal dialog for a node that lived in the top layer, or the ghost renders beneath it.
 */
export function ghostExit(
	node,
	rect,
	{
		translateY = "-0.5rem",
		scale = 1,
		ms = duration.sm,
		fromOpacity = 1,
		host = document.body,
	} = {},
) {
	if (!rect || rect.width === 0 || rect.height === 0) return undefined;
	const ghost = stripCloneAttributes(node.cloneNode(true));
	ghost.setAttribute("aria-hidden", "true");
	ghost.inert = true;
	Object.assign(ghost.style, {
		position: "fixed",
		left: `${rect.left}px`,
		top: `${rect.top}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`,
		margin: "0",
		boxSizing: "border-box",
		pointerEvents: "none",
		zIndex: "90",
	});
	host.append(ghost);
	if (host !== document.body) {
		// A transformed host (a sliding drawer) is the containing block for fixed children:
		// correct by the measured offset so the ghost lands exactly on `rect`.
		const placed = ghost.getBoundingClientRect();
		ghost.style.left = `${2 * rect.left - placed.left}px`;
		ghost.style.top = `${2 * rect.top - placed.top}px`;
	}
	const to = reducedMotion()
		? { opacity: 0, transform: "none" }
		: { opacity: 0, transform: `translateY(${translateY}) scale(${scale})` };
	const animation = ghost.animate([{ opacity: fromOpacity, transform: "none" }, to], {
		duration: ms,
		easing: easing.out,
		fill: "forwards",
	});
	const remove = () => ghost.remove();
	animation.finished.then(remove, remove);
	return animation;
}

/**
 * Runs a colour-scheme flip (`update` toggles `html.dark`) inside a View Transition tagged
 * `data-vt="theme"`, so base.css crossfades the whole viewport over --duration-xl instead
 * of every surface snapping. Falls back to a plain `update()` without the API, while the
 * tab is hidden, or while another transition runs. `document.activeViewTransition` is not
 * Baseline yet; where it is missing it reads undefined, which is the correct falsy guard.
 */
export function themeTransition(update) {
	const root = document.documentElement;
	if (
		!document.startViewTransition ||
		document.activeViewTransition ||
		document.hidden
	) {
		update();
		return;
	}
	root.setAttribute("data-vt", "theme");
	const transition = document.startViewTransition(update);
	const done = () => root.removeAttribute("data-vt");
	transition.finished.then(done, done);
}

// Self-arm (flow-critique #12b): every importer gets data-motion-ready two frames after
// boot, whatever order the work packages land in. No-op outside a browser (unit tests).
if (globalThis.document && globalThis.requestAnimationFrame) markMotionReady();

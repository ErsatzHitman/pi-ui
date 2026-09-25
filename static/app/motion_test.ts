import { test } from "bun:test";
import { readFileSync } from "node:fs";

import { assert, assertEquals } from "#testing/assertions";

import {
	cubicBezier,
	duration,
	easeOut,
	easing,
	enter,
	ghostExit,
	stripCloneAttributes,
} from "./motion.js";

// Comments are stripped: they mention token names in prose.
const tokens = readFileSync(
	new URL("../../src/ui/styles/tokens.css", import.meta.url),
	"utf8",
).replaceAll(/\/\*[\s\S]*?\*\//g, "");

function token(name: string): string {
	const match = new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(tokens);
	assert(match?.[1], `tokens.css declares ${name}`);
	return match[1].trim();
}

function tokenMs(name: string): number {
	const value = token(name);
	const alias = /^var\((--[\w-]+)\)$/.exec(value);
	if (alias?.[1]) return tokenMs(alias[1]);
	const match = /^(\d+(?:\.\d+)?)ms$/.exec(value);
	assert(match?.[1], `${name} is a ms duration, got ${value}`);
	return Number(match[1]);
}

function normalizedBezier(value: string): string {
	return value.replaceAll(/\s+/g, "");
}

test("motion.js durations mirror tokens.css", () => {
	assertEquals(duration.xs, tokenMs("--duration-xs"));
	assertEquals(duration.sm, tokenMs("--duration-sm"));
	assertEquals(duration.md, tokenMs("--duration-md"));
	assertEquals(duration.lg, tokenMs("--duration-lg"));
	assertEquals(duration.xl, tokenMs("--duration-xl"));
	assertEquals(duration.paneIn, tokenMs("--duration-pane-in"));
	assertEquals(duration.paneOut, tokenMs("--duration-pane-out"));
});

test("motion.js easings mirror tokens.css", () => {
	assertEquals(normalizedBezier(easing.out), normalizedBezier(token("--ease-out")));
	assertEquals(
		normalizedBezier(easing.inOut),
		normalizedBezier(token("--ease-in-out")),
	);
	assertEquals(
		normalizedBezier(easing.drawer),
		normalizedBezier(token("--ease-drawer")),
	);
});

test("cubicBezier matches the CSS curve's shape and endpoints", () => {
	const curve = cubicBezier(0.23, 1, 0.32, 1);
	assertEquals(curve(0), 0);
	assertEquals(curve(1), 1);
	// Reference: solve x(t) = 0.5 by bisection on the parametric curve, then y(t).
	const bezier = (p1: number, p2: number, t: number) =>
		3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 60; i++) {
		const t = (lo + hi) / 2;
		if (bezier(0.23, 0.32, t) < 0.5) lo = t;
		else hi = t;
	}
	const mid = curve(0.5);
	assert(Math.abs(mid - bezier(1, 1, lo)) < 1e-4, `ease-out(0.5) = ${mid}`);
	// A strong ease-out: about 97% of the way at half time (quint-like).
	assert(mid > 0.95 && mid < 0.98, `ease-out(0.5) = ${mid}`);
	assertEquals(easeOut(0.5), mid);
	const linear = cubicBezier(0, 0, 1, 1);
	assert(Math.abs(linear(0.3) - 0.3) < 1e-4, "a linear bezier is the identity");
	let previous = 0;
	for (let x = 0.05; x < 1; x += 0.05) {
		const y = curve(x);
		assert(y >= previous, `monotonic at ${x}`);
		previous = y;
	}
});

class FakeElement {
	readonly attributes = new Map<string, string>();
	readonly style: Record<string, string> = {};
	readonly children: FakeElement[] = [];
	inert = false;
	animations: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = [];

	constructor(attributes: Record<string, string> = {}, children: FakeElement[] = []) {
		for (const [name, value] of Object.entries(attributes))
			this.attributes.set(name, value);
		this.children = children;
	}
	getAttributeNames() {
		return [...this.attributes.keys()];
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	hasAttribute(name: string) {
		return this.attributes.has(name);
	}
	querySelectorAll(selector: string): FakeElement[] {
		assertEquals(selector, "*");
		return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
	}
	cloneNode(): FakeElement {
		return new FakeElement(
			Object.fromEntries(this.attributes),
			this.children.map((child) => child.cloneNode()),
		);
	}
	animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
		this.animations.push({ keyframes, options });
		return { finished: new Promise(() => {}) };
	}
	remove() {}
}

/** The browser globals motion.js reads, replaced by stubs for one call. */
type BrowserGlobals = {
	Element?: typeof FakeElement;
	document?: ReturnType<typeof fakeDocument>;
	matchMedia?: ReturnType<typeof matchMediaReporting>;
};

function withGlobals<T>(values: BrowserGlobals, run: () => T): T {
	const originals = Object.keys(values).map(
		(name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
	);
	for (const [name, value] of Object.entries(values)) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			writable: true,
			value,
		});
	}
	try {
		return run();
	} finally {
		for (const [name, original] of originals) {
			if (original) Object.defineProperty(globalThis, name, original);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
}

function fakeDocument(root: FakeElement, body = new FakeElement()) {
	return {
		documentElement: root,
		body: Object.assign(body, {
			appended: [] as FakeElement[],
			append(node: FakeElement) {
				this.appended.push(node);
			},
		}),
	};
}

function matchMediaReporting(reduce: boolean) {
	return (query: string) => ({
		matches: query === "(prefers-reduced-motion: reduce)" ? reduce : false,
	});
}

test("stripCloneAttributes removes ids and data-* from the whole clone", () => {
	const leaf = new FakeElement({
		id: "leaf",
		"data-on:click": "@post()",
		class: "row",
	});
	const root = new FakeElement(
		{ id: "root", "data-deleting": "", "aria-label": "Session", class: "session" },
		[new FakeElement({ "data-show": "$x", title: "t" }, [leaf])],
	);
	stripCloneAttributes(root);
	assertEquals(root.getAttributeNames(), ["aria-label", "class"]);
	assertEquals(root.children[0]?.getAttributeNames(), ["title"]);
	assertEquals(leaf.getAttributeNames(), ["class"]);
});

test("enter is a no-op before data-motion-ready", () => {
	const el = new FakeElement();
	const result = withGlobals(
		{
			Element: FakeElement,
			document: fakeDocument(new FakeElement()),
			matchMedia: matchMediaReporting(false),
		},
		() => enter(el as unknown as Element),
	);
	assertEquals(result, undefined);
	assertEquals(el.animations.length, 0);
});

test("enter rises by default and fades opacity-only under reduced motion", () => {
	const root = new FakeElement({ "data-motion-ready": "" });
	const full = new FakeElement();
	const reduced = new FakeElement();
	withGlobals(
		{
			Element: FakeElement,
			document: fakeDocument(root),
			matchMedia: matchMediaReporting(false),
		},
		() => enter(full as unknown as Element, { delay: 40 }),
	);
	withGlobals(
		{
			Element: FakeElement,
			document: fakeDocument(root),
			matchMedia: matchMediaReporting(true),
		},
		() => enter(reduced as unknown as Element, { from: "pop" }),
	);
	assertEquals(full.animations[0]?.keyframes, [
		{ opacity: 0, translate: "0 0.25rem" },
		{ opacity: 1, translate: "0 0" },
	]);
	assertEquals(full.animations[0]?.options, {
		duration: duration.md,
		delay: 40,
		easing: easing.out,
		fill: "backwards",
	});
	assertEquals(reduced.animations[0]?.keyframes, [{ opacity: 0 }, { opacity: 1 }]);
	assertEquals(reduced.animations[0]?.options.duration, 120);
});

test("ghostExit mounts a stripped, inert clone and fades from fromOpacity", () => {
	const node = new FakeElement({
		id: "session-row-1",
		"data-deleting": "",
		class: "row",
	});
	const document = fakeDocument(new FakeElement());
	const rect = { left: 10, top: 20, width: 200, height: 32 } as DOMRect;
	withGlobals({ document, matchMedia: matchMediaReporting(false) }, () =>
		ghostExit(node as unknown as Element, rect, {
			fromOpacity: 0.45,
			translateY: "0",
			scale: 0.97,
		}),
	);
	const ghost = document.body.appended[0];
	assert(ghost, "the ghost is appended to <body>");
	assertEquals(ghost.getAttributeNames(), ["class", "aria-hidden"]);
	assertEquals(ghost.inert, true);
	assertEquals(ghost.style.position, "fixed");
	assertEquals([ghost.style.left, ghost.style.top], ["10px", "20px"]);
	assertEquals(ghost.animations[0]?.keyframes, [
		{ opacity: 0.45, transform: "none" },
		{ opacity: 0, transform: "translateY(0) scale(0.97)" },
	]);
	assertEquals(ghost.animations[0]?.options.duration, duration.sm);
	assertEquals(node.hasAttribute("id"), true, "the live node keeps its attributes");
});

test("ghostExit in a translated host corrects by the measured offset", () => {
	const document = fakeDocument(new FakeElement());
	const rect = { left: 100, top: 200, width: 240, height: 32 } as DOMRect;
	// A drawer mid-slide is the fixed ghost's containing block: its offset (40, 10)
	// shifts wherever the ghost is placed.
	const host = Object.assign(new FakeElement(), {
		appended: [] as FakeElement[],
		append(node: FakeElement) {
			this.appended.push(node);
			Object.assign(node, {
				getBoundingClientRect: () => ({
					left: Number.parseFloat(node.style.left ?? "0") + 40,
					top: Number.parseFloat(node.style.top ?? "0") + 10,
				}),
			});
		},
	});
	withGlobals({ document, matchMedia: matchMediaReporting(false) }, () =>
		ghostExit(new FakeElement({ class: "row" }) as unknown as Element, rect, {
			host: host as unknown as Element,
		}),
	);
	assertEquals(document.body.appended.length, 0, "not mounted on <body>");
	const ghost = host.appended[0];
	assert(ghost, "the ghost is appended to the host");
	assertEquals([ghost.style.left, ghost.style.top], ["60px", "190px"]);
	const placed = ghost as unknown as { getBoundingClientRect(): DOMRect };
	const landed = placed.getBoundingClientRect();
	assertEquals([landed.left, landed.top], [rect.left, rect.top]);
});

test("ghostExit skips an empty rect", () => {
	const document = fakeDocument(new FakeElement());
	const result = withGlobals({ document }, () =>
		ghostExit(
			new FakeElement() as unknown as Element,
			{ left: 0, top: 0, width: 0, height: 10 } as DOMRect,
		),
	);
	assertEquals(result, undefined);
	assertEquals(document.body.appended.length, 0);
});

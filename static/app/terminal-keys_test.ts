import { test } from "bun:test";

import { assertEquals, assertNotEquals, waitForCondition } from "#testing/assertions";

import { endpoints } from "../../src/server/routes/endpoints.ts";
import {
	bindTerminalSurfaces,
	encodeKeyEvent,
	restoreFocusAfterSurfaceUnmount,
} from "./terminal-keys.js";

function key(
	value: string,
	modifiers: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) {
	return { key: value, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

test("terminal keys encode editing and navigation keys as xterm sequences", () => {
	assertEquals(encodeKeyEvent(key("Enter")), "\r");
	assertEquals(encodeKeyEvent(key("Escape")), "\u001b");
	assertEquals(encodeKeyEvent(key("Backspace")), "\u007f");
	assertEquals(encodeKeyEvent(key("Tab")), "\t");
	assertEquals(encodeKeyEvent(key("Tab", { shiftKey: true })), "\u001b[Z");
	assertEquals(encodeKeyEvent(key("ArrowUp")), "\u001b[A");
	assertEquals(encodeKeyEvent(key("ArrowLeft", { ctrlKey: true })), "\u001b[1;5D");
	assertEquals(encodeKeyEvent(key("PageDown")), "\u001b[6~");
	assertEquals(encodeKeyEvent(key("Delete", { shiftKey: true })), "\u001b[3;2~");
	assertEquals(encodeKeyEvent(key("Home")), "\u001b[H");
});

test("terminal keys fall back to xterm's modifyOtherKeys form for otherwise-unencodable chords", () => {
	// Ctrl+Enter/Ctrl+Tab have no simpler legacy encoding pi-tui's parser accepts.
	assertEquals(encodeKeyEvent(key("Enter", { ctrlKey: true })), "\u001b[27;5;13~");
	assertEquals(encodeKeyEvent(key("Tab", { ctrlKey: true })), "\u001b[27;5;9~");
	assertEquals(
		encodeKeyEvent(key(" ", { ctrlKey: true, altKey: true })),
		"\u001b[27;7;32~",
	);
});

test("terminal keys encode printable text, Ctrl and Alt chords", () => {
	assertEquals(encodeKeyEvent(key("a")), "a");
	assertEquals(encodeKeyEvent(key("Z", { shiftKey: true })), "Z");
	assertEquals(encodeKeyEvent(key("c", { ctrlKey: true })), "\u0003");
	assertEquals(encodeKeyEvent(key("x", { altKey: true })), "\u001bx");
	assertEquals(encodeKeyEvent(key(" ", { ctrlKey: true })), "\u0000");
	assertEquals(encodeKeyEvent(key(" ", { altKey: true })), "\u001b ");
});

test("terminal keys leave bare modifiers and unsupported function keys to the browser", () => {
	assertEquals(encodeKeyEvent(key("Shift", { shiftKey: true })), null);
	assertEquals(encodeKeyEvent(key("F5")), null);
	assertEquals(encodeKeyEvent(key("Escape", { shiftKey: true })), null);
});

/**
 * O11: `bindTerminalSurfaces()`'s cell-grid re-fit (F3: an already-mounted grid whose
 * `data-cols`/`data-rows` reset, and a real resize/rotate) was previously verified only by
 * browser probes. A hand-rolled fake DOM — not a real browser engine — is enough to exercise
 * the exact code paths (`measureCell`, `sendResize`, the attribute-watching `MutationObserver`,
 * and `ResizeObserver`), the same style this codebase already uses for `history-stack_test.ts`'s
 * bind-layer tests; this module has no shared singleton state with that one.
 */
class FakeGridElement {
	dataset: Record<string, string> = {};
	clientWidth = 0;
	computedStyle = {
		paddingInlineStart: "0px",
		paddingInlineEnd: "0px",
		lineHeight: "20px",
	};
	style: Record<string, string> = {};
	textContent = "";
	#rect: { width: number; height: number };
	#closest: FakeGridElement | null = null;
	#query: FakeGridElement | null = null;

	constructor(rect: { width: number; height: number }) {
		this.#rect = rect;
	}
	getBoundingClientRect() {
		return this.#rect;
	}
	setRect(rect: { width: number; height: number }) {
		this.#rect = rect;
	}
	closest() {
		return this.#closest;
	}
	setClosest(target: FakeGridElement | null) {
		this.#closest = target;
	}
	querySelector() {
		return this.#query;
	}
	setQueryResult(target: FakeGridElement | null) {
		this.#query = target;
	}
	setAttribute() {}
}

/**
 * Patches a global via `Object.defineProperty` rather than plain assignment: another test file
 * (`file-transfer_test.ts`) leaves a `configurable: true, writable: false` `ResizeObserver` on
 * `globalThis` for the rest of the process, and a plain `globalThis.ResizeObserver = …` throws
 * against that. Returns a restore function that puts back whatever was there before — the
 * original descriptor if one existed, or removes the property if it didn't — the same pattern
 * `file-transfer_test.ts`'s own `restoreGlobal` uses.
 */
function patchGlobal(name: string, value: unknown): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
	return () => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	};
}

/** Installs the fake globals `bindTerminalSurfaces()` touches; returns a restore function. */
function installFakeDom(options: {
	probeRect: { width: number; height: number };
	grids: FakeGridElement[];
	resizeObserver?: boolean;
	/** `document.documentElement.clientWidth` — only read for a percentage-width overlay (F4). */
	documentElementWidth?: number;
}) {
	const calls: Array<{ url: string; body: unknown }> = [];
	let mutationCallback: ((mutations: unknown[]) => void) | undefined;
	let resizeCallback: ((entries: Array<{ target: unknown }>) => void) | undefined;
	let windowResizeCallback: (() => void) | undefined;

	const restores = [
		patchGlobal("Element", FakeGridElement),
		patchGlobal(
			"MutationObserver",
			class {
				constructor(cb: (mutations: unknown[]) => void) {
					mutationCallback = cb;
				}
				observe() {}
				disconnect() {}
			},
		),
		...(options.resizeObserver
			? [
					patchGlobal(
						"ResizeObserver",
						class {
							constructor(
								cb: (entries: Array<{ target: unknown }>) => void,
							) {
								resizeCallback = cb;
							}
							observe() {}
							disconnect() {}
						},
					),
				]
			: []),
		patchGlobal("getComputedStyle", (el: FakeGridElement) => el.computedStyle),
		patchGlobal("fetch", async (url: string, init: { body: string }) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return new Response("");
		}),
		patchGlobal("document", {
			getElementById: (id: string) =>
				id === "terminal-surface-persistent" ? {} : undefined,
			createElement: () => new FakeGridElement(options.probeRect),
			documentElement: { clientWidth: options.documentElementWidth ?? 0 },
			body: { appendChild: () => {}, removeChild: () => {} },
			head: { appendChild: () => {} },
			addEventListener: () => {},
			querySelectorAll: () => options.grids,
		}),
		patchGlobal("window", {
			addEventListener: (name: string, cb: () => void) => {
				if (name === "resize") windowResizeCallback = cb;
			},
		}),
	];

	return {
		calls,
		getMutationCallback: () => mutationCallback,
		getResizeCallback: () => resizeCallback,
		getWindowResizeCallback: () => windowResizeCallback,
		restore: () => {
			for (const restore of restores) restore();
		},
	};
}

// This test MUST run before any other test in this file that calls `bindTerminalSurfaces()`:
// `ensureResizeObserver()` in terminal-keys.js caches its `ResizeObserver` instance in a
// module-level singleton the first time anything calls it (mirroring how `resizeObserver` is
// never re-created); whichever `ResizeObserver` class is installed at that first call wins for
// the rest of the process. `file-transfer_test.ts` installs its own inert one at import time
// (also process-wide), so this test installs its capturing one and calls `bindTerminalSurfaces`
// first, before that inert one can ever be the one constructed.
test("a mounted surface re-fits through ResizeObserver when its grid is resized or rotated (O11)", async () => {
	const grid = new FakeGridElement({ width: 0, height: 480 });
	grid.dataset.terminalSurfaceGrid = "s-resize";
	const body = new FakeGridElement({ width: 0, height: 0 });
	body.dataset.cols = "80";
	body.dataset.rows = "24";
	body.clientWidth = 700;
	grid.setQueryResult(body);

	const dom = installFakeDom({
		probeRect: { width: 140, height: 20 },
		grids: [grid],
		resizeObserver: true,
	});
	try {
		bindTerminalSurfaces();
		await waitForCondition(() => dom.calls.length >= 1, {
			timeoutMs: 1000,
			message: "expected a resize POST when the surface first mounted",
		});
		assertEquals(dom.calls[0]?.body, { surfaceId: "s-resize", cols: 100, rows: 24 });

		const resizeCallback = dom.getResizeCallback();
		assertNotEquals(resizeCallback, undefined);
		// A rotate/viewport resize shrinks the grid's own box; ResizeObserver reports it.
		grid.setRect({ width: 0, height: 200 });
		resizeCallback?.([{ target: grid }]);

		await waitForCondition(() => dom.calls.length >= 2, {
			timeoutMs: 1000,
			message: "expected a second resize POST after the grid's box changed",
		});
		assertEquals(dom.calls[1]?.body, { surfaceId: "s-resize", cols: 100, rows: 10 });
	} finally {
		dom.restore();
	}
});

test("a window resize re-fits every mounted surface even when its own grid box didn't change (F4)", async () => {
	// An overlay's box is sized in `ch`/`dvh` from its last resolved column/row count
	// (`overlayStyleVars`), so widening or narrowing the browser window alone never changes the
	// grid element's own size — the ResizeObserver the other test above exercises has nothing to
	// fire on. Only a `window` "resize" listener catches this case.
	const grid = new FakeGridElement({ width: 0, height: 480 });
	grid.dataset.terminalSurfaceGrid = "s-window-resize";
	const body = new FakeGridElement({ width: 0, height: 0 });
	body.dataset.cols = "80";
	body.dataset.rows = "24";
	body.clientWidth = 700;
	grid.setQueryResult(body);

	const dom = installFakeDom({
		probeRect: { width: 140, height: 20 },
		grids: [grid],
		resizeObserver: true,
	});
	try {
		bindTerminalSurfaces();
		await waitForCondition(() => dom.calls.length >= 1, {
			timeoutMs: 1000,
			message: "expected a resize POST when the surface first mounted",
		});

		const windowResizeCallback = dom.getWindowResizeCallback();
		assertNotEquals(windowResizeCallback, undefined);
		// The grid's own box (`getBoundingClientRect`) is left exactly as it was — only the
		// window "resize" event fires, and a wider body box simulates the page's own layout
		// (not the grid) reacting to the new window size.
		body.clientWidth = 900;
		windowResizeCallback?.();

		await waitForCondition(() => dom.calls.length >= 2, {
			timeoutMs: 1000,
			message: "expected a second resize POST after a bare window resize",
		});
		assertEquals(dom.calls[1]?.body, {
			surfaceId: "s-window-resize",
			cols: 128,
			rows: 24,
		});
	} finally {
		dom.restore();
	}
});

test("a re-mounted persistent surface re-fits when the server resets its data-cols/data-rows (F3/O11)", async () => {
	const grid = new FakeGridElement({ width: 0, height: 400 });
	grid.dataset.terminalSurfaceGrid = "s-attrs";
	const body = new FakeGridElement({ width: 0, height: 0 });
	body.dataset.cols = "80";
	body.dataset.rows = "24";
	body.clientWidth = 700;
	grid.setQueryResult(body);
	body.setClosest(grid);

	const dom = installFakeDom({ probeRect: { width: 140, height: 20 }, grids: [] });
	try {
		bindTerminalSurfaces();
		const mutationCallback = dom.getMutationCallback();
		assertNotEquals(mutationCallback, undefined);
		// Mirrors the server resetting a re-mounted grid to its default size (setWidget called
		// again, /reload, a session switch): only the data-cols/data-rows attributes change.
		mutationCallback?.([
			{ type: "attributes", target: body, addedNodes: [], removedNodes: [] },
		]);

		await waitForCondition(() => dom.calls.length > 0, {
			timeoutMs: 1000,
			message: "expected a resize POST after data-cols/data-rows changed",
		});
		assertEquals(dom.calls[0]?.url, endpoints.terminalSurfaceResize);
		assertEquals(dom.calls[0]?.body, { surfaceId: "s-attrs", cols: 100, rows: 20 });
	} finally {
		dom.restore();
	}
});

test("focus returns to the prompt when a focused overlay or inline surface unmounts", () => {
	class FakeNode {
		constructor(private readonly classes: string[]) {}
		matches(selector: string) {
			return selector
				.split(",")
				.some((part) => this.classes.includes(part.trim().replace(/^\./, "")));
		}
		querySelector() {
			return null;
		}
	}
	interface FakeDocument {
		body: object;
		activeElement: object;
		getElementById(id: string): { focus(): void } | null;
	}
	let focused = 0;
	const body = {};
	const fakeDocument: FakeDocument = {
		body,
		activeElement: body,
		getElementById: (id: string) =>
			id === "prompt-input" ? { focus: () => (focused += 1) } : null,
	};
	const restores = [
		patchGlobal("Element", FakeNode),
		patchGlobal("document", fakeDocument),
	];
	try {
		restoreFocusAfterSurfaceUnmount([
			new FakeNode(["dialog", "terminal-surface-dialog"]),
		]);
		assertEquals(focused, 1);
		restoreFocusAfterSurfaceUnmount([
			new FakeNode(["terminal-surface", "terminal-surface-inline"]),
		]);
		assertEquals(focused, 2);
		// A persistent widget unmounting must not pull focus (it never held it).
		restoreFocusAfterSurfaceUnmount([
			new FakeNode(["terminal-surface", "terminal-surface-widget"]),
		]);
		assertEquals(focused, 2);
		// Focus that already moved somewhere real is left alone.
		fakeDocument.activeElement = { id: "somewhere" };
		restoreFocusAfterSurfaceUnmount([
			new FakeNode(["dialog", "terminal-surface-dialog"]),
		]);
		assertEquals(focused, 2);
	} finally {
		for (const restore of restores) restore();
	}
});

test("an overlay reports the rows its dialog can grow to, not the rows it currently shows", async () => {
	// A component that sizes itself from `terminal.rows` (ask_user's overlay) must not see the
	// few rows its own short first render occupies, or it renders a "too short" stub forever.
	const content = new FakeGridElement({ width: 700, height: 130 });
	Object.assign(content.computedStyle, { maxHeight: "600px" });
	const grid = new FakeGridElement({ width: 0, height: 96 });
	grid.dataset.terminalSurfaceGrid = "s-overlay";
	grid.dataset.terminalSurfaceKind = "overlay";
	grid.setClosest(content);
	const body = new FakeGridElement({ width: 0, height: 0 });
	body.dataset.cols = "80";
	body.dataset.rows = "4";
	body.clientWidth = 700;
	grid.setQueryResult(body);
	body.setClosest(grid);

	const dom = installFakeDom({ probeRect: { width: 140, height: 20 }, grids: [] });
	try {
		bindTerminalSurfaces();
		dom.getMutationCallback()?.([
			{ type: "attributes", target: body, addedNodes: [], removedNodes: [] },
		]);
		await waitForCondition(() => dom.calls.length > 0, {
			timeoutMs: 1000,
			message: "expected a resize POST for the overlay",
		});
		// 600px max-height minus 34px of dialog chrome, at 20px rows.
		assertEquals(dom.calls[0]?.body, { surfaceId: "s-overlay", cols: 100, rows: 28 });
	} finally {
		dom.restore();
	}
});

test("a percentage-width overlay measures against the viewport, not its own already-sized box (F4)", async () => {
	// The dialog is now sized to exactly fit the already-resolved column count
	// (`terminal-surface.tsx`'s `overlayStyleVars`), so measuring it directly and feeding it
	// back as `cols` would resolve `OverlayOptions.width`'s percentage a second time — each
	// pass narrowing further with no floor, instead of the ~8% gap the un-narrowed box used to
	// leave. `data-terminal-surface-percent-width` (set only for a `N%` width) routes this
	// measurement through the viewport instead, the same reference the percentage was already
	// resolved against server-side.
	const content = new FakeGridElement({ width: 700, height: 130 });
	const grid = new FakeGridElement({ width: 0, height: 96 });
	grid.dataset.terminalSurfaceGrid = "s-percent";
	grid.dataset.terminalSurfaceKind = "overlay";
	grid.dataset.terminalSurfacePercentWidth = "true";
	grid.setClosest(content);
	const body = new FakeGridElement({ width: 0, height: 0 });
	body.dataset.cols = "80";
	body.dataset.rows = "24";
	// The box's own (already 92%-resolved) content width — the old bug's reference.
	body.clientWidth = 644;
	grid.setQueryResult(body);
	body.setClosest(grid);

	const dom = installFakeDom({
		probeRect: { width: 140, height: 20 },
		grids: [],
		documentElementWidth: 1400,
	});
	try {
		bindTerminalSurfaces();
		dom.getMutationCallback()?.([
			{ type: "attributes", target: body, addedNodes: [], removedNodes: [] },
		]);
		await waitForCondition(() => dom.calls.length > 0, {
			timeoutMs: 1000,
			message: "expected a resize POST for the percentage overlay",
		});
		// (1400 viewport - 56 chrome) / 7px cells = 192 cols — not ~92 (644 / 7), which is what
		// re-measuring the already-narrowed box would have produced.
		assertEquals(dom.calls[0]?.body, { surfaceId: "s-percent", cols: 192, rows: 4 });
	} finally {
		dom.restore();
	}
});

test("a percentage-width overlay shrinks to a narrowed viewport instead of keeping its old box (F4)", async () => {
	// After the window narrows, the box is still sized for the old, wider viewport: flooring
	// the reference at that box kept the overlay wider than the new viewport.
	const content = new FakeGridElement({ width: 1762, height: 130 });
	const grid = new FakeGridElement({ width: 0, height: 96 });
	grid.dataset.terminalSurfaceGrid = "s-narrowed";
	grid.dataset.terminalSurfaceKind = "overlay";
	grid.dataset.terminalSurfacePercentWidth = "true";
	grid.setClosest(content);
	const body = new FakeGridElement({ width: 0, height: 0 });
	body.dataset.cols = "244";
	body.dataset.rows = "24";
	body.clientWidth = 1726;
	grid.setQueryResult(body);
	body.setClosest(grid);

	const dom = installFakeDom({
		probeRect: { width: 140, height: 20 },
		grids: [],
		documentElementWidth: 768,
	});
	try {
		bindTerminalSurfaces();
		dom.getMutationCallback()?.([
			{ type: "attributes", target: body, addedNodes: [], removedNodes: [] },
		]);
		await waitForCondition(() => dom.calls.length > 0, {
			timeoutMs: 1000,
			message: "expected a resize POST for the narrowed percentage overlay",
		});
		// (768 viewport - 36 chrome) / 7px cells = 104 cols, not the old box's 246.
		assertEquals(dom.calls[0]?.body, { surfaceId: "s-narrowed", cols: 104, rows: 4 });
	} finally {
		dom.restore();
	}
});

test("a numeric-width overlay still measures its own box (only a percentage needs the viewport)", async () => {
	const content = new FakeGridElement({ width: 700, height: 130 });
	const grid = new FakeGridElement({ width: 0, height: 96 });
	grid.dataset.terminalSurfaceGrid = "s-numeric";
	grid.dataset.terminalSurfaceKind = "overlay";
	grid.setClosest(content);
	const body = new FakeGridElement({ width: 0, height: 0 });
	body.dataset.cols = "80";
	body.dataset.rows = "24";
	body.clientWidth = 560;
	grid.setQueryResult(body);
	body.setClosest(grid);

	const dom = installFakeDom({
		probeRect: { width: 140, height: 20 },
		grids: [],
		documentElementWidth: 1400,
	});
	try {
		bindTerminalSurfaces();
		dom.getMutationCallback()?.([
			{ type: "attributes", target: body, addedNodes: [], removedNodes: [] },
		]);
		await waitForCondition(() => dom.calls.length > 0, {
			timeoutMs: 1000,
			message: "expected a resize POST for the numeric-width overlay",
		});
		// 560 / 7px cells = 80 cols, ignoring the (irrelevant, much larger) viewport reference.
		assertEquals(dom.calls[0]?.body, { surfaceId: "s-numeric", cols: 80, rows: 4 });
	} finally {
		dom.restore();
	}
});

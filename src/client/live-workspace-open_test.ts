import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { bindDismissibleHistory } from "../../static/app/history-stack.js";
import {
	bindLiveWorkspace,
	rubberBand,
	scrimOpacity,
	sheetRelease,
} from "./live-workspace-open.ts";

/** Patches a global via `Object.defineProperty` (see live-workspace-layout_test.ts). */
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

type Layout = {
	viewportWidthPx: number;
	panePosition: "relative" | "fixed" | "absolute";
};

/**
 * Fakes just the DOM `bindLiveWorkspace()` and `bindDismissibleHistory()` touch: `#app` (its
 * `live-workspace-open` class and the SSR'd initial-open signal attribute), the pane (its
 * computed `position`, which is how the CSS says docked vs overlay), the viewport width (what
 * `isDockedLayout()` asks `matchMedia` about), and a history guard that records push/pop.
 */
function installFakeLiveWorkspace(
	options: Layout & { initiallyOpen: boolean; classAppliedAtBind?: boolean },
) {
	const layout: Layout = { ...options };
	const classApplied = options.classAppliedAtBind ?? options.initiallyOpen;
	const classes = new Set<string>(classApplied ? ["live-workspace-open"] : []);
	const appEvents: Array<{ type: string; open: unknown }> = [];
	const bodyEvents: Array<{ type: string; open: unknown }> = [];
	let classObserver: (() => void) | undefined;
	const record = (log: typeof appEvents) => (event: Event) => {
		log.push({ type: event.type, open: (event as CustomEvent).detail?.open });
		return true;
	};
	const app = {
		classList: { contains: (name: string) => classes.has(name) },
		getAttribute: (name: string) =>
			name === "data-signals:_live-workspace-open__ifmissing"
				? String(options.initiallyOpen)
				: null,
		dispatchEvent: record(appEvents),
		setAttribute() {},
		toggleAttribute() {},
	};
	const focusCalls: unknown[] = [];
	const focus = { inPane: false, toggleFocusedWhileInert: undefined as unknown };
	// SSR renders the closed pane inert.
	const pane = {
		inert: true,
		querySelector: () => ({ focus: (options?: unknown) => focusCalls.push(options) }),
		contains: () => focus.inPane,
		addEventListener() {},
	};
	const toggle = {
		focus: () => {
			focus.toggleFocusedWhileInert = pane.inert;
			focus.inPane = false;
		},
	};
	const shell = { getBoundingClientRect: () => ({ width: layout.viewportWidthPx }) };
	// Not motion-ready: the pane choreography's arm (pane-motion.ts) stays a no-op here.
	const documentElement = { hasAttribute: () => false };
	const body = { dispatchEvent: record(bodyEvents) };
	const elements = new Map<
		string,
		typeof app | typeof pane | typeof shell | typeof toggle
	>([
		["app", app],
		["live-workspace", pane],
		["live-workspace-toggle", toggle],
		["workspace-shell", shell],
	]);
	const fakeDocument = {
		body,
		documentElement,
		activeElement: null,
		addEventListener() {},
		getElementById: (id: string) => elements.get(id) ?? null,
	};
	const history = { pushes: 0, pops: 0 };
	let popstate: (() => void) | undefined;
	const restores = [
		patchGlobal("document", fakeDocument),
		patchGlobal("window", {
			addEventListener: (_type: string, listener: () => void) =>
				(popstate = listener),
		}),
		patchGlobal("getComputedStyle", (element: unknown) =>
			element === documentElement
				? { fontSize: "16px" }
				: { position: element === pane ? layout.panePosition : "static" },
		),
		patchGlobal("matchMedia", (query: string) => ({
			matches: query === "(width >= 64rem)" && layout.viewportWidthPx >= 1024,
		})),
		patchGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
			callback(0);
			return 0;
		}),
		patchGlobal(
			"MutationObserver",
			class {
				#callback: () => void;
				constructor(callback: () => void) {
					this.#callback = callback;
				}
				observe(target: unknown) {
					if (target === app) classObserver = this.#callback;
				}
				disconnect() {
					if (classObserver === this.#callback) classObserver = undefined;
				}
			},
		),
	];
	bindDismissibleHistory(
		{
			notifyOpen: () => (history.pushes += 1),
			notifyClose: () => (history.pops += 1),
			handlePopstate: (hasOpen: () => boolean, close: () => void) => {
				if (hasOpen()) close();
			},
		},
		// The patched globals: typed as the real `Document`/`Window` the defaults expect.
		document,
		window,
	);
	const binding = bindLiveWorkspace();
	return {
		binding,
		pane,
		focus,
		focusCalls,
		history,
		appEvents,
		bodyEvents,
		setOpenClass(open: boolean) {
			if (open) classes.add("live-workspace-open");
			else classes.delete("live-workspace-open");
			classObserver?.();
		},
		pressBack: () => popstate?.(),
		restore() {
			binding.dispose();
			for (const restore of restores.reverse()) restore();
		},
	};
}

test("a pane restored open in the docked layout stays open and is not a Back target", () => {
	const dom = installFakeLiveWorkspace({
		initiallyOpen: true,
		viewportWidthPx: 1600,
		panePosition: "relative",
	});
	try {
		assertEquals(dom.appEvents, []);
		assertEquals(dom.history.pushes, 0);
		dom.pressBack();
		// Docked, the pane is part of the layout: Back leaves it alone.
		assertEquals(dom.appEvents, []);
		assertEquals(dom.bodyEvents, []);
	} finally {
		dom.restore();
	}
});

test("a pane restored open at an overlay width closes without persisting (O10)", () => {
	const dom = installFakeLiveWorkspace({
		initiallyOpen: true,
		viewportWidthPx: 700,
		panePosition: "fixed",
	});
	try {
		assertEquals(dom.appEvents, [{ type: "pi-ui-live-workspace-open", open: false }]);
		// No preferences event: the docked-layout preference survives for wider windows.
		assertEquals(dom.bodyEvents, []);
		assertEquals(dom.history.pushes, 0);
	} finally {
		dom.restore();
	}
});

test("a restored open state adopted after Datastar applies the class late", () => {
	const dom = installFakeLiveWorkspace({
		initiallyOpen: true,
		classAppliedAtBind: false,
		viewportWidthPx: 1600,
		panePosition: "relative",
	});
	try {
		// SSR said "open" but the class wasn't applied yet at bind time.
		assertEquals(dom.appEvents, []);
		dom.setOpenClass(true);
		// Adopted as open, docked: no close, no history entry, and the data-effect's own
		// `applyOpen(true)` afterwards is a no-op.
		dom.binding.applyOpen(true);
		assertEquals(dom.appEvents, []);
		assertEquals(dom.history.pushes, 0);
		dom.binding.applyOpen(false);
		assertEquals(dom.history.pops, 0);
	} finally {
		dom.restore();
	}
});

test("a late-applied restored open state at an overlay width is closed (O10)", () => {
	const dom = installFakeLiveWorkspace({
		initiallyOpen: true,
		classAppliedAtBind: false,
		viewportWidthPx: 700,
		panePosition: "fixed",
	});
	try {
		assertEquals(dom.appEvents, []);
		dom.setOpenClass(true);
		assertEquals(dom.appEvents, [{ type: "pi-ui-live-workspace-open", open: false }]);
		assertEquals(dom.bodyEvents, []);
		assertEquals(dom.history.pushes, 0);
	} finally {
		dom.restore();
	}
});

test("Back closes a pane opened as an overlay, without a second history pop", () => {
	const dom = installFakeLiveWorkspace({
		initiallyOpen: false,
		viewportWidthPx: 700,
		panePosition: "fixed",
	});
	try {
		dom.setOpenClass(true);
		dom.binding.applyOpen(true);
		assertEquals(dom.history.pushes, 1);
		// Focus moves into the sliding pane without scrolling the app (LW-P0 lurch, B6).
		assertEquals(dom.focusCalls, [{ preventScroll: true }]);

		dom.pressBack();
		assertEquals(dom.appEvents, [{ type: "pi-ui-live-workspace-open", open: false }]);
		assertEquals(dom.bodyEvents, [
			{ type: "pi-ui-live-workspace-preferences", open: false },
		]);
		// The back press consumed the entry; the resulting close must not pop again.
		dom.setOpenClass(false);
		dom.binding.applyOpen(false);
		assertEquals(dom.history.pops, 0);
	} finally {
		dom.restore();
	}
});

test("closing an overlay pane normally pops its history entry once", () => {
	const dom = installFakeLiveWorkspace({
		initiallyOpen: false,
		viewportWidthPx: 700,
		panePosition: "absolute",
	});
	try {
		dom.setOpenClass(true);
		dom.binding.applyOpen(true);
		dom.setOpenClass(false);
		dom.binding.applyOpen(false);
		assertEquals(dom.history, { pushes: 1, pops: 1 });
	} finally {
		dom.restore();
	}
});

test("a closing pane leaves the Tab order after focus has left it; reopening clears inert (C6)", () => {
	const dom = installFakeLiveWorkspace({
		initiallyOpen: false,
		viewportWidthPx: 1600,
		panePosition: "relative",
	});
	try {
		dom.setOpenClass(true);
		dom.binding.applyOpen(true);
		assertEquals(dom.pane.inert, false);
		// Focus was inside the pane (a tab button) when it closed.
		dom.focus.inPane = true;
		dom.setOpenClass(false);
		dom.binding.applyOpen(false);
		assertEquals(dom.focus.toggleFocusedWhileInert, false);
		assertEquals(dom.pane.inert, true);
		dom.setOpenClass(true);
		dom.binding.applyOpen(true);
		assertEquals(dom.pane.inert, false);
	} finally {
		dom.restore();
	}
});

test("the scrim fades with the sheet's downward travel only (LW-V2-09)", () => {
	assertEquals(scrimOpacity(0, 400), 1);
	assertEquals(scrimOpacity(100, 400), 0.75);
	assertEquals(scrimOpacity(600, 400), 0);
	// An upward over-drag keeps the scrim at full strength.
	assertEquals(scrimOpacity(-50, 400), 1);
});

test("a released sheet drag dismisses on a flick or past 30% of its height (B-X1)", () => {
	assertEquals(sheetRelease(40, 400, 0.2), "dismiss");
	assertEquals(sheetRelease(130, 400, 0), "dismiss");
	assertEquals(sheetRelease(100, 400, 0.05), "restore");
});

test("dragging the sheet up rubber-bands; dragging it down tracks 1:1 (B-X1)", () => {
	const up = rubberBand(-400, 400);
	if (up > -140 || up < -160) throw new Error(`expected about -150, got ${up}`);
	assertEquals(rubberBand(50, 400), 50);
});

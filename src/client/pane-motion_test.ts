import { test } from "bun:test";

import { assertEquals, assertFalse } from "#testing/assertions";

import {
	armPaneMotion,
	classifyChange,
	closePane,
	commitPaneMutations,
	dockedPanes,
	openPane,
	type Pane,
	type PaneLayoutState,
	predictState,
	releasePane,
} from "./pane-motion.ts";

function state(overrides: Partial<PaneLayoutState> = {}): PaneLayoutState {
	return {
		appClasses: new Set(),
		sidebarOpen: false,
		sidebarModal: false,
		wideForLive: true,
		wideForReview: true,
		...overrides,
	};
}

const panes = (...names: Pane[]) => new Set<Pane>(names);

test("dockedPanes: only a non-modal open Sessions sidebar reserves layout", () => {
	assertEquals(dockedPanes(state({ sidebarOpen: true })), panes("sessions"));
	assertEquals(dockedPanes(state({ sidebarOpen: true, sidebarModal: true })), panes());
});

test("dockedPanes: Live docks only at the 64rem breakpoint", () => {
	const live = new Set(["live-workspace-open"]);
	assertEquals(dockedPanes(state({ appClasses: live })), panes("live"));
	assertEquals(dockedPanes(state({ appClasses: live, wideForLive: false })), panes());
});

test("dockedPanes: Review takes the dock from Live, and docks only when wide enough", () => {
	assertEquals(
		dockedPanes(
			state({ appClasses: new Set(["live-workspace-open", "review-open"]) }),
		),
		panes("review"),
	);
	assertEquals(
		dockedPanes(
			state({ appClasses: new Set(["review-open"]), wideForReview: false }),
		),
		panes(),
	);
});

test("classifyChange: none, open, close", () => {
	assertEquals(classifyChange(panes("sessions"), panes("sessions")), { kind: "none" });
	assertEquals(classifyChange(panes(), panes("sessions")), {
		kind: "open",
		pane: "sessions",
	});
	assertEquals(classifyChange(panes("live"), panes()), { kind: "close", pane: "live" });
});

test("classifyChange: Sessions and Live swap in place, both ways", () => {
	assertEquals(classifyChange(panes("sessions"), panes("live")), { kind: "swap" });
	assertEquals(classifyChange(panes("live"), panes("sessions")), { kind: "swap" });
});

test("classifyChange: Review opening while Live closes is compound (snaps)", () => {
	assertEquals(classifyChange(panes("live"), panes("review")), { kind: "compound" });
	assertEquals(classifyChange(panes(), panes("sessions", "review")), {
		kind: "compound",
	});
});

test("predictState: opening one right pane closes the other (sidebar-exclusive)", () => {
	const sessionsOpen = state({ sidebarOpen: true });
	const liveOpened = predictState(sessionsOpen, "live", true);
	assertEquals(dockedPanes(liveOpened), panes("live"));
	const back = predictState(liveOpened, "sessions", true);
	assertEquals(dockedPanes(back), panes("sessions"));
	assertEquals(dockedPanes(predictState(back, "sessions", false)), panes());
	assertEquals([...predictState(state(), "review", true).appClasses], ["review-open"]);
});

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

class FakeAttributes {
	readonly attributes = new Map<string, string>();
	readonly writes: string[] = [];
	readonly classList = {
		contains: (name: string) =>
			(this.attributes.get("class") ?? "").split(/\s+/u).includes(name),
	};
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attributes.has(name);
	}
	setAttribute(name: string, value: string) {
		this.writes.push(name);
		this.attributes.set(name, value);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
}

type Recorded = {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	cancelled: boolean;
	duration: number;
	startTime: CSSNumberish | null;
};

/** A controllable promise (a fake Animation's `ready` / `finished`). */
function deferred() {
	let resolve = () => {};
	let reject = () => {};
	const promise = new Promise<void>((onResolve, onReject) => {
		resolve = () => onResolve();
		reject = () => onReject(new Error("cancelled"));
	});
	promise.catch(() => {});
	return { promise, resolve, reject };
}

/** Stands in for the browser's CSSTransition so `instanceof` works under bun. */
class FakeTransition {
	readonly #ready = deferred();
	readonly #finished = deferred();
	readonly ready = this.#ready.promise;
	readonly finished = this.#finished.promise;
	readonly effect: { getComputedTiming(): { duration: number } };
	constructor(
		readonly transitionProperty: string,
		durationMs: number,
		readonly startTime: number,
	) {
		this.effect = { getComputedTiming: () => ({ duration: durationMs }) };
	}
	/** The transition's first frame (its `ready`). */
	start() {
		this.#ready.resolve();
	}
	finish() {
		this.#finished.resolve();
	}
}

/**
 * A desktop page with one FLIP target (the message stack): it sits at x=100 when no pane
 * reserves layout and at x=0 once the Sessions or Live reserve applies (open, and not held).
 * `stackWidths` is its [free, reserved] width (a >=1280 page keeps 50rem both ways).
 */
function installFakePage(options: {
	sidebarOpen: boolean;
	ready?: boolean;
	reduce?: boolean;
	stackWidths?: [number, number];
}) {
	const [freeWidth, reservedWidth] = options.stackWidths ?? [800, 600];
	const app = new FakeAttributes();
	app.attributes.set("class", "workspace-canvas app-shell");
	const paneAnimations = new Map<string, FakeTransition[]>();
	class FakeDialog extends FakeAttributes {
		closedBy = "none";
		getAnimations() {
			return paneAnimations.get("session-sidebar") ?? [];
		}
	}
	const sidebar = new FakeDialog();
	if (options.sidebarOpen) sidebar.attributes.set("open", "");
	const chatStyle = new Map<string, string>();
	const chat = Object.assign(new FakeAttributes(), {
		style: {
			setProperty: (name: string, value: string) => chatStyle.set(name, value),
			removeProperty: (name: string) => chatStyle.delete(name),
		},
	});
	const reserved = () =>
		(sidebar.hasAttribute("open") &&
			app.getAttribute("data-reserve-hold") !== "sessions") ||
		((app.getAttribute("class") ?? "").includes("live-workspace-open") &&
			app.getAttribute("data-reserve-hold") !== "live");
	const animations: Recorded[] = [];
	const counts = { rects: 0, getAnimations: 0 };
	const stack = {
		isConnected: true,
		matches: (selector: string) => selector === "#messages > .messages-stack",
		getBoundingClientRect: () => {
			counts.rects++;
			return {
				left: reserved() ? 0 : 100,
				width: reserved() ? reservedWidth : freeWidth,
			};
		},
		getAnimations: () => {
			counts.getAnimations++;
			return [];
		},
		animate: (keyframes: Keyframe[], animationOptions: KeyframeAnimationOptions) => {
			const recorded: Recorded = {
				keyframes,
				options: animationOptions,
				cancelled: false,
				duration: Number(animationOptions.duration),
				startTime: null,
			};
			animations.push(recorded);
			return {
				get playState() {
					return recorded.cancelled ? "idle" : "running";
				},
				cancel: () => (recorded.cancelled = true),
				effect: {
					updateTiming: (timing: EffectTiming) =>
						(recorded.duration = Number(timing.duration)),
				},
				set startTime(value: CSSNumberish | null) {
					recorded.startTime = value;
				},
			};
		},
	};
	const shell = { getBoundingClientRect: () => ({ width: 1280 }) };
	const pane = { getAnimations: () => paneAnimations.get("live-workspace") ?? [] };
	const elements = new Map<string, unknown>([
		["app", app],
		["session-sidebar", sidebar],
		["chat-pane", chat],
		["workspace-shell", shell],
		["live-workspace", pane],
	]);
	const timers: Array<() => void> = [];
	const frames: Array<() => void> = [];
	const restores = [
		patchGlobal("HTMLDialogElement", FakeDialog),
		patchGlobal("CSSTransition", FakeTransition),
		patchGlobal("document", {
			documentElement: {
				hasAttribute: (name: string) =>
					name === "data-motion-ready" && options.ready !== false,
				classList: { contains: () => false },
			},
			getElementById: (id: string) => elements.get(id) ?? null,
			querySelectorAll: () => [stack],
		}),
		patchGlobal("getComputedStyle", () => ({ fontSize: "16px" })),
		patchGlobal("matchMedia", (query: string) => ({
			matches: query.includes("reduce") ? options.reduce === true : true,
		})),
		patchGlobal("setTimeout", (callback: () => void) => timers.push(callback)),
		patchGlobal("clearTimeout", () => {}),
		patchGlobal("requestAnimationFrame", (callback: () => void) =>
			frames.push(callback),
		),
	];
	const settle = async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	};
	return {
		app,
		sidebar,
		chat,
		chatStyle,
		stack,
		animations,
		counts,
		/** Gives `id`'s pane a running CSS transition on `property`. */
		transition(id: string, property: string, durationMs = 200, startTime = 1000) {
			const transition = new FakeTransition(property, durationMs, startTime);
			paneAnimations.set(id, [...(paneAnimations.get(id) ?? []), transition]);
			return transition;
		},
		async runTimers() {
			for (const timer of timers.splice(0)) timer();
			await settle();
		},
		async runFrames() {
			for (const frame of frames.splice(0)) frame();
			await settle();
		},
		settle,
		async restore() {
			for (let round = 0; round < 3; round++) {
				for (const frame of frames.splice(0)) frame();
				for (const timer of timers.splice(0)) timer();
				await settle();
			}
			for (const restore of restores.reverse()) restore();
		},
	};
}

const asTargets = (page: ReturnType<typeof installFakePage>) => [
	page.stack as unknown as HTMLElement,
];
const at = (left: number, width = 800) => ({ left, width });

test("arming an open holds the reserve before the trigger changes anything", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		armPaneMotion("sessions", true);
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		assertFalse(page.app.hasAttribute("data-pane-swap"));
	} finally {
		await page.restore();
	}
});

test("arming a Sessions to Live swap marks the swap synchronously, with no hold", async () => {
	const page = installFakePage({ sidebarOpen: true });
	try {
		armPaneMotion("live", true);
		// The nested Sessions close in the same task merges into the same prediction.
		armPaneMotion("sessions", false);
		assertEquals(page.app.getAttribute("data-pane-swap"), "");
		assertFalse(page.app.hasAttribute("data-reserve-hold"));
	} finally {
		await page.restore();
	}
});

test("arming does nothing before data-motion-ready, and never holds under reduced motion", async () => {
	const early = installFakePage({ sidebarOpen: false, ready: false });
	try {
		armPaneMotion("sessions", true);
		assertEquals(early.app.writes, []);
	} finally {
		await early.restore();
	}
	const reduced = installFakePage({ sidebarOpen: false, reduce: true });
	try {
		armPaneMotion("sessions", true);
		assertFalse(reduced.app.hasAttribute("data-reserve-hold"));
	} finally {
		await reduced.restore();
	}
});

test("open('sessions') holds the reserve, locks the column and FLIPs from the visual x", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		const visual = [page.stack.getBoundingClientRect()];
		page.sidebar.setAttribute("open", "");
		openPane("sessions", asTargets(page), visual, true);
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		assertEquals(page.chat.getAttribute("data-pane-lock"), "");
		assertEquals(page.chatStyle.get("--pane-lock-stack"), "600px");
		const [flip] = page.animations;
		assertEquals(flip?.keyframes, [
			{ transform: "translateX(0px)" },
			{ transform: "translateX(-100px)" },
		]);
		assertEquals(flip?.options.id, "pane-flip");
		assertEquals(flip?.options.fill, "forwards");
	} finally {
		await page.restore();
	}
});

test("open with an unchanged column width sets no lock and measures one layout", async () => {
	// >=1280: the stack is 50rem with or without the Sessions reserve.
	const page = installFakePage({ sidebarOpen: false, stackWidths: [800, 800] });
	try {
		const visual = [page.stack.getBoundingClientRect()];
		page.sidebar.setAttribute("open", "");
		page.counts.rects = 0;
		openPane("sessions", asTargets(page), visual, true);
		assertFalse(page.chat.writes.includes("data-pane-lock"));
		assertFalse(page.chatStyle.has("--pane-lock-stack"));
		// Only the post-open layout is read; the held layout is `visual` itself.
		assertEquals(page.counts.rects, 1);
		assertEquals(page.animations[0]?.keyframes, [
			{ transform: "translateX(0px)" },
			{ transform: "translateX(-100px)" },
		]);
	} finally {
		await page.restore();
	}
});

test("an unsettled visual (FLIP, hold or lock live) still locks and re-measures", async () => {
	const page = installFakePage({ sidebarOpen: false, stackWidths: [800, 800] });
	try {
		page.sidebar.setAttribute("open", "");
		page.counts.rects = 0;
		openPane("sessions", asTargets(page), [at(40)], false);
		assertEquals(page.chat.getAttribute("data-pane-lock"), "");
		assertEquals(page.counts.rects, 2);
		assertEquals(page.animations[0]?.keyframes, [
			{ transform: "translateX(-60px)" },
			{ transform: "translateX(-100px)" },
		]);
	} finally {
		await page.restore();
	}
});

test("an armed open at an unchanged width never writes the lock", async () => {
	const page = installFakePage({ sidebarOpen: false, stackWidths: [800, 800] });
	try {
		armPaneMotion("sessions", true);
		page.sidebar.setAttribute("open", "");
		commitPaneMutations(records(page, { sidebarOpenBefore: false }));
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		assertEquals(page.chat.writes, []);
		assertEquals(page.animations.length, 1);
	} finally {
		await page.restore();
	}
});

test("release() drops the hold and the width lock and ends the FLIP it started", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		page.sidebar.setAttribute("open", "");
		openPane("sessions", asTargets(page), [at(100)]);
		releasePane();
		assertFalse(page.app.hasAttribute("data-reserve-hold"));
		assertFalse(page.chat.hasAttribute("data-pane-lock"));
		assertFalse(page.chatStyle.has("--pane-lock-stack"));
		assertEquals(
			page.animations.map((animation) => animation.cancelled),
			[true],
		);
		// Cancelled through the kept Animation objects: no per-target style flush.
		assertEquals(page.counts.getAnimations, 0);
	} finally {
		await page.restore();
	}
});

test("an open commits when its slide finishes, never on a timer armed before the slide", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		page.sidebar.setAttribute("open", "");
		openPane("sessions", asTargets(page), [at(100)]);
		const slide = page.transition("session-sidebar", "translate", 180, 1234);
		// A stalled first frame: wall-clock time passes before the slide starts.
		await page.runTimers();
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		await page.runFrames();
		await page.runTimers();
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		// The slide starts: the FLIP moves onto its clock (start time and duration).
		slide.start();
		await page.settle();
		assertEquals(page.animations[0]?.startTime, 1234);
		assertEquals(page.animations[0]?.duration, 180);
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		slide.finish();
		await page.settle();
		assertFalse(page.app.hasAttribute("data-reserve-hold"));
		assertEquals(page.animations[0]?.cancelled, true);
	} finally {
		await page.restore();
	}
});

test("an open with no slide commits on the fallback timer armed from the first frame", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		page.sidebar.setAttribute("open", "");
		openPane("sessions", asTargets(page), [at(100)]);
		await page.runTimers();
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		await page.runFrames();
		await page.runTimers();
		assertFalse(page.app.hasAttribute("data-reserve-hold"));
	} finally {
		await page.restore();
	}
});

test("closing mid-open releases the hold instead of re-applying the reserve (keep)", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		page.sidebar.setAttribute("open", "");
		openPane("sessions", asTargets(page), [at(100)]);
		page.sidebar.removeAttribute("open");
		closePane(asTargets(page), [at(40)], "sessions");
		assertFalse(page.app.hasAttribute("data-reserve-hold"));
		assertFalse(page.app.writes.includes("data-reserve-keep"));
		const close = page.animations.at(-1);
		assertEquals(close?.keyframes, [
			{ transform: "translateX(-60px)" },
			{ transform: "none" },
		]);
		assertEquals(close?.options.duration, 160);
		// A reversed (shortened) exit slide: the content glide shares its clock.
		const slide = page.transition("session-sidebar", "translate", 90, 2000);
		await page.runFrames();
		slide.start();
		await page.settle();
		assertEquals(close?.startTime, 2000);
		assertEquals(close?.duration, 90);
	} finally {
		await page.restore();
	}
});

/** The observer's view of a trigger's DOM change: one record per mutated target. */
function records(
	page: ReturnType<typeof installFakePage>,
	change: { appClassesBefore?: string; sidebarOpenBefore?: boolean },
): MutationRecord[] {
	const list: Array<Partial<MutationRecord>> = [];
	if (change.appClassesBefore !== undefined) {
		list.push({
			target: page.app as unknown as Node,
			oldValue: change.appClassesBefore,
		});
	}
	if (change.sidebarOpenBefore !== undefined) {
		list.push({
			target: page.sidebar as unknown as Node,
			oldValue: change.sidebarOpenBefore ? "" : null,
		});
	}
	return list as MutationRecord[];
}

function assertSettled(page: ReturnType<typeof installFakePage>) {
	assertFalse(page.app.hasAttribute("data-reserve-hold"));
	assertFalse(page.chat.hasAttribute("data-pane-lock"));
	assertFalse(page.chatStyle.has("--pane-lock-stack"));
	const open = page.animations.find(
		(animation) => animation.options.fill === "forwards",
	);
	assertEquals(open?.cancelled, true);
}

test("a swap while an armed open settles commits that open and glides from where it is drawn", async () => {
	const page = installFakePage({ sidebarOpen: false });
	const classes = "workspace-canvas app-shell";
	try {
		armPaneMotion("sessions", true);
		page.sidebar.setAttribute("open", "");
		commitPaneMutations(records(page, { sidebarOpenBefore: false }));
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		// alt+L before the slide ends: Live opens, and the nested Sessions close merges in.
		armPaneMotion("live", true);
		armPaneMotion("sessions", false);
		page.app.attributes.set("class", `${classes} live-workspace-open`);
		page.sidebar.removeAttribute("open");
		commitPaneMutations(
			records(page, { appClassesBefore: classes, sidebarOpenBefore: true }),
		);
		assertEquals(page.app.getAttribute("data-pane-swap"), "");
		assertSettled(page);
		// Armed at x=100 (reserve held); the Live reserve now puts the stack at x=0.
		assertEquals(page.animations.at(-1)?.keyframes, [
			{ transform: "translateX(100px)" },
			{ transform: "none" },
		]);
	} finally {
		await page.restore();
	}
});

test("an unarmed swap while an open settles reads the held layout, then commits it", async () => {
	const page = installFakePage({ sidebarOpen: false });
	const classes = "workspace-canvas app-shell";
	try {
		page.sidebar.setAttribute("data-animate-open", "");
		page.sidebar.setAttribute("open", "");
		commitPaneMutations(records(page, { sidebarOpenBefore: false }));
		assertEquals(page.app.getAttribute("data-reserve-hold"), "sessions");
		page.app.attributes.set("class", `${classes} live-workspace-open`);
		page.sidebar.removeAttribute("open");
		commitPaneMutations(
			records(page, { appClassesBefore: classes, sidebarOpenBefore: true }),
		);
		assertEquals(page.app.getAttribute("data-pane-swap"), "");
		assertSettled(page);
		assertEquals(page.animations.at(-1)?.keyframes, [
			{ transform: "translateX(100px)" },
			{ transform: "none" },
		]);
	} finally {
		await page.restore();
	}
});

test("a swap keeps data-pane-swap until the incoming pane's fade has run", async () => {
	const page = installFakePage({ sidebarOpen: true });
	const classes = "workspace-canvas app-shell";
	try {
		armPaneMotion("live", true);
		armPaneMotion("sessions", false);
		page.app.attributes.set("class", `${classes} live-workspace-open`);
		page.sidebar.removeAttribute("open");
		commitPaneMutations(
			records(page, { appClassesBefore: classes, sidebarOpenBefore: true }),
		);
		const fade = page.transition("live-workspace", "opacity");
		// A stalled first frame: no timer armed in the toggle task may clear the swap.
		await page.runTimers();
		assertEquals(page.app.getAttribute("data-pane-swap"), "");
		await page.runFrames();
		await page.runTimers();
		assertEquals(page.app.getAttribute("data-pane-swap"), "");
		fade.finish();
		await page.settle();
		// Dropped only after a style update has hidden the outgoing pane.
		await page.runFrames();
		assertEquals(page.app.getAttribute("data-pane-swap"), "");
		await page.runFrames();
		assertFalse(page.app.hasAttribute("data-pane-swap"));
	} finally {
		await page.restore();
	}
});

test("a swap with no incoming fade clears on the timer armed from the first frame", async () => {
	const page = installFakePage({ sidebarOpen: true });
	const classes = "workspace-canvas app-shell";
	try {
		armPaneMotion("live", true);
		armPaneMotion("sessions", false);
		page.app.attributes.set("class", `${classes} live-workspace-open`);
		page.sidebar.removeAttribute("open");
		commitPaneMutations(
			records(page, { appClassesBefore: classes, sidebarOpenBefore: true }),
		);
		await page.runTimers();
		assertEquals(page.app.getAttribute("data-pane-swap"), "");
		await page.runFrames();
		await page.runTimers();
		assertFalse(page.app.hasAttribute("data-pane-swap"));
	} finally {
		await page.restore();
	}
});

test("a reopen mid-close puts the FLIP on the reversed slide's clock before the first frame", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		// The close is still sliding out; reopening reverses it, and a reversed CSS
		// transition already has its start time when the FLIP is created.
		page.sidebar.setAttribute("open", "");
		page.transition("session-sidebar", "translate", 124, 294);
		openPane("sessions", asTargets(page), [at(57)], false);
		assertEquals(page.animations[0]?.startTime, 294);
		assertEquals(page.animations[0]?.duration, 124);
		// No frame needed: the content cannot lag the pane by one frame.
	} finally {
		await page.restore();
	}
});

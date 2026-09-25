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
};

/**
 * A desktop page with one FLIP target (the message stack): it sits at x=100 when no pane
 * reserves layout and at x=0 once the Sessions or Live reserve applies (open, and not held).
 */
function installFakePage(options: {
	sidebarOpen: boolean;
	ready?: boolean;
	reduce?: boolean;
}) {
	const app = new FakeAttributes();
	app.attributes.set("class", "workspace-canvas app-shell");
	class FakeDialog extends FakeAttributes {
		closedBy = "none";
		getAnimations() {
			return [];
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
	const stack = {
		isConnected: true,
		matches: (selector: string) => selector === "#messages > .messages-stack",
		getBoundingClientRect: () => ({
			left: reserved() ? 0 : 100,
			width: reserved() ? 600 : 800,
		}),
		getAnimations: () =>
			animations.flatMap((animation) =>
				animation.cancelled
					? []
					: [
							{
								id: animation.options.id,
								cancel: () => (animation.cancelled = true),
							},
						],
			),
		animate: (keyframes: Keyframe[], animationOptions: KeyframeAnimationOptions) => {
			animations.push({ keyframes, options: animationOptions, cancelled: false });
		},
	};
	const shell = { getBoundingClientRect: () => ({ width: 1280 }) };
	const pane = { getAnimations: () => [] };
	const elements = new Map<string, unknown>([
		["app", app],
		["session-sidebar", sidebar],
		["chat-pane", chat],
		["workspace-shell", shell],
		["live-workspace", pane],
	]);
	const timers: Array<() => void> = [];
	const restores = [
		patchGlobal("HTMLDialogElement", FakeDialog),
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
	];
	return {
		app,
		sidebar,
		chat,
		chatStyle,
		stack,
		animations,
		async restore() {
			for (const timer of timers.splice(0)) timer();
			await Promise.resolve();
			await Promise.resolve();
			for (const restore of restores.reverse()) restore();
		},
	};
}

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
		const visual = [page.stack.getBoundingClientRect().left];
		page.sidebar.setAttribute("open", "");
		openPane("sessions", [page.stack as unknown as HTMLElement], visual);
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

test("release() drops the hold and the width lock and ends the FLIP", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		page.sidebar.setAttribute("open", "");
		openPane("sessions", [page.stack as unknown as HTMLElement], [100]);
		releasePane();
		assertFalse(page.app.hasAttribute("data-reserve-hold"));
		assertFalse(page.chat.hasAttribute("data-pane-lock"));
		assertFalse(page.chatStyle.has("--pane-lock-stack"));
		assertEquals(
			page.animations.map((animation) => animation.cancelled),
			[true],
		);
	} finally {
		await page.restore();
	}
});

test("closing mid-open releases the hold instead of re-applying the reserve (keep)", async () => {
	const page = installFakePage({ sidebarOpen: false });
	try {
		page.sidebar.setAttribute("open", "");
		openPane("sessions", [page.stack as unknown as HTMLElement], [100]);
		page.sidebar.removeAttribute("open");
		closePane([page.stack as unknown as HTMLElement], [40]);
		assertFalse(page.app.hasAttribute("data-reserve-hold"));
		assertFalse(page.app.writes.includes("data-reserve-keep"));
		const close = page.animations.at(-1);
		assertEquals(close?.keyframes, [
			{ transform: "translateX(-60px)" },
			{ transform: "none" },
		]);
		assertEquals(close?.options.duration, 160);
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

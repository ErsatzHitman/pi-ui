import { test } from "bun:test";

import type { Component, OverlayHandle } from "@earendil-works/pi-tui";

import { assertEquals, assertExists, assertStringIncludes } from "#testing/assertions";

import { TerminalSurfaceController } from "./terminal-surface-controller.ts";
import type { TerminalSurface } from "./types.ts";

/** Minimal `Component` fixture: renders fixed lines, no cached state to invalidate. */
function staticComponent(lines: string[] = []): Component {
	return { render: () => lines, invalidate: () => {} };
}

function makeController() {
	const updates: TerminalSurface[][] = [];
	const controller = new TerminalSurfaceController({
		onUpdate: (surfaces) => updates.push([...surfaces]),
	});
	return { controller, updates };
}

/**
 * `mountCustom()` mounts its component after `await factory(...)` resolves,
 * which (even for a synchronous factory) lands on a later microtask/macrotask
 * turn than the call that started it. Tests that need to inspect the mount
 * (or interact with it) before its returned promise ever settles flush the
 * queue first, rather than racing it.
 */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("mountCustom (inline) renders the component and commits an initial frame", async () => {
	const { controller, updates } = makeController();
	let done: (result: string) => void = () => {};
	const promise = controller.mountCustom<string>({
		id: "inline-1",
		overlay: false,
		colorScheme: "dark",
		factory: (_tui, _theme, _keybindings, resolve) => {
			done = resolve;
			return staticComponent(["hello"]);
		},
	});
	await flush();

	const [surface] = controller.snapshot();
	assertExists(surface);
	assertEquals(surface.kind, "inline");
	assertStringIncludes(surface.lines.join("\n"), "hello");
	assertEquals(updates.length >= 1, true);

	done("picked");
	assertEquals(await promise, "picked");
	// done()/close() disposes the surface: it disappears from the snapshot.
	assertEquals(controller.snapshot(), []);
});

test("mountCustom (overlay) shows the component as an overlay and calls onHandle", async () => {
	const { controller } = makeController();
	let handle: OverlayHandle | undefined;
	const promise = controller.mountCustom<undefined>({
		id: "overlay-1",
		overlay: true,
		colorScheme: "dark",
		overlayOptions: { width: 40 },
		onHandle: (h) => {
			handle = h;
		},
		factory: (_tui, _theme, _keybindings, done) => ({
			render: () => ["overlay body"],
			handleInput: () => done(undefined),
			invalidate: () => {},
		}),
	});
	await flush();

	const [surface] = controller.snapshot();
	assertExists(surface);
	assertEquals(surface.kind, "overlay");
	assertEquals(surface.overlayOptions?.width, 40);
	assertExists(handle);

	controller.handleInput("overlay-1", "\r");
	assertEquals(await promise, undefined);
	assertEquals(controller.snapshot(), []);
});

test("handleInput routes to the mounted component and resize applies the client grid", async () => {
	const { controller } = makeController();
	const received: string[] = [];
	let component: Component | undefined;
	void controller.mountCustom({
		id: "surface-1",
		overlay: false,
		colorScheme: "dark",
		cols: 40,
		rows: 10,
		factory: (tui, _theme, _keybindings) => {
			component = {
				render: () => ["state"],
				handleInput: (data: string) => {
					received.push(data);
					// A real component asks for an immediate re-render after
					// mutating its own state; renderNow() forces a synchronous
					// commit so the test can observe it deterministically.
					tui.renderNow();
				},
				invalidate: () => {},
			};
			return component;
		},
	});
	await flush();
	assertExists(component);

	assertEquals(controller.handleInput("surface-1", "x"), true);
	assertEquals(received, ["x"]);
	assertEquals(controller.handleInput("unknown-id", "x"), false);

	const before = controller.snapshot()[0];
	assertExists(before);
	assertEquals(before.cols, 40);
	assertEquals(before.rows, 10);

	assertEquals(controller.resize("surface-1", { columns: 80, rows: 24 }), true);
	assertEquals(controller.resize("unknown-id", { columns: 80, rows: 24 }), false);
	// resize() only schedules a re-render (coalesced, like any other component-
	// driven update) — it does not force one. Nudge the same synchronous-
	// render path the earlier keystroke used to observe the new grid.
	controller.handleInput("surface-1", "y");
	const after = controller.snapshot()[0];
	assertExists(after);
	assertEquals(after.cols, 80);
	assertEquals(after.rows, 24);

	// The grid is client-measured, so an absurd size is clamped rather than applied.
	controller.resize("surface-1", { columns: 100_000, rows: 100_000 });
	controller.handleInput("surface-1", "z");
	const clamped = controller.snapshot()[0];
	assertExists(clamped);
	assertEquals(clamped.cols < 100_000 && clamped.rows < 100_000, true);

	controller.dispose("surface-1");
});

test("dispose resolves a pending custom() promise with undefined instead of hanging", async () => {
	const { controller } = makeController();
	const promise = controller.mountCustom<string>({
		id: "abandoned",
		overlay: false,
		colorScheme: "dark",
		factory: () => staticComponent(),
	});
	await flush();
	assertEquals(controller.snapshot().length, 1);
	// Simulates a session switch/reload aborting an outstanding custom() call.
	controller.dispose("abandoned");
	assertEquals(await promise, undefined);
	assertEquals(controller.snapshot(), []);
	// Disposing an already-disposed (or unknown) id is a no-op, not an error.
	controller.dispose("abandoned");
});

test("disposeAll tears down every mounted surface and resolves every pending promise", async () => {
	const { controller } = makeController();
	const first = controller.mountCustom<undefined>({
		id: "first",
		overlay: false,
		colorScheme: "dark",
		factory: () => staticComponent(),
	});
	const second = controller.mountCustom<undefined>({
		id: "second",
		overlay: true,
		colorScheme: "light",
		factory: () => staticComponent(),
	});
	controller.mountPersistent({
		id: "widget:example",
		kind: "widget",
		colorScheme: "dark",
		factory: () => staticComponent(["widget"]),
	});
	await flush();
	assertEquals(controller.snapshot().length, 3);

	controller.disposeAll();

	assertEquals(await first, undefined);
	assertEquals(await second, undefined);
	assertEquals(controller.snapshot(), []);
});

test("mountPersistent replaces an existing surface mounted under the same id", () => {
	const { controller } = makeController();
	controller.mountPersistent({
		id: "footer",
		kind: "footer",
		colorScheme: "dark",
		title: "first",
		factory: () => staticComponent(["first footer"]),
	});
	assertEquals(controller.snapshot().length, 1);
	assertStringIncludes(
		controller.snapshot()[0]?.lines.join("\n") ?? "",
		"first footer",
	);

	controller.mountPersistent({
		id: "footer",
		kind: "footer",
		colorScheme: "dark",
		title: "second",
		factory: () => staticComponent(["second footer"]),
	});
	assertEquals(controller.snapshot().length, 1);
	assertStringIncludes(
		controller.snapshot()[0]?.lines.join("\n") ?? "",
		"second footer",
	);

	controller.disposeAll();
});

test("a factory that throws resolves undefined and never leaves a mounted surface behind", async () => {
	const { controller } = makeController();
	const result = await controller.mountCustom<string>({
		id: "throws",
		overlay: false,
		colorScheme: "dark",
		factory: () => {
			throw new Error("boom");
		},
	});
	assertEquals(result, undefined);
	assertEquals(controller.snapshot(), []);
});

test("an overlay renders its component at the resolved overlay width, not the full grid", async () => {
	const { controller } = makeController();
	const widths: number[] = [];
	void controller.mountCustom({
		id: "sized",
		overlay: true,
		colorScheme: "dark",
		cols: 159,
		overlayOptions: { width: 50 },
		factory: () => ({
			render: (width: number) => {
				widths.push(width);
				return ["x"];
			},
			invalidate: () => {},
		}),
	});
	await flush();
	const [surface] = controller.snapshot();
	assertExists(surface);
	assertEquals(surface.cols, 159);
	assertEquals(surface.width, 50);
	assertEquals(widths.at(-1), 50);
	controller.disposeAll();
});

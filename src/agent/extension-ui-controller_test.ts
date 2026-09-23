import { test } from "bun:test";

import { assertEquals, assertExists } from "#testing/assertions";

import { piUiMarker } from "../extension-surface-types.ts";
import { AppStore } from "../state/app-store.ts";
import { ExtensionUiController } from "./extension-ui-controller.ts";
import { agentSessionRuntimeStub } from "./test-fixtures.ts";

/** A distinct, opaque per-runtime identity for `context()` in tests that don't exercise A#23's per-runtime distinction. */
function fakeRuntimeKey() {
	return agentSessionRuntimeStub({ session: {} });
}

test("extension UI resolves queued web dialogs in order", async () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	const selected = ui.select("Choose", ["one", "two"]);
	const confirmed = ui.confirm("Continue?", "This changes things.");
	assertEquals(store.extensionDialog?.kind, "select");
	const selectId = store.extensionDialog?.id ?? "";
	assertEquals(controller.respond(selectId, "two", false), true);
	assertEquals(await selected, "two");

	assertEquals(store.extensionDialog?.kind, "confirm");
	const confirmId = store.extensionDialog?.id ?? "";
	assertEquals(controller.respond(confirmId, "confirm", false), true);
	assertEquals(await confirmed, true);
	assertEquals(store.extensionDialog, undefined);
});

test("extension UI cancels dialogs on abort and inactive runtimes", async () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const abort = new AbortController();
	const ui = controller.context(() => true, fakeRuntimeKey());
	const input = ui.input("Input", "value", { signal: abort.signal });
	abort.abort();

	assertEquals(await input, undefined);
	assertEquals(store.extensionDialog, undefined);
	assertEquals(
		await controller.context(() => false, fakeRuntimeKey()).confirm("No", "No"),
		false,
	);
});

test("extension UI dialogs auto-dismiss as cancelled after their timeout option elapses", async () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	const confirmed = ui.confirm("Continue?", "Auto-dismisses", { timeout: 5 });
	assertEquals(store.extensionDialog?.kind, "confirm");

	assertEquals(await confirmed, false);
	assertEquals(store.extensionDialog, undefined);

	// The next dialog opens normally — the timed-out one didn't leave the
	// queue stuck.
	const nextSelect = ui.select("Pick", ["a", "b"]);
	assertEquals(store.extensionDialog?.kind, "select");
	const selectId = store.extensionDialog?.id ?? "";
	assertEquals(controller.respond(selectId, "a", false), true);
	assertEquals(await nextSelect, "a");
});

test("extension UI a queued (not yet active) dialog's timeout still cancels it once shown", async () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	// The first dialog stays active (no timeout) while the second, timed-out
	// one waits in the queue — its timer is already running even though it
	// isn't the visible dialog yet.
	const first = ui.confirm("First", "Blocks the queue");
	const second = ui.confirm("Second", "Times out", { timeout: 5 });
	assertEquals(store.extensionDialog?.title, "First");

	await new Promise((resolve) => setTimeout(resolve, 20));
	// Still queued behind `first`, unaffected by `second`'s elapsed timer.
	assertEquals(store.extensionDialog?.title, "First");

	const firstId = store.extensionDialog?.id ?? "";
	assertEquals(controller.respond(firstId, "confirm", false), true);
	assertEquals(await first, true);
	// `second` was already cancelled by its own timeout while queued, so it
	// never becomes the active dialog.
	assertEquals(await second, false);
	assertEquals(store.extensionDialog, undefined);
});

test("extension UI degrades TUI-only capabilities instead of throwing", async () => {
	const ui = new ExtensionUiController(new AppStore()).context(
		() => true,
		fakeRuntimeKey(),
	);

	// custom() mounts a real terminal surface and never throws into the
	// extension's command handler; it resolves once the component calls
	// `done()` (here, synchronously from the factory itself).
	assertEquals(
		await ui.custom((_tui, _theme, _keybindings, done) => {
			done(undefined as never);
			return { render: () => [] } as never;
		}),
		undefined,
	);

	// onTerminalInput registers and returns a working unsubscribe function.
	let seen: string | undefined;
	const unsubscribe = ui.onTerminalInput((data) => {
		seen = data;
		return undefined;
	});
	assertExists(unsubscribe);
	unsubscribe();
	assertEquals(seen, undefined);

	// setToolsExpanded/getToolsExpanded round-trip through controller-owned state.
	assertEquals(ui.getToolsExpanded(), false);
	ui.setToolsExpanded(true);
	assertEquals(ui.getToolsExpanded(), true);

	// addAutocompleteProvider/setEditorComponent/setFooter/setHeader/
	// setHiddenThinkingLabel are recorded, not thrown.
	ui.addAutocompleteProvider((current) => current);
	ui.setEditorComponent(() => ({ render: () => [] }) as never);
	assertExists(ui.getEditorComponent());
	ui.setFooter(() => ({ render: () => [] }) as never);
	ui.setHeader(() => ({ render: () => [] }) as never);
	ui.setHiddenThinkingLabel("Thinking hidden");

	// A component-factory setWidget() is recorded, never thrown, and clears any
	// prior string-line widget under the same key.
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const widgetUi = controller.context(() => true, fakeRuntimeKey());
	widgetUi.setWidget("panel", ["line"]);
	assertEquals(store.extensionWidgets.length, 1);
	widgetUi.setWidget("panel", () => ({ render: () => [] }) as never);
	assertEquals(store.extensionWidgets, []);

	// theme is a permissive proxy: styling calls return their text unstyled
	// instead of throwing, and setTheme() still reports the typed failure.
	assertEquals(ui.theme.fg("accent", "text"), "text");
	assertEquals(ui.theme.bold("text"), "text");
	assertEquals(ui.getAllThemes(), []);
	assertEquals(ui.getTheme("dark"), undefined);
	assertEquals(ui.setTheme("dark"), {
		success: false,
		error: "TUI themes are unavailable in pi-ui",
	});
});

test("extension UI projects status, widgets, working state, and editor text", () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	ui.setStatus("example", "ready");
	ui.setWidget("example", ["line one", "line two"], {
		placement: "belowEditor",
	});
	ui.setWorkingMessage("Indexing...");
	ui.setWorkingIndicator({ frames: ["●", "○"], intervalMs: 150 });
	ui.setEditorText("draft");
	ui.pasteToEditor(" text");
	ui.notify("Careful", "warning");

	const state = store.snapshot();
	assertEquals(state.extensionStatuses, [{ key: "example", text: "ready" }]);
	assertEquals(state.extensionWidgets, [
		{
			key: "example",
			lines: ["line one", "line two"],
			placement: "belowEditor",
		},
	]);
	assertEquals(state.extensionWorkingMessage, "Indexing...");
	assertEquals(state.extensionWorkingIndicator, {
		frames: ["●", "○"],
		intervalMs: 150,
	});
	assertEquals(ui.getEditorText(), "draft text");
	// The message text itself is exactly what the extension sent (no manual
	// "warning: " prefix) — severity is conveyed by `noticeTone` instead, so
	// each level gets its own status-dot color and prefix (r1-audit #24).
	assertEquals(state.messages.at(-1)?.text, "Careful");
	assertEquals(state.messages.at(-1)?.noticeTone, "warning");

	controller.cancelAll();
	assertEquals(store.extensionStatuses, []);
	assertEquals(store.extensionWidgets, []);
	assertEquals(store.extensionWorkingMessage, undefined);
});

test("extension UI intercepts PIUI bridge payloads instead of showing them as notices", () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	ui.notify(
		`${piUiMarker}${JSON.stringify({
			v: 1,
			op: "set",
			el: {
				id: "panel",
				ns: "advisor",
				kind: "panel",
				placement: "sheet",
				title: "Advisor",
			},
		})}`,
		"info",
	);

	let state = store.snapshot();
	assertEquals(state.messages, []);
	assertEquals(state.extensionElements.length, 1);
	assertEquals(state.extensionElements[0]?.title, "Advisor");

	// Garbage PIUI-prefixed payloads are dropped silently too, never surfaced.
	ui.notify(`${piUiMarker}not json`, "info");
	state = store.snapshot();
	assertEquals(state.messages, []);

	// A channel op updates extensionChannels without touching extensionElements.
	ui.notify(
		`${piUiMarker}${JSON.stringify({
			v: 1,
			op: "channel",
			channel: "subagents:fleet",
			payload: { jobs: [] },
		})}`,
		"info",
	);
	state = store.snapshot();
	assertEquals(state.extensionChannels.length, 1);
	assertEquals(state.extensionChannels[0]?.channel, "subagents:fleet");

	// A normal (non-PIUI) notify still reaches the transcript, tagged with its
	// own level (A#24) rather than silently unlabeled.
	ui.notify("Plain message", "info");
	state = store.snapshot();
	assertEquals(state.messages.at(-1)?.text, "Plain message");
	assertEquals(state.messages.at(-1)?.noticeTone, "info");

	controller.cancelAll();
	state = store.snapshot();
	assertEquals(state.extensionElements, []);
	assertEquals(state.extensionChannels, []);
});

test("extension UI notify levels are visually and textually distinct (A#24)", () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	ui.notify("all good", "info");
	ui.notify("careful now", "warning");
	ui.notify("it broke", "error");

	const messages = store.snapshot().messages;
	const [info, warning, error] = messages.slice(-3);
	// The text is exactly what the extension sent; the level travels as
	// `noticeTone`, which renderSystemMessage turns into a distinct status-dot
	// color and screen-reader prefix — never "Warning: info…".
	assertEquals(info?.text, "all good");
	assertEquals(warning?.text, "careful now");
	assertEquals(error?.text, "it broke");
	assertEquals(
		[info?.noticeTone, warning?.noticeTone, error?.noticeTone],
		["info", "warning", "error"],
	);
});

test("extension UI hands PIUI channel ops to the channel owner when one is configured", () => {
	const store = new AppStore();
	const received: Array<[string, unknown]> = [];
	const controller = new ExtensionUiController(store, {
		onChannel: (channel, payload) => received.push([channel, payload]),
	});
	const ui = controller.context(() => true, fakeRuntimeKey());

	ui.notify(
		`${piUiMarker}${JSON.stringify({
			v: 1,
			op: "channel",
			channel: "workflow:progress",
			payload: { active: true },
		})}`,
		"info",
	);

	assertEquals(received, [["workflow:progress", { active: true }]]);
	// The owner publishes channels; the controller must not write a second copy.
	assertEquals(store.snapshot().extensionChannels, []);
	assertEquals(store.snapshot().messages, []);
});

test("notify's info/warning/error levels are distinguished by noticeTone, not text", () => {
	const store = new AppStore();
	const ui = new ExtensionUiController(store).context(() => true, fakeRuntimeKey());

	ui.notify("An info message", "info");
	ui.notify("A warning message", "warning");
	ui.notify("An error message", "error");

	const [info, warning, error] = store.messages;
	assertEquals(info?.text, "An info message");
	assertEquals(info?.noticeTone, "info");
	assertEquals(warning?.text, "A warning message");
	assertEquals(warning?.noticeTone, "warning");
	assertEquals(error?.text, "An error message");
	assertEquals(error?.noticeTone, "error");
});

test("a background session's PIUI elements survive a round trip to the foreground", () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const runtimeKey = fakeRuntimeKey();
	const ui = controller.context(() => true, runtimeKey);

	ui.notify(
		`${piUiMarker}${JSON.stringify({
			v: 1,
			op: "set",
			el: {
				id: "panel",
				ns: "advisor",
				kind: "panel",
				placement: "sheet",
				title: "Advisor",
			},
		})}`,
		"info",
	);
	assertEquals(store.extensionElements.length, 1);

	// Backgrounding the session calls cancelAll() (see #23: this used to lose
	// the element for good).
	controller.cancelAll();
	assertEquals(store.extensionElements, []);

	// ...and the runtime's own store brings it back when the session returns to
	// the foreground, with no re-send from the extension.
	controller.restoreElements(runtimeKey);
	assertEquals(store.extensionElements.length, 1);
	assertEquals(store.extensionElements[0]?.title, "Advisor");

	// A runtime that never published anything restores to an empty set.
	controller.restoreElements(fakeRuntimeKey());
	assertEquals(store.extensionElements, []);
});

function staticComponent(lines: string[]) {
	return { render: () => lines, invalidate: () => {} };
}

test("custom() overlay wiring mounts a terminal surface, routes input, and resolves via done()", async () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	let seenInput: string | undefined;
	const resultPromise = ui.custom(
		(_tui, _theme, _keybindings, done) =>
			({
				render: () => ["picker"],
				handleInput: (data: string) => {
					seenInput = data;
					done("chosen" as never);
				},
				invalidate: () => {},
			}) as never,
		{ overlay: true },
	);
	// Let the internal await settle before the surface shows up in the store.
	await Promise.resolve();
	await Promise.resolve();

	const [surface] = store.snapshot().terminalSurfaces;
	assertExists(surface);
	assertEquals(surface.kind, "overlay");

	assertEquals(controller.handleTerminalSurfaceInput(surface.id, "\r"), true);
	assertEquals(seenInput, "\r");
	assertEquals(await resultPromise, "chosen");
	// done() disposes the surface: it disappears from the store.
	assertEquals(store.snapshot().terminalSurfaces, []);

	// An id nobody mounted routes to nothing, rather than throwing.
	assertEquals(controller.handleTerminalSurfaceInput("no-such-surface", "x"), false);
	assertEquals(controller.resizeTerminalSurface("no-such-surface", 80, 24), false);
});

test("setWidget/setFooter/setHeader component factories mount persistent terminal surfaces", () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	ui.setWidget("panel", () => staticComponent(["widget line"]) as never);
	let kinds = store.snapshot().terminalSurfaces.map((s) => s.kind);
	assertEquals(kinds, ["widget"]);

	ui.setFooter(() => staticComponent(["footer line"]) as never);
	ui.setHeader(() => staticComponent(["header line"]) as never);
	kinds = store
		.snapshot()
		.terminalSurfaces.map((s) => s.kind)
		.sort();
	assertEquals(kinds, ["footer", "header", "widget"]);

	// Clearing the footer/header (undefined factory) disposes their surfaces.
	ui.setFooter(undefined);
	ui.setHeader(undefined);
	kinds = store.snapshot().terminalSurfaces.map((s) => s.kind);
	assertEquals(kinds, ["widget"]);

	// cancelAll() (session switch/background) tears every terminal surface down.
	controller.cancelAll();
	assertEquals(store.snapshot().terminalSurfaces, []);
});

test("onTerminalInput listeners see terminal-surface input first and may rewrite or consume it", async () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());
	const received: string[] = [];
	const result = ui.custom(
		(_tui, _theme, _keybindings, done) =>
			({
				render: () => ["surface"],
				handleInput: (data: string) => {
					received.push(data);
					if (data === "q") done("closed" as never);
				},
				invalidate: () => {},
			}) as never,
		{ overlay: true },
	);
	await Promise.resolve();
	await Promise.resolve();
	const [surface] = store.snapshot().terminalSurfaces;
	assertExists(surface);

	const unsubscribe = ui.onTerminalInput((data) =>
		data === "x" ? { consume: true } : data === "y" ? { data: "q" } : undefined,
	);
	assertEquals(controller.handleTerminalSurfaceInput(surface.id, "a"), true);
	assertEquals(controller.handleTerminalSurfaceInput(surface.id, "x"), true);
	assertEquals(received, ["a"]);
	assertEquals(controller.handleTerminalSurfaceInput(surface.id, "y"), true);
	assertEquals(received, ["a", "q"]);
	assertEquals(await result, "closed");
	unsubscribe();
});

test("ExtensionUiController strips ANSI styling from extension notices", () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true, fakeRuntimeKey());

	ui.notify("\u001b[1mRTK\u001b[0m: \u001b[32mON\u001b[0m", "info");

	assertEquals(store.snapshot().messages.at(-1)?.text, "RTK: ON");
});

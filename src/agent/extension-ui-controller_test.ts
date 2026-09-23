import { test } from "bun:test";

import { assertEquals, assertExists } from "#testing/assertions";

import { piUiMarker } from "../extension-surface-types.ts";
import { AppStore } from "../state/app-store.ts";
import { ExtensionUiController } from "./extension-ui-controller.ts";

test("extension UI resolves queued web dialogs in order", async () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true);

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
	const ui = controller.context(() => true);
	const input = ui.input("Input", "value", { signal: abort.signal });
	abort.abort();

	assertEquals(await input, undefined);
	assertEquals(store.extensionDialog, undefined);
	assertEquals(await controller.context(() => false).confirm("No", "No"), false);
});

test("extension UI degrades TUI-only capabilities instead of throwing", async () => {
	const ui = new ExtensionUiController(new AppStore()).context(() => true);

	// custom() matches the SDK's real RPC-mode contract: resolves undefined,
	// it must never throw into the extension's command handler.
	assertEquals(await ui.custom(() => ({ render: () => [] }) as never), undefined);

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
	const widgetUi = controller.context(() => true);
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
	const ui = controller.context(() => true);

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
	assertEquals(state.messages.at(-1)?.text, "warning: Careful");

	controller.cancelAll();
	assertEquals(store.extensionStatuses, []);
	assertEquals(store.extensionWidgets, []);
	assertEquals(store.extensionWorkingMessage, undefined);
});

test("extension UI intercepts PIUI bridge payloads instead of showing them as notices", () => {
	const store = new AppStore();
	const controller = new ExtensionUiController(store);
	const ui = controller.context(() => true);

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

	// A normal (non-PIUI) notify still reaches the transcript as before.
	ui.notify("Plain message", "info");
	state = store.snapshot();
	assertEquals(state.messages.at(-1)?.text, "Plain message");

	controller.cancelAll();
	state = store.snapshot();
	assertEquals(state.extensionElements, []);
	assertEquals(state.extensionChannels, []);
});

test("extension UI hands PIUI channel ops to the channel owner when one is configured", () => {
	const store = new AppStore();
	const received: Array<[string, unknown]> = [];
	const controller = new ExtensionUiController(store, {
		onChannel: (channel, payload) => received.push([channel, payload]),
	});
	const ui = controller.context(() => true);

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

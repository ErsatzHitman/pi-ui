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
	assertEquals(state.messages.at(-1)?.text, "Warning: Careful");

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

	// A normal (non-PIUI) notify still reaches the transcript, now labeled
	// with its own level (A#24) rather than silently unlabeled.
	ui.notify("Plain message", "info");
	state = store.snapshot();
	assertEquals(state.messages.at(-1)?.text, "Info: Plain message");

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
	assertEquals(info?.text, "Info: all good");
	assertEquals(warning?.text, "Warning: careful now");
	// Distinct labels — never "Warning: info…"/"Warning: warning: …" (the
	// generic sr-only prefix `renderSystemMessage` used to add unconditionally).
	assertEquals(info?.text === warning?.text, false);
	// error gets its own rendering path entirely, not just its own prefix.
	assertEquals(error?.text, "it broke");
	assertEquals(error?.state, "error");
	assertEquals(info?.state, undefined);
	assertEquals(warning?.state, undefined);
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

import { test } from "bun:test";

import { assert, assertEquals } from "#testing/assertions";

import type { DatastarClientHub } from "../server/datastar-client-hub.ts";
import { AppStore } from "../state/app-store.ts";
import { UiRenderer } from "./ui-renderer.ts";

type HubCall =
	| { kind: "patchView"; elements: string; signals: string; scripts: readonly string[] }
	| {
			kind: "patchElement";
			elements: string;
			selector: string;
			mode: string;
			scripts: readonly string[];
	  }
	| { kind: "replaceElement"; elements: string; selector: string };

/** Records every hub call, in order, for one connected client. */
class RecordingHub {
	readonly calls: HubCall[] = [];
	readonly clientCount = 1;
	patchView(elements: string, signals: string, scripts: readonly string[]): void {
		this.calls.push({ kind: "patchView", elements, signals, scripts });
	}
	patchElement(
		elements: string,
		selector: string,
		options: { mode?: string; scripts?: readonly string[] } = {},
	): void {
		this.calls.push({
			kind: "patchElement",
			elements,
			selector,
			mode: options.mode ?? "outer",
			scripts: options.scripts ?? [],
		});
	}
	replaceElement(elements: string, selector: string): void {
		this.calls.push({ kind: "replaceElement", elements, selector });
	}
	take(): HubCall[] {
		return this.calls.splice(0);
	}
}

function setup() {
	const store = new AppStore();
	const hub = new RecordingHub();
	const renderer = new UiRenderer(store, hub as unknown as DatastarClientHub);
	return { store, hub, renderer };
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

const quietHoldScript = "window.piUi.messageScroll.quietTranscript({ hold: true })";

function dataEnterCount(html: string): number {
	return html.split("data-enter").length - 1;
}

function pendingAppends(calls: readonly HubCall[]): number {
	return calls.filter(
		(call) =>
			call.kind === "patchElement" && call.elements.includes("message-pending"),
	).length;
}

function retireScripts(calls: readonly HubCall[]): number {
	return calls
		.flatMap((call) => (call.kind === "replaceElement" ? [] : call.scripts))
		.filter((script) => script.includes("retirePending")).length;
}

test("the first message patches #messages with exactly one data-enter", async () => {
	const { store, hub } = setup();
	store.appendMessage("user", "hello");
	await settle();
	const first = hub
		.take()
		.find((call) => call.kind === "patchElement" && call.selector === "#messages");
	assert(first?.kind === "patchElement", "#messages patched");
	assertEquals(dataEnterCount(first.elements), 1);
	assert(first.elements.includes("<article data-enter"), "the article is marked");
});

test("a live-appended message carries data-enter", async () => {
	const { store, hub } = setup();
	store.appendMessage("user", "hello");
	await settle();
	hub.take();
	store.appendMessage("notice", "heads up");
	await settle();
	const append = hub
		.take()
		.find(
			(call) => call.kind === "patchElement" && call.selector === "#message-list",
		);
	assert(append?.kind === "patchElement", "appended to #message-list");
	assertEquals(append.mode, "append");
	assert(append.elements.startsWith("<article data-enter"), "the append is marked");
});

test("a session replace sends signals, then #messages marked data-enter, then scripts", async () => {
	const { store, hub, renderer } = setup();
	store.appendMessage("user", "hello");
	await settle();
	hub.take();
	renderer.transcriptReplacing();
	renderer.requestCommit();
	await settle();
	const calls = hub.take();
	const replaceIndex = calls.findIndex((call) => call.kind === "replaceElement");
	assert(replaceIndex > 0, "a replace after the signals");
	const signals = calls[replaceIndex - 1];
	assert(signals?.kind === "patchView", "signals patch first");
	assertEquals(signals.elements, "");
	assert(signals.signals !== "{}", "carries the real signals");
	// No quiet script: the incoming node's own data-enter gates its nested entries.
	assertEquals(signals.scripts, []);
	const replace = calls[replaceIndex];
	assert(replace?.kind === "replaceElement", "replace");
	assertEquals(replace.selector, "#messages");
	assert(replace.elements.startsWith('<main id="messages" data-enter'), "marked");
	const scripts = calls[replaceIndex + 1];
	assert(scripts?.kind === "patchView", "scripts patch last");
	assertEquals(scripts.elements, "");
	assertEquals(scripts.signals, "{}");
});

test("a code-theme replace re-renders #messages without any entry marker", async () => {
	const { store, hub, renderer } = setup();
	store.appendMessage("user", "hello");
	store.appendMessage("assistant", "hi");
	await settle();
	hub.take();
	renderer.codeThemeChanged();
	await settle();
	const replace = hub.take().find((call) => call.kind === "replaceElement");
	assert(replace?.kind === "replaceElement", "replaced");
	assertEquals(dataEnterCount(replace.elements), 0);
});

test("without a replace, the commit keeps one combined patchView", async () => {
	const { store, hub } = setup();
	store.setActivityText("Working...");
	await settle();
	const views = hub.take().filter((call) => call.kind === "patchView");
	assert(views.length >= 1, "a commit patch");
	assert(views[0]?.kind === "patchView" && views[0].elements !== "", "with elements");
});

test("the pending row shows while a running turn waits, and a response retires it", async () => {
	const { store, hub } = setup();
	store.setActivityText("Working...");
	store.appendMessage("user", "hello");
	await settle();
	const shown = hub
		.take()
		.filter(
			(call) =>
				call.kind === "patchElement" && call.elements.includes("message-pending"),
		);
	assertEquals(shown.length, 1);
	const row = shown[0];
	assert(row?.kind === "patchElement", "a pending patch");
	// Beside the list, never inside it (trimming counts the list's children).
	assertEquals([row.selector, row.mode], ["#message-list", "after"]);
	store.appendThoughtDelta("hmm");
	await settle();
	const calls = hub.take();
	assertEquals(retireScripts(calls), 1);
	const thought = calls.find(
		(call) =>
			call.kind === "patchElement" &&
			call.scripts.some((s) => s.includes("retire")),
	);
	assert(thought?.kind === "patchElement", "retired by the thought's own patch");
	assert(thought.elements.startsWith("<article data-enter"), "the thought enters");
	assertEquals(pendingAppends(calls), 0);
});

test("the pending row waits for the turn to run, and never outlives an abort", async () => {
	const { store, hub } = setup();
	store.appendMessage("user", "hello");
	await settle();
	assertEquals(pendingAppends(hub.take()), 0);
	store.setActivityText("Working...");
	await settle();
	assertEquals(pendingAppends(hub.take()), 1);
	store.setActivityText(undefined);
	await settle();
	const calls = hub.take();
	assertEquals(retireScripts(calls), 1);
	assertEquals(pendingAppends(calls), 0);
	store.setActivityText("Working...");
	await settle();
	assertEquals(pendingAppends(hub.take()), 0);
});

test("an error message retires the pending row", async () => {
	const { store, hub } = setup();
	store.setActivityText("Working...");
	store.appendMessage("user", "hello");
	await settle();
	hub.take();
	store.appendMessage("system", "provider failed");
	await settle();
	assertEquals(retireScripts(hub.take()), 1);
});

test("history renders and session replaces never include the pending row", async () => {
	const { store, hub, renderer } = setup();
	store.setActivityText("Working...");
	store.appendMessage("user", "hello");
	await settle();
	hub.take();
	renderer.transcriptReplacing();
	renderer.requestCommit();
	await settle();
	const calls = hub.take();
	assertEquals(pendingAppends(calls), 0);
	const replace = calls.find((call) => call.kind === "replaceElement");
	assert(
		replace?.kind === "replaceElement" &&
			!replace.elements.includes("message-pending"),
		"the replaced transcript has no pending row",
	);
	assert(
		!renderer
			.renderElements(renderer.projectState(store.snapshot()))
			.includes("message-pending"),
		"a full view has no pending row",
	);
});

test("a code-theme replace is quieted first and keeps the transcript unmarked", async () => {
	const { store, hub, renderer } = setup();
	store.appendMessage("user", "hello");
	store.appendMessage("assistant", "hi");
	await settle();
	hub.take();
	renderer.codeThemeChanged();
	await settle();
	const calls = hub.take();
	const replaceIndex = calls.findIndex((call) => call.kind === "replaceElement");
	const before = calls[replaceIndex - 1];
	assert(before?.kind === "patchView", "a patch before the replace");
	assertEquals(before.scripts, [quietHoldScript]);
});

test("a code-theme replace during the wait keeps the pending row, with no blink or re-entry", async () => {
	const { store, hub, renderer } = setup();
	store.setActivityText("Working...");
	store.appendMessage("user", "hello");
	await settle();
	assertEquals(pendingAppends(hub.take()), 1);
	renderer.codeThemeChanged();
	await settle();
	const calls = hub.take();
	const replace = calls.find((call) => call.kind === "replaceElement");
	assert(replace?.kind === "replaceElement", "replaced");
	assert(replace.elements.includes('id="message-pending"'), "the row is kept in place");
	assertEquals(dataEnterCount(replace.elements), 0);
	assertEquals(pendingAppends(calls), 0);
	assertEquals(retireScripts(calls), 0);
	// It still retires normally on the first response.
	store.appendThoughtDelta("hmm");
	await settle();
	assertEquals(retireScripts(hub.take()), 1);
});

test("a reconnect's full view keeps a showing pending row, never after the turn ends", async () => {
	const { store, hub, renderer } = setup();
	store.setActivityText("Working...");
	store.appendMessage("user", "hello");
	await settle();
	hub.take();
	const view = () => renderer.renderElements(renderer.projectState(store.snapshot()));
	assert(view().includes('id="message-pending"'), "a reconnect keeps the row");
	assertEquals(
		dataEnterCount(view().slice(view().indexOf('id="message-pending"') - 20)),
		0,
	);
	store.setActivityText(undefined);
	await settle();
	assert(!view().includes("message-pending"), "an ended turn drops it");
});

test("a session replace keeps data-enter on follow-up morphs until the session has loaded", async () => {
	const { store, hub, renderer } = setup();
	store.setSessionTransition({
		status: "loading",
		generation: 1,
		targetPath: "/tmp/new.jsonl",
		overlay: false,
	});
	hub.take();
	renderer.transcriptReplacing();
	renderer.requestCommit();
	await settle();
	const replace = hub.take().find((call) => call.kind === "replaceElement");
	assert(replace?.kind === "replaceElement", "replaced");
	assertEquals(dataEnterCount(replace.elements), 1);
	assert(
		!replace.elements.includes("data-class:messages-loading"),
		"never born with the loading dim",
	);
	const transcriptMorph = () =>
		hub
			.take()
			.find(
				(call) =>
					call.kind === "patchView" && call.elements.includes('id="messages"'),
			);
	store.setSessionCatalog([]);
	await settle();
	const loading = transcriptMorph();
	assert(loading?.kind === "patchView", "a sessions morph while loading");
	assertEquals(dataEnterCount(loading.elements), 1);
	store.setSessionTransition({ status: "idle", generation: 1 });
	store.setSessionCatalog([]);
	await settle();
	const loaded = transcriptMorph();
	assert(loaded?.kind === "patchView", "a sessions morph once loaded");
	assert(!loaded.elements.includes("data-enter"), "the marker is released");
	assert(
		loaded.elements.includes("data-class:messages-loading"),
		"the dim is bound again",
	);
});

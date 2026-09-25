import { test } from "bun:test";
import { mkdir } from "node:fs/promises";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import type {
	Extension,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionShortcut,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

import { assertEquals, assertExists } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { resolveExtensionRef } from "./identity.ts";
import {
	identifyMessageOwner,
	identifyToolOwner,
	instrumentExtensions,
	type InstrumentationReporter,
	type InstrumentedScope,
	type ScopeOutcomeRaw,
} from "./instrument.ts";
import type { UiSignal } from "./ledger.ts";

/**
 * Loaded through the real SDK loader (`discoverAndLoadExtensions`), exactly
 * as `terminal-surface-e2e_test.ts` and `extension-ui-compatibility_test.ts`
 * load their fixtures, so this test pins the transparency contract (F9/F10/F11)
 * against genuine `Extension` objects rather than hand-built stand-ins — see
 * `DESIGN-ext-activity.md` §5.2.
 */
const fixtureSource = `
export default function (pi) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.prompt === "boom") {
			throw new Error("boom-from-handler");
		}
		ctx.ui.setStatus("probe-status", "working:" + event.prompt);
		return { systemPrompt: "handled:" + event.prompt };
	});

	pi.on("message_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage("carrier-tick");
	});

	pi.registerTool({
		name: "probe_tool",
		label: "Probe",
		description: "Echoes call identity for the instrumentation contract test",
		parameters: { type: "object", properties: {} },
		execute: async (toolCallId, _params, signal, onUpdate, ctx) => {
			ctx.ui.setWorkingMessage("tool-working");
			return {
				content: [{ type: "text", text: "ok" }],
				details: { toolCallId, signal, onUpdate },
			};
		},
	});

	pi.registerCommand("probe-cmd", {
		description: "Probe command",
		handler: async (args, ctx) => {
			ctx.ui.notify("cmd:" + args, "info");
		},
	});

	pi.registerShortcut("ctrl+p", {
		description: "Probe shortcut",
		handler: async (ctx) => {
			ctx.ui.setStatus("shortcut-status", "fired");
		},
	});
}
`;

type RecordedScope = Readonly<{ event: "start"; scope: InstrumentedScope; now: number }>;
type RecordedEnd = Readonly<{
	event: "end";
	scope: InstrumentedScope;
	now: number;
	outcome: ScopeOutcomeRaw;
}>;
type RecordedSignal = Readonly<{
	event: "signal";
	scope: InstrumentedScope;
	signal: UiSignal;
	now: number;
}>;
type Recorded = RecordedScope | RecordedEnd | RecordedSignal;

type RecordingReporter = Readonly<{
	reporter: InstrumentationReporter;
	log: Recorded[];
}>;

function recordingReporter(): RecordingReporter {
	const log: Recorded[] = [];
	return {
		log,
		reporter: {
			scopeStart(scope, now) {
				log.push({ event: "start", scope, now });
			},
			scopeEnd(scope, now, outcome) {
				log.push({ event: "end", scope, now, outcome });
			},
			uiSignal(scope, signal, now) {
				log.push({ event: "signal", scope, signal, now });
			},
		},
	};
}

async function loadFixture(): Promise<{ extension: Extension; cleanup: () => void }> {
	const root = await makeTempDir({ prefix: "instrument-test-" });
	const agentDir = `${root}/agent`;
	const cwd = `${root}/workspace`;
	await mkdir(`${agentDir}/extensions`, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await Bun.write(`${agentDir}/extensions/probe.js`, fixtureSource);
	const result = await discoverAndLoadExtensions([], cwd, agentDir);
	assertEquals(result.errors, []);
	assertEquals(result.extensions.length, 1);
	const extension = result.extensions[0];
	assertExists(extension);
	return { extension, cleanup: () => {} };
}

function fakeCtx(): ExtensionContext {
	const calls: unknown[] = [];
	const ui = {
		setStatus(key: string, text: string | undefined) {
			calls.push({ setStatus: [key, text] });
		},
		setWorkingMessage(message?: string) {
			calls.push({ setWorkingMessage: message });
		},
		notify(message: string, type?: string) {
			calls.push({ notify: [message, type] });
		},
	};
	return { ui, mode: "print", hasUI: false } as unknown as ExtensionContext;
}

test("a timed hook's return value and reported scope survive instrumentation unchanged", async () => {
	const { extension } = await loadFixture();
	const { reporter, log } = recordingReporter();
	let tick = 0;
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => (tick += 1));

	const handlers = extension.handlers.get("before_agent_start")?.slice() ?? [];
	assertEquals(handlers.length, 1);
	const handler = handlers[0];
	assertExists(handler);

	const ctx = fakeCtx();
	const result = await handler({ type: "before_agent_start", prompt: "hi" }, ctx);
	assertEquals(result, { systemPrompt: "handled:hi" });

	const starts = log.filter((entry) => entry.event === "start");
	const ends = log.filter((entry) => entry.event === "end");
	const signals = log.filter((entry) => entry.event === "signal");
	assertEquals(starts.length, 1);
	assertEquals(ends.length, 1);
	assertEquals(signals.length, 1);

	const start = starts[0];
	assertExists(start);
	assertEquals(start.scope.timed, true);
	assertEquals(start.scope.extension.id, "probe");
	assertEquals(start.scope.extension.label, "Probe");
	assertEquals(start.scope.trigger, { kind: "hook", event: "before_agent_start" });

	const end = ends[0];
	assertExists(end);
	assertEquals(end.scope.scopeId, start.scope.scopeId);
	assertEquals(end.outcome, { ok: true, result: { systemPrompt: "handled:hi" } });

	const signal = signals[0];
	assertExists(signal);
	assertEquals(signal.signal, {
		kind: "status",
		key: "probe-status",
		text: "working:hi",
	});
});

test("a thrown handler error propagates unchanged and is reported as a failed scope", async () => {
	const { extension } = await loadFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);

	const handler = extension.handlers.get("before_agent_start")?.slice()[0];
	assertExists(handler);

	let caught: unknown;
	try {
		await handler({ type: "before_agent_start", prompt: "boom" }, fakeCtx());
	} catch (error) {
		caught = error;
	}
	assertExists(caught);
	assertEquals(caught instanceof Error, true);
	assertEquals((caught as Error).message, "boom-from-handler");

	const end = log.find((entry) => entry.event === "end");
	assertExists(end);
	if (end?.event !== "end") throw new Error("expected an end entry");
	assertEquals(end.outcome.ok, false);
	if (end.outcome.ok) throw new Error("expected a failed outcome");
	assertEquals(end.outcome.error, caught);
});

test("a carrier (non-timed) hook reuses the same scope id across dispatches", async () => {
	const { extension } = await loadFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);

	const handler = extension.handlers.get("message_start")?.slice()[0];
	assertExists(handler);
	await handler({ type: "message_start" }, fakeCtx());
	await handler({ type: "message_start" }, fakeCtx());

	const starts = log.filter((entry) => entry.event === "start");
	assertEquals(starts.length, 2);
	const first = starts[0];
	const second = starts[1];
	assertExists(first);
	assertExists(second);
	assertEquals(first.scope.timed, false);
	assertEquals(first.scope.scopeId, second.scope.scopeId);
});

test("a tool's execute forwards signal/onUpdate identity and reports a tool-scoped activity", async () => {
	const { extension } = await loadFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);

	const registered = extension.tools.get("probe_tool");
	assertExists(registered);
	const controller = new AbortController();
	const onUpdate = () => {};
	const result = await registered.definition.execute(
		"call-1",
		{},
		controller.signal,
		onUpdate,
		fakeCtx(),
	);

	const details = result.details as {
		toolCallId: string;
		signal: unknown;
		onUpdate: unknown;
	};
	assertEquals(details.toolCallId, "call-1");
	assertEquals(details.signal, controller.signal);
	assertEquals(details.onUpdate, onUpdate);

	const start = log.find((entry) => entry.event === "start");
	assertExists(start);
	if (start?.event !== "start") throw new Error("expected a start entry");
	assertEquals(start.scope.trigger, {
		kind: "tool",
		toolName: "probe_tool",
		toolCallId: "call-1",
	});

	const signal = log.find((entry) => entry.event === "signal");
	assertExists(signal);
	if (signal?.event !== "signal") throw new Error("expected a signal entry");
	assertEquals(signal.signal, { kind: "workingMessage", text: "tool-working" });
});

test("a command handler is wrapped and its ctx.ui calls are attributed", async () => {
	const { extension } = await loadFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);

	const command = extension.commands.get("probe-cmd");
	assertExists(command);
	const handler: RegisteredCommand["handler"] = command.handler;
	await handler("myargs", fakeCtx() as unknown as ExtensionCommandContext);

	const start = log.find((entry) => entry.event === "start");
	assertExists(start);
	if (start?.event !== "start") throw new Error("expected a start entry");
	assertEquals(start.scope.trigger, { kind: "command", name: "probe-cmd" });

	const signal = log.find((entry) => entry.event === "signal");
	assertExists(signal);
	if (signal?.event !== "signal") throw new Error("expected a signal entry");
	assertEquals(signal.signal, { kind: "notify", text: "cmd:myargs", type: "info" });
});

test("a shortcut handler is wrapped and its ctx.ui calls are attributed", async () => {
	const { extension } = await loadFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);

	const shortcut = extension.shortcuts.get("ctrl+p");
	assertExists(shortcut);
	const handler: ExtensionShortcut["handler"] = shortcut.handler;
	await handler(fakeCtx());

	const start = log.find((entry) => entry.event === "start");
	assertExists(start);
	if (start?.event !== "start") throw new Error("expected a start entry");
	assertEquals(start.scope.trigger, { kind: "shortcut", key: "ctrl+p" });

	const signal = log.find((entry) => entry.event === "signal");
	assertExists(signal);
	if (signal?.event !== "signal") throw new Error("expected a signal entry");
	assertEquals(signal.signal, {
		kind: "status",
		key: "shortcut-status",
		text: "fired",
	});
});

test("instrumenting the same Extension object twice is a no-op (idempotent per Extension)", async () => {
	const { extension } = await loadFixture();
	const { reporter: firstReporter, log: firstLog } = recordingReporter();
	const { reporter: secondReporter, log: secondLog } = recordingReporter();
	instrumentExtensions([extension], firstReporter, resolveExtensionRef, () => 0);
	instrumentExtensions([extension], secondReporter, resolveExtensionRef, () => 0);

	const handler = extension.handlers.get("before_agent_start")?.slice()[0];
	assertExists(handler);
	await handler({ type: "before_agent_start", prompt: "again" }, fakeCtx());

	assertEquals(firstLog.length > 0, true);
	assertEquals(secondLog.length, 0);
});

test("a hidden extension is never instrumented", async () => {
	const { extension } = await loadFixture();
	extension.hidden = true;
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);

	const handler = extension.handlers.get("before_agent_start")?.slice()[0];
	assertExists(handler);
	const result = await handler({ type: "before_agent_start", prompt: "hi" }, fakeCtx());
	assertEquals(result, { systemPrompt: "handled:hi" });
	assertEquals(log.length, 0);
});

test("identifyMessageOwner matches a custom message type to its extension's slug", async () => {
	const { extension } = await loadFixture();
	const owner = identifyMessageOwner([extension], "probe-panel", resolveExtensionRef);
	assertExists(owner);
	assertEquals(owner?.id, "probe");
	assertEquals(
		identifyMessageOwner([extension], "unrelated-thing", resolveExtensionRef),
		undefined,
	);
});

test("identifyToolOwner resolves an extension-registered tool and ignores built-ins and hidden extensions", async () => {
	const { extension } = await loadFixture();
	assertEquals(
		identifyToolOwner([extension], "probe_tool", resolveExtensionRef)?.id,
		"probe",
	);
	assertEquals(identifyToolOwner([extension], "read", resolveExtensionRef), undefined);
	const hidden = { ...extension, hidden: true };
	assertEquals(
		identifyToolOwner([hidden], "probe_tool", resolveExtensionRef),
		undefined,
	);
});

/** Transparency edge cases: `this`-binding, extra arguments, a missing ctx, a
 * tool definition shared by two runtimes, and late (post-instrumentation)
 * registration — see `DESIGN-ext-activity.md` §2.2. */
const edgeFixtureSource = `
const sharedTool = {
	name: "shared_tool",
	label: "Shared",
	description: "A module-level definition object, reused by every factory call",
	parameters: { type: "object", properties: {} },
	marker: "definition-this",
	async execute(toolCallId, _params, _signal, _onUpdate, ctx, ...extra) {
		ctx?.ui?.setWidget?.("edge-panel", () => ({ render: () => ["x"], invalidate() {} }));
		return {
			content: [{ type: "text", text: String(this.marker) }],
			details: { extra, ctxType: typeof ctx },
		};
	},
};

export default function (pi) {
	pi.registerTool(sharedTool);
	pi.registerCommand("edge-cmd", {
		description: "Edge command",
		marker: "command-this",
		handler: async function (_args, ctx) {
			ctx.ui.notify("plain notice");
			return this.marker;
		},
	});
	pi.on("session_start", async () => {
		pi.registerTool({
			name: "late_tool",
			label: "Late",
			description: "Registered from session_start, after instrumentation",
			parameters: { type: "object", properties: {} },
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				ctx.ui.setStatus("late-status", "on");
				return { content: [{ type: "text", text: "late" }], details: {} };
			},
		});
	});
}
`;

async function loadEdgeFixture(): Promise<Extension> {
	const root = await makeTempDir({ prefix: "instrument-edge-test-" });
	const agentDir = `${root}/agent`;
	const cwd = `${root}/workspace`;
	await mkdir(`${agentDir}/extensions`, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await Bun.write(`${agentDir}/extensions/edge.js`, edgeFixtureSource);
	const result = await discoverAndLoadExtensions([], cwd, agentDir);
	assertEquals(result.errors, []);
	const extension = result.extensions[0];
	assertExists(extension);
	return extension;
}

/** A distinct, opaque `ExtensionContext["sessionManager"]` stand-in for
 * `instrumentExtensions`'s `sessionKey` — only ever compared by reference, so
 * a real `ReadonlySessionManager`'s shape is irrelevant here. */
function fakeSessionManager(id: string): ExtensionContext["sessionManager"] {
	// SAFETY: `sessionKey`/`ctx.sessionManager` are only ever compared by
	// reference (`Map` key identity) in `instrument.ts`, never called into —
	// a tagged opaque object is a faithful, distinct stand-in.
	return { id } as unknown as ExtensionContext["sessionManager"];
}

function recordingUiCtx(calls: unknown[]): ExtensionContext {
	const ui = {
		notify(...args: unknown[]) {
			calls.push({ notify: args });
		},
		setWidget(...args: unknown[]) {
			calls.push({ setWidget: args });
		},
		setStatus(...args: unknown[]) {
			calls.push({ setStatus: args });
		},
	};
	return { ui, mode: "tui", hasUI: true } as unknown as ExtensionContext;
}

test("a tool's execute keeps its definition as `this`, forwards extra arguments, and tolerates a missing ctx", async () => {
	const extension = await loadEdgeFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);
	const definition = extension.tools.get("shared_tool")?.definition;
	assertExists(definition);
	const execute = definition.execute as (...args: unknown[]) => Promise<{
		content: { text: string }[];
		details: { extra: unknown[]; ctxType: string };
	}>;

	// Called exactly as `wrapToolDefinition` calls it: as a method of the definition.
	const withCtx = await execute.call(
		definition,
		"call-1",
		{},
		undefined,
		undefined,
		recordingUiCtx([]),
		"extra-1",
		"extra-2",
	);
	assertEquals(withCtx.content[0]?.text, "definition-this");
	assertEquals(withCtx.details.extra, ["extra-1", "extra-2"]);

	const withoutCtx = await execute.call(definition, "call-2", {}, undefined, undefined);
	assertEquals(withoutCtx.details.ctxType, "undefined");
	assertEquals(
		log
			.filter((entry) => entry.event === "end")
			.map((entry) => entry.scope.toolCallId),
		["call-1", "call-2"],
	);
});

test("a factory setWidget is reported as a widget mount with the real call forwarded untouched", async () => {
	const extension = await loadEdgeFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);
	const definition = extension.tools.get("shared_tool")?.definition;
	assertExists(definition);
	const calls: unknown[] = [];
	await definition.execute("call-1", {}, undefined, undefined, recordingUiCtx(calls));
	const signal = log.find((entry) => entry.event === "signal");
	if (signal?.event !== "signal") throw new Error("expected a signal entry");
	assertEquals(signal.signal, { kind: "widgetMount", key: "edge-panel" });
	assertEquals(calls.length, 1);
});

test("a command handler keeps its `this`, its return value, and the exact ui arguments it passed", async () => {
	const extension = await loadEdgeFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);
	const command = extension.commands.get("edge-cmd");
	assertExists(command);
	const calls: unknown[] = [];
	const handler = command.handler as (...args: unknown[]) => Promise<unknown>;
	const result = await handler.call(command, "", recordingUiCtx(calls));
	assertEquals(result, "command-this");
	// `notify(message)` reaches the real UI with no invented `type` argument…
	assertEquals(calls, [{ notify: ["plain notice"] }]);
	// …while the activity still records it as the "info" it defaults to.
	const signal = log.find((entry) => entry.event === "signal");
	if (signal?.event !== "signal") throw new Error("expected a signal entry");
	assertEquals(signal.signal, { kind: "notify", text: "plain notice", type: "info" });
});

test("a tool registered after instrumentation (e.g. from session_start) is instrumented too", async () => {
	const extension = await loadEdgeFixture();
	const { reporter, log } = recordingReporter();
	instrumentExtensions([extension], reporter, resolveExtensionRef, () => 0);
	const sessionStart = extension.handlers.get("session_start")?.slice()[0];
	assertExists(sessionStart);
	await sessionStart({ type: "session_start" }, recordingUiCtx([]));
	const late = extension.tools.get("late_tool");
	assertExists(late);
	await late.definition.execute("late-1", {}, undefined, undefined, recordingUiCtx([]));
	const toolStart = log.find(
		(entry) => entry.event === "start" && entry.scope.trigger.kind === "tool",
	);
	assertExists(toolStart);
	assertEquals(toolStart.scope.toolCallId, "late-1");
});

test("a tool definition shared by two instrumented runtimes is wrapped once, never twice", async () => {
	const extension = await loadEdgeFixture();
	const { reporter: firstReporter, log: firstLog } = recordingReporter();
	const { reporter: secondReporter, log: secondLog } = recordingReporter();
	instrumentExtensions([extension], firstReporter, resolveExtensionRef, () => 0);
	// A second runtime's `Extension` object whose factory registered the same
	// module-level definition (the SDK's factory cache makes this possible).
	const secondRuntimeExtension: Extension = {
		...extension,
		handlers: new Map(),
		tools: new Map(extension.tools),
		commands: new Map(),
		shortcuts: new Map(),
	};
	instrumentExtensions(
		[secondRuntimeExtension],
		secondReporter,
		resolveExtensionRef,
		() => 0,
	);
	const definition = secondRuntimeExtension.tools.get("shared_tool")?.definition;
	assertExists(definition);
	const result = await definition.execute(
		"call-1",
		{},
		undefined,
		undefined,
		recordingUiCtx([]),
	);
	assertEquals(result.content[0], { type: "text", text: "definition-this" });
	const starts = [...firstLog, ...secondLog].filter((entry) => entry.event === "start");
	assertEquals(starts.length, 1);
});

test("a tool definition shared by two runtimes attributes each call to whichever runtime's own ctx.sessionManager actually invoked it, not whichever instrumented it last", async () => {
	const extension = await loadEdgeFixture();
	const { reporter: firstReporter, log: firstLog } = recordingReporter();
	const { reporter: secondReporter, log: secondLog } = recordingReporter();
	const firstSessionManager = fakeSessionManager("first");
	const secondSessionManager = fakeSessionManager("second");
	instrumentExtensions(
		[extension],
		firstReporter,
		resolveExtensionRef,
		() => 0,
		firstSessionManager,
	);
	// A second runtime's `Extension` object whose factory registered the same
	// module-level definition (the SDK's factory cache makes this possible),
	// instrumented *after* the first — the scenario that used to make every
	// future call, from either runtime, report to this second one.
	const secondRuntimeExtension: Extension = {
		...extension,
		handlers: new Map(),
		tools: new Map(extension.tools),
		commands: new Map(),
		shortcuts: new Map(),
	};
	instrumentExtensions(
		[secondRuntimeExtension],
		secondReporter,
		resolveExtensionRef,
		() => 0,
		secondSessionManager,
	);
	const definition = secondRuntimeExtension.tools.get("shared_tool")?.definition;
	assertExists(definition);

	const ctxFor = (
		sessionManager: ExtensionContext["sessionManager"],
	): ExtensionContext =>
		({ ...recordingUiCtx([]), sessionManager }) as ExtensionContext;

	// The FIRST runtime's own call, made through its own ctx, must still
	// report to the first runtime's own reporter even though the second
	// runtime instrumented this shared definition more recently.
	await definition.execute(
		"call-1",
		{},
		undefined,
		undefined,
		ctxFor(firstSessionManager),
	);
	await definition.execute(
		"call-2",
		{},
		undefined,
		undefined,
		ctxFor(secondSessionManager),
	);

	assertEquals(
		firstLog
			.filter((entry) => entry.event === "start")
			.map((entry) => entry.scope.toolCallId),
		["call-1"],
	);
	assertEquals(
		secondLog
			.filter((entry) => entry.event === "start")
			.map((entry) => entry.scope.toolCallId),
		["call-2"],
	);
});

test("a shared tool definition's call with an unrecognized ctx.sessionManager falls back to whichever runtime instrumented it most recently, instead of throwing", async () => {
	const extension = await loadEdgeFixture();
	const { reporter: firstReporter, log: firstLog } = recordingReporter();
	const { reporter: secondReporter, log: secondLog } = recordingReporter();
	instrumentExtensions(
		[extension],
		firstReporter,
		resolveExtensionRef,
		() => 0,
		fakeSessionManager("first"),
	);
	const secondRuntimeExtension: Extension = {
		...extension,
		handlers: new Map(),
		tools: new Map(extension.tools),
		commands: new Map(),
		shortcuts: new Map(),
	};
	instrumentExtensions(
		[secondRuntimeExtension],
		secondReporter,
		resolveExtensionRef,
		() => 0,
		fakeSessionManager("second"),
	);
	const definition = secondRuntimeExtension.tools.get("shared_tool")?.definition;
	assertExists(definition);

	await definition.execute(
		"call-1",
		{},
		undefined,
		undefined,
		recordingUiCtx([]), // no `sessionManager` at all — a plain test-fixture ctx
	);

	assertEquals(firstLog.filter((entry) => entry.event === "start").length, 0);
	assertEquals(secondLog.filter((entry) => entry.event === "start").length, 1);
});

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

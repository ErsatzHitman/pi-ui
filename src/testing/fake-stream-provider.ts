import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxProviderHandle,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
// R3-F: a scripted, network-free model provider used to drive real turns through the
// real pi SDK session machinery (RuntimeController -> reduceSessionEvent -> AppStore ->
// UiRenderer -> DatastarClientHub) for end-to-end streaming tests. No test ever reaches a
// real model API: `@earendil-works/pi-ai`'s own `faux` provider streams scripted content
// with the exact same event shapes (`text_delta`, `thinking_delta`, `toolcall_delta`, ...)
// a real provider would produce, and tool calls it emits (`bash`, `read`, and the
// `fleet_publish` tool this module registers) run for real through pi's real tool
// executor. See `src/e2e-streaming/` for the tests that use this fixture.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { JsonObject } from "../utils/json-types.ts";
import { isJsonObject } from "../utils/type-guards.ts";

/** Provider and model ids the fixture registers; pass `fakeStreamModelRef` to `RuntimeController.setModel`. */
export const fakeStreamProviderId = "pi-ui-fake-stream";
export const fakeStreamModelId = "scripted-1";
export const fakeStreamModelRef = `${fakeStreamProviderId}/${fakeStreamModelId}`;

/** Name of the extension-registered tool a scripted turn calls to simulate a burst of
 * sub-agent-style `pi.events` publishes (feeds the Live Workspace Agents tab). */
export const fleetPublishToolName = "fleet_publish";

/**
 * Directive builders: embed one of these in a prompt string sent to the fake model.
 * The scripted responder (`scriptedTurn` below) reads the directive back out of the
 * conversation's messages and answers accordingly, so no cross-process state or
 * `globalThis` plumbing is needed — the same extension object works whether it is
 * registered in-process (via `resourceLoaderOptions.extensionFactories`) or loaded from
 * disk by a real `pi-ui` server process started for browser validation
 * (`writeFakeStreamProviderExtensionFile`).
 */
export const fakeDirectives = {
	/** A plain scripted text reply (with a short thinking block first). */
	text: (note = "hello") => `Say hello. [[TEXT:${note}]]`,
	/** A real `bash` tool call, then a follow-up text turn once it completes. */
	bash: (command: string) => `Run a command. [[BASH:${command}]]`,
	/** A real `read` tool call, then a follow-up text turn once it completes. */
	read: (path: string) => `Read a file. [[READ:${path}]]`,
	/** A `bash` tool call that prints ~1000 lines, to exercise large tool output. */
	bigOutput: (lines = 1000) => `Print a lot of output. [[BIGOUTPUT:${lines}]]`,
	/** A `fleet_publish` tool call that emits `count` `subagents:fleet` events at
	 * roughly `1000 / intervalMs` events/second. */
	fleet: (count: number, intervalMs = 10) =>
		`Dispatch the fleet. [[FLEET:${count}:${intervalMs}]]`,
	/** A tool call to any registered tool by name, with arbitrary JSON args — for
	 * scripting a turn against a tool this fixture doesn't itself register, such as
	 * an extension's own (e.g. `ask_user`, loaded from a real or fixture agent dir
	 * alongside this provider). Unlike the other directives, the args can contain
	 * `]` (e.g. an `options` array) without truncating the directive early. */
	tool: (name: string, args: JsonObject = {}) =>
		`Call a tool. [[TOOL:${name}:${JSON.stringify(args)}]]`,
} as const;

function contentToText(content: string | Array<{ type: string; text?: string }>): string {
	if (!Array.isArray(content)) return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

const directivePattern = /\[\[[A-Z]+/;

/**
 * The prompt driving the current turn: among the user messages since the last assistant
 * reply, the one carrying a `[[DIRECTIVE]]`, else the latest. A real extension set (memory
 * injection, time-sense, ...) appends its own user-role context messages after the prompt
 * through the `context` event, so "the last user message" is often not the prompt.
 */
export function currentTurnPrompt(context: TranscriptContext): string {
	const turn: string[] = [];
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "assistant") break;
		if (message?.role === "user") turn.unshift(contentToText(message.content));
	}
	return turn.find((text) => directivePattern.test(text)) ?? turn.at(-1) ?? "";
}

type Directive =
	| { kind: "text"; note: string }
	| { kind: "bash"; command: string }
	| { kind: "read"; path: string }
	| { kind: "bigOutput"; lines: number }
	| { kind: "fleet"; count: number; intervalMs: number }
	| { kind: "tool"; name: string; args: JsonObject }
	| { kind: "none" };

function parseDirective(prompt: string): Directive {
	// Tried first, and anchored to the *last* `]]` in the prompt (`[\s\S]*`, greedy):
	// a TOOL directive's JSON args may themselves contain `]` (an `options` array,
	// ask_user's shape), which the generic directive regex below — bounded to
	// `[^\]]*`, correct for the other directives' plain-text payloads — would cut
	// off at the first one.
	const toolMatch = /\[\[TOOL:([a-zA-Z_][\w.-]*):([\s\S]*)\]\]\s*$/.exec(prompt);
	if (toolMatch) {
		const [, name, rawArgs] = toolMatch;
		let args: JsonObject = {};
		try {
			const parsed: unknown = JSON.parse(rawArgs ?? "{}");
			if (isJsonObject(parsed)) args = parsed;
		} catch {
			// Malformed args JSON: call the tool with no args rather than failing the
			// whole scripted turn — a test author's bug shows up as a tool-schema
			// validation error, which is easier to diagnose than a silent hang.
		}
		return { kind: "tool", name, args };
	}
	const match = /\[\[(\w+)(?::([^\]]*))?\]\]/.exec(prompt);
	if (!match) return { kind: "none" };
	const [, name, raw = ""] = match;
	switch (name) {
		case "TEXT":
			return { kind: "text", note: raw || "hello" };
		case "BASH":
			return { kind: "bash", command: raw || "echo fake-stream-ok" };
		case "READ":
			return { kind: "read", path: raw };
		case "BIGOUTPUT":
			return { kind: "bigOutput", lines: Number(raw) > 0 ? Number(raw) : 1000 };
		case "FLEET": {
			const [count, intervalMs] = raw.split(":");
			return {
				kind: "fleet",
				count: Number(count) > 0 ? Number(count) : 50,
				intervalMs: Number(intervalMs) > 0 ? Number(intervalMs) : 10,
			};
		}
		default:
			return { kind: "none" };
	}
}

/** Cross-platform "print N lines" bash command (works under Git Bash on Windows and
 * /bin/bash elsewhere; avoids depending on `seq`, which minimal shells may lack). */
function bigOutputCommand(lines: number): string {
	return `i=1; while [ "$i" -le ${lines} ]; do echo "line-$i"; i=$((i + 1)); done`;
}

/**
 * The scripted responder. Each call answers based on the *last* message in the
 * conversation: a fresh user prompt carrying a `[[DIRECTIVE]]` marker produces a tool
 * call (or plain text); a `toolResult` that just came back produces a short wrap-up
 * reply. This lets one stateless factory drive arbitrarily many internal turns
 * (thinking -> tool call -> tool result -> final text) without any external
 * `setResponses()` bookkeeping from the test.
 */
/** The tool result this turn is answering, if any — looked up past any injected context
 * messages an extension appended after it (see `currentTurnPrompt`). */
export function currentTurnToolResult(context: TranscriptContext) {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "toolResult") return message;
		if (message?.role === "assistant") return undefined;
		// A directive prompt after the result (a steering message) is answered instead.
		if (
			message?.role === "user" &&
			directivePattern.test(contentToText(message.content))
		) {
			return undefined;
		}
	}
	return undefined;
}

const scriptedTurn: FauxResponseFactory = (context) => {
	const last = currentTurnToolResult(context);
	if (last) {
		const resultText = contentToText(last.content).slice(0, 200);
		return fauxAssistantMessage(
			fauxText(
				`${last.toolName} finished (${last.isError ? "error" : "ok"}): ${resultText}`,
			),
		);
	}
	const directive = parseDirective(currentTurnPrompt(context));
	switch (directive.kind) {
		case "bash":
			return fauxAssistantMessage(
				[
					fauxThinking("Running a shell command."),
					fauxToolCall("bash", { command: directive.command }),
				],
				{ stopReason: "toolUse" },
			);
		case "read":
			return fauxAssistantMessage(
				[
					fauxThinking("Reading a file."),
					fauxToolCall("read", { path: directive.path }),
				],
				{ stopReason: "toolUse" },
			);
		case "bigOutput":
			return fauxAssistantMessage(
				[
					fauxThinking("Generating a lot of output."),
					fauxToolCall("bash", { command: bigOutputCommand(directive.lines) }),
				],
				{ stopReason: "toolUse" },
			);
		case "fleet":
			return fauxAssistantMessage(
				[
					fauxThinking("Dispatching the fleet."),
					fauxToolCall(fleetPublishToolName, {
						count: directive.count,
						intervalMs: directive.intervalMs,
					}),
				],
				{ stopReason: "toolUse" },
			);
		case "tool":
			return fauxAssistantMessage(
				[
					fauxThinking(`Calling ${directive.name}.`),
					fauxToolCall(directive.name, directive.args),
				],
				{ stopReason: "toolUse" },
			);
		case "text":
			return fauxAssistantMessage([
				fauxThinking(`Thinking about: ${directive.note}`),
				fauxText(`Fake reply: ${directive.note}`),
			]);
		default:
			return fauxAssistantMessage(fauxText("Fake reply: (no directive found)"));
	}
};

const fleetPublishParams = Type.Object({
	count: Type.Optional(
		Type.Number({ description: "Number of subagents:fleet events to publish." }),
	),
	intervalMs: Type.Optional(
		Type.Number({ description: "Delay between events, in milliseconds." }),
	),
});

/** Registers the scripted provider and the `fleet_publish` tool. Safe to pass directly
 * as an `InlineExtension` (in-process tests) or to load from disk (see
 * `writeFakeStreamProviderExtensionFile`) — both paths call this same factory. */
export function fakeStreamProviderFactory(pi: ExtensionAPI): FauxProviderHandle {
	const handle = fauxProvider({
		provider: fakeStreamProviderId,
		// A short token size keeps deltas frequent (so tests observe multiple SSE
		// patches per block); a modest tokens/sec throttle keeps `session.isStreaming`
		// (which only covers actual token generation, not tool execution) genuinely true
		// for a real, awaitable stretch of wall-clock time — tests that submit a second
		// prompt "while streaming" (queue/steer behavior) need that window, and an
		// unthrottled faux stream resolves too fast (sub-millisecond) to ever observe it.
		tokenSize: { min: 2, max: 4 },
		tokensPerSecond: 24,
		models: [
			{
				id: fakeStreamModelId,
				name: "pi-ui scripted stream fixture",
				reasoning: true,
			},
		],
	});
	// One stateless factory, seeded generously: every internal turn (tool call, then
	// wrap-up) consumes one slot, and a handful of scripted turns per test never comes
	// close to exhausting this.
	handle.setResponses(Array.from({ length: 500 }, () => scriptedTurn));
	pi.registerProvider(handle.provider);
	pi.registerTool({
		name: fleetPublishToolName,
		label: "Fleet publish (test fixture)",
		description:
			"Publish a scripted burst of subagents:fleet channel events, for testing only.",
		parameters: fleetPublishParams,
		async execute(_toolCallId, params, signal) {
			const count =
				params.count && params.count > 0 ? Math.floor(params.count) : 50;
			const intervalMs =
				params.intervalMs && params.intervalMs > 0 ? params.intervalMs : 10;
			let published = 0;
			for (let index = 0; index < count; index += 1) {
				if (signal?.aborted) break;
				pi.events.emit("subagents:fleet", {
					entries: [
						{
							key: "scout",
							name: `scout-${index}`,
							state: index % 2 === 0 ? "running" : "idle",
							depth: 0,
						},
					],
				});
				published += 1;
				if (index < count - 1) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, intervalMs);
						signal?.addEventListener("abort", () => {
							clearTimeout(timer);
							resolve();
						});
					});
				}
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `published ${published} fleet events`,
					},
				],
				details: {
					count: published,
					requested: count,
					intervalMs,
					aborted: signal?.aborted === true,
				},
			};
		},
	});
	return handle;
}

/** `InlineExtension` for in-process tests: pass in `resourceLoaderOptions.extensionFactories`. */
export const fakeStreamProviderExtension: InlineExtension = {
	name: "pi-ui-fake-stream-provider",
	factory: (pi: ExtensionAPI) => {
		fakeStreamProviderFactory(pi);
	},
	hidden: true,
};

/**
 * Writes a disk-loadable extension file into `${agentDir}/extensions/` that re-exports
 * this module's factory by absolute path, for a real, separately-spawned `pi-ui` server
 * process (browser/CDP validation) to discover exactly the way a real extension would be
 * discovered — no server-side code changes, no duplicated scripting logic.
 */
export async function writeFakeStreamProviderExtensionFile(
	agentDir: string,
): Promise<string> {
	const { mkdir } = await import("node:fs/promises");
	// Round-trip through fileURLToPath/pathToFileURL (rather than reusing `import.meta.url`
	// directly) so this also normalizes correctly on Windows (`file:///D:/...`).
	const { fileURLToPath, pathToFileURL } = await import("node:url");
	const modulePath = pathToFileURL(fileURLToPath(import.meta.url)).href;
	const extensionsDir = `${agentDir}/extensions`;
	await mkdir(extensionsDir, { recursive: true });
	const target = `${extensionsDir}/fake-stream-provider.js`;
	await Bun.write(
		target,
		[
			`import { fakeStreamProviderFactory } from ${JSON.stringify(modulePath)};`,
			"export default function (pi) {",
			"\tfakeStreamProviderFactory(pi);",
			"}",
			"",
		].join("\n"),
	);
	return target;
}

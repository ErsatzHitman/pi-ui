import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import type { JsonValue } from "../utils/json-types.ts";
import type { LiveWorkspaceController } from "./live-workspace-controller.ts";

const liveWorkspaceHostId = "pi-ui.live-workspace-host";

/** `pi.events` channels that pi-ui's Live Workspace pane reads without any extension changes. */
const tappedChannels = [
	"subagents:fleet",
	"bash-bg:fleet",
	"workflow:progress",
	"pi-goal:status",
	"panel:state",
	"fleet:handoff",
] as const;

/**
 * Identifies which runtime a host-extension instance was loaded into. Every runtime gets its
 * own host extension (and its own `pi.events` bus), so the sink can drop updates from
 * background runtimes — background sessions must never bleed into the foreground pane.
 */
export type LiveWorkspaceHostOrigin = Readonly<{
	readonly kind: "live-workspace-origin";
}>;

export function createLiveWorkspaceHostOrigin(): LiveWorkspaceHostOrigin {
	return { kind: "live-workspace-origin" };
}

/**
 * Receives host-extension updates. The owner decides whether `origin` is the foreground
 * runtime, applies `update` to the shared controller, and publishes the result.
 */
export type LiveWorkspaceHostSink = (
	origin: LiveWorkspaceHostOrigin,
	update: (controller: LiveWorkspaceController) => void,
) => void;

/**
 * Hidden inline extension that taps cross-cutting session state for the Live Workspace pane:
 * the shared `pi.events` channels published by the user's real extensions (subagent fleets,
 * background bash jobs, workflow/goal progress), plus extension-hook lifecycle events that
 * never reach `AgentSessionEvent` (`ui_prompt_start`/`end`, model and thinking-level selection).
 *
 * Mirrors `llama-provider-extension.ts`'s injection shape. Every handler is defensively
 * wrapped: a malformed or throwing payload from a third-party extension must never propagate
 * into the pi SDK (AGENTS.md non-negotiable).
 */
export function createLiveWorkspaceHostExtension(
	sink: LiveWorkspaceHostSink,
	origin: LiveWorkspaceHostOrigin,
): InlineExtension {
	return {
		name: liveWorkspaceHostId,
		factory: (api) => registerLiveWorkspaceHost(api, sink, origin),
		hidden: true,
	};
}

function registerLiveWorkspaceHost(
	api: ExtensionAPI,
	sink: LiveWorkspaceHostSink,
	origin: LiveWorkspaceHostOrigin,
): void {
	const send = (update: (controller: LiveWorkspaceController) => void) =>
		guard(() => sink(origin, update));
	for (const channel of tappedChannels) {
		api.events.on(channel, (payload) => {
			// SAFETY: `pi.events` payloads are genuinely unstructured extension output.
			// `recordChannel` re-serializes through `asDisplayableJson` regardless of this
			// claimed shape, so a value that isn't really JSON-safe still degrades safely.
			send((controller) => controller.recordChannel(channel, payload as JsonValue));
		});
	}
	api.on("ui_prompt_start", (event) => {
		send((controller) => controller.recordUiPromptStart(event.kind, event.title));
	});
	api.on("ui_prompt_end", () => {
		send((controller) => controller.recordUiPromptEnd());
	});
	api.on("model_select", (event) => {
		send((controller) => controller.recordModelSelect(event.model.id, event.source));
	});
	api.on("thinking_level_select", (event) => {
		send((controller) =>
			controller.recordThinkingSelect(event.level, event.previousLevel),
		);
	});
}

function guard(run: () => void): void {
	try {
		run();
	} catch {
		// Extension-sourced payloads are untrusted; never let a malformed one escape this host.
	}
}

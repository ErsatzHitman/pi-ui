import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import type { LiveWorkspaceController } from "./live-workspace-controller.ts";

const liveWorkspaceHostId = "pi-ui.live-workspace-host";

/** `pi.events` channels that pi-ui's Live Workspace pane reads without any extension changes. */
const tappedChannels = [
	"subagents:fleet",
	"bash-bg:fleet",
	"workflow:progress",
	"pi-goal:status",
	"panel:state",
] as const;

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
	controller: LiveWorkspaceController,
): InlineExtension {
	return {
		name: liveWorkspaceHostId,
		factory: (api) => registerLiveWorkspaceHost(api, controller),
		hidden: true,
	};
}

function registerLiveWorkspaceHost(api: ExtensionAPI, controller: LiveWorkspaceController): void {
	for (const channel of tappedChannels) {
		api.events.on(channel, (payload: unknown) => {
			guard(() => controller.recordChannel(channel, payload));
		});
	}
	api.on("ui_prompt_start", (event) => {
		guard(() => controller.recordUiPromptStart(event.kind, event.title));
	});
	api.on("ui_prompt_end", () => {
		guard(() => controller.recordUiPromptEnd());
	});
	api.on("model_select", (event) => {
		guard(() => controller.recordModelSelect(event.model.id, event.source));
	});
	api.on("thinking_level_select", (event) => {
		guard(() => controller.recordThinkingSelect(event.level, event.previousLevel));
	});
}

function guard(run: () => void): void {
	try {
		run();
	} catch {
		// Extension-sourced payloads are untrusted; never let a malformed one escape this host.
	}
}

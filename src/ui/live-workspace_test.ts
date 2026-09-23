import { test } from "bun:test";

import { assertFalse, assertStringIncludes } from "#testing/assertions";

import {
	emptyLiveWorkspaceSnapshot,
	type LiveWorkspacePreferences,
	type LiveWorkspaceSnapshot,
} from "../live-workspace-types.ts";
import type { AppUsage } from "../state/app-store.ts";
import {
	renderLiveWorkspace,
	renderLiveWorkspaceAgentsSection,
	renderLiveWorkspaceData,
	renderLiveWorkspaceToggle,
	renderLiveWorkspaceUsageSection,
} from "./live-workspace.tsx";
import { appRenderSnapshot } from "./test-fixtures.ts";

const emptyUsage: AppUsage = { text: "$0.000 • 0 tokens", costText: "$0.000" };

function snapshot(overrides: Partial<LiveWorkspaceSnapshot> = {}): LiveWorkspaceSnapshot {
	return { ...emptyLiveWorkspaceSnapshot, ...overrides };
}

test("the toggle button carries the pane's keybind and toggle signal", () => {
	const html = renderLiveWorkspaceToggle(appRenderSnapshot({}));
	assertStringIncludes(html, 'id="live-workspace-toggle"');
	assertStringIncludes(html, "$_liveWorkspaceOpen = !$_liveWorkspaceOpen");
	assertStringIncludes(html, "alt");
});

test("the pane shell starts hidden and inert until the open signal flips", () => {
	const html = renderLiveWorkspace(snapshot(), {}, emptyUsage);
	assertStringIncludes(html, 'id="live-workspace"');
	assertStringIncludes(html, 'aria-hidden="true"');
	assertStringIncludes(html, "$_liveWorkspaceOpen ? 'false' : 'true'");
	assertStringIncludes(html, "!$_liveWorkspaceOpen");
});

test("only the preference-selected tab renders visible; the rest are display:none", () => {
	const preferences: LiveWorkspacePreferences = { tab: "usage" };
	const html = renderLiveWorkspaceData(snapshot(), preferences, emptyUsage);
	assertStringIncludes(html, 'id="live-workspace-usage"');
	assertFalse(
		html
			.slice(
				html.indexOf('id="live-workspace-usage"'),
				html.indexOf('id="live-workspace-usage"') + 40,
			)
			.includes("display: none"),
	);
	assertStringIncludes(html, 'id="live-workspace-now"');
	const nowIndex = html.indexOf('id="live-workspace-now"');
	assertStringIncludes(html.slice(nowIndex, nowIndex + 200), "display: none");
});

test("the now tab shows a running banner with an abort action while a turn is active", () => {
	const html = renderLiveWorkspaceData(
		snapshot({ turn: { phase: "running" } }),
		{},
		emptyUsage,
	);
	assertStringIncludes(html, "Running");
	assertStringIncludes(html, 'data-turn-phase="running"');
	assertStringIncludes(html, `@post('/abort'`);
});

test("a compacting turn reports its reason and offers no abort action", () => {
	const html = renderLiveWorkspaceData(
		snapshot({ turn: { phase: "compacting", compactionReason: "threshold" } }),
		{},
		emptyUsage,
	);
	assertStringIncludes(html, "Compacting context (threshold)");
	assertFalse(html.includes("Abort"));
});

test("a waiting-for-extension turn names the prompt title", () => {
	const html = renderLiveWorkspaceData(
		snapshot({
			turn: {
				phase: "waiting-for-extension",
				waitingKind: "select",
				waitingTitle: "Pick a branch",
			},
		}),
		{},
		emptyUsage,
	);
	assertStringIncludes(html, "Waiting for extension UI: Pick a branch");
});

test("active tools list their summary and an elapsed-time marker for the client ticker", () => {
	const html = renderLiveWorkspaceData(
		snapshot({
			activeTools: [
				{
					toolCallId: "call-1",
					toolName: "bash",
					summary: "Running echo hi",
					startedAt: 1000,
				},
			],
		}),
		{},
		emptyUsage,
	);
	assertStringIncludes(html, "Running echo hi");
	assertStringIncludes(html, 'data-live-workspace-elapsed="1000"');
});

test("the agents tab offers to open a tracked background session", () => {
	const html = renderLiveWorkspaceData(
		snapshot({
			agents: [
				{
					id: "/sessions/bg.jsonl",
					kind: "background-session",
					source: "pi-ui",
					label: "~/project",
					status: "running",
					depth: 0,
				},
			],
		}),
		{ tab: "agents" },
		emptyUsage,
	);
	assertStringIncludes(html, "~/project");
	assertStringIncludes(html, "Open");
	assertStringIncludes(html, "/sessions/bg.jsonl");
});

test("the agents tab reports an empty roster when nothing is tracked", () => {
	const html = renderLiveWorkspaceData(snapshot(), { tab: "agents" }, emptyUsage);
	assertStringIncludes(html, "No subagents, background jobs, or background sessions.");
});

test("the usage tab renders a context meter and per-window quota limits", () => {
	const usage: AppUsage = {
		text: "$1.230 • 12,000 tokens",
		costText: "$1.230",
		contextPercent: 42,
		contextTokens: 12_000,
		contextWindow: 28_000,
		limits: {
			label: "Weekly limit",
			windows: [
				{
					label: "5h window",
					usedPercent: 60,
					remainingPercent: 40,
					resetText: "in 2h",
				},
			],
		},
	};
	const html = renderLiveWorkspaceData(snapshot(), { tab: "usage" }, usage);
	assertStringIncludes(html, "$1.230");
	assertStringIncludes(html, 'role="meter"');
	assertStringIncludes(html, 'aria-valuenow="42"');
	assertStringIncludes(html, "Weekly limit");
	assertStringIncludes(html, "5h window");
	assertStringIncludes(html, "60% used · resets in 2h");
});

test("the activity tab disables Clear once the log is empty", () => {
	const empty = renderLiveWorkspaceData(snapshot(), { tab: "activity" }, emptyUsage);
	assertStringIncludes(empty, "No activity recorded yet.");
	assertStringIncludes(empty, "disabled");

	const populated = renderLiveWorkspaceData(
		snapshot({
			activity: [
				{
					id: "1",
					at: 500,
					kind: "retry",
					text: "Retrying (1/3)",
					background: false,
				},
			],
		}),
		{ tab: "activity" },
		emptyUsage,
	);
	assertStringIncludes(populated, "Retrying (1/3)");
	assertStringIncludes(populated, `@post('/live-workspace/clear-activity'`);
});

test("the extensions tab falls back to raw JSON for an untyped channel payload", () => {
	const html = renderLiveWorkspaceData(snapshot(), { tab: "extensions" }, emptyUsage, {
		extensionElements: [],
		extensionChannels: [
			{
				channel: "workflow:progress",
				payload: { active: true, name: "Refactor" },
				updatedAt: 100,
			},
		],
	});
	assertStringIncludes(html, "workflow:progress");
	assertStringIncludes(html, "&quot;active&quot;: true");
	assertStringIncludes(html, "Refactor");
});

test("the extensions tab reuses the shared PIUI renderer and links sheets to their dialog", () => {
	const html = renderLiveWorkspaceData(snapshot(), { tab: "extensions" }, emptyUsage, {
		extensionElements: [
			{
				id: "fleet",
				ns: "subagents",
				kind: "roster",
				placement: "pinned",
				title: "Fleet",
				data: { rows: [{ label: "scout", status: "running" }] },
				revision: 1,
				updatedAt: 1,
			},
			{
				id: "review",
				ns: "workflow",
				kind: "panel",
				placement: "sheet",
				title: "Review plan",
				data: {},
				revision: 1,
				updatedAt: 1,
			},
		],
		extensionChannels: [],
	});
	assertStringIncludes(html, 'class="piui-element piui-element-roster"');
	assertStringIncludes(html, "Fleet");
	assertStringIncludes(html, 'commandfor="piui-sheet-workflow-review"');
	assertStringIncludes(html, "Review plan");
	// The sheet's own <dialog> lives in #piui-sheets; the tab must not duplicate it.
	assertFalse(html.includes("<dialog"));
});

test("each tab section renders standalone, for independent patching (A#13)", () => {
	const usage: AppUsage = { text: "$3.000 • 3,000 tokens", costText: "$3.000" };
	const agentsOnly = renderLiveWorkspaceAgentsSection(
		snapshot({
			agents: [
				{
					id: "a1",
					kind: "channel-entry",
					source: "subagents:fleet",
					label: "scout",
					status: "running",
					depth: 0,
				},
			],
		}),
		"agents",
	);
	assertStringIncludes(agentsOnly, 'id="live-workspace-agents"');
	assertStringIncludes(agentsOnly, "scout");
	assertFalse(agentsOnly.includes('id="live-workspace-usage"'));
	assertFalse(agentsOnly.includes("display: none"));

	const usageOnly = renderLiveWorkspaceUsageSection(usage, "now");
	assertStringIncludes(usageOnly, 'id="live-workspace-usage"');
	assertStringIncludes(usageOnly, "$3.000");
	assertStringIncludes(usageOnly, "display: none");
	assertFalse(usageOnly.includes('id="live-workspace-agents"'));
});

test("the extensions tab reports no activity when nothing has been observed", () => {
	const html = renderLiveWorkspaceData(snapshot(), { tab: "extensions" }, emptyUsage);
	assertStringIncludes(html, "No extension UI or channel activity observed yet.");
});

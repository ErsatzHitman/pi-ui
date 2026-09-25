import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import type {
	ExtensionActivityChip,
	ExtensionActivityView,
} from "../extension-activity-types.ts";
import { assertStringExcludes } from "../testing/assertions.ts";
import { renderExtensionActivityChips } from "./extension-activity.tsx";
import { renderMessage } from "./messages.tsx";
import type { AppMessage } from "./render-state.ts";

function activity(overrides: Partial<ExtensionActivityView> = {}): ExtensionActivityView {
	return {
		v: 1,
		id: "xa-1",
		extension: {
			id: "jev",
			label: "JEV",
			path: "/ext/jev/index.ts",
			source: "local",
		},
		trigger: { kind: "hook", event: "before_agent_start" },
		title: "Consult",
		state: "working",
		startedAt: 0,
		output: [],
		...overrides,
	};
}

function activityMessage(
	role: "extension-activity" | "tool",
	overrides: Partial<AppMessage> = {},
): AppMessage {
	return {
		id: "m-1",
		presentationState: "final",
		presentationVersion: 1,
		role,
		state: "success",
		text: "",
		timestamp: new Date(0),
		activities: [activity()],
		...overrides,
	};
}

test("a standalone extension-activity card carries the frozen DOM contract", () => {
	const html = renderMessage(activityMessage("extension-activity"));
	assertStringIncludes(html, "message-ext-activity");
	assertStringIncludes(html, 'data-activity-id="xa-1"');
	assertStringIncludes(html, 'data-activity-state="working"');
	assertStringIncludes(html, 'data-activity-extension="jev"');
	assertStringIncludes(html, 'data-activity-trigger="hook"');
	assertStringIncludes(html, 'data-preserve-attr="open"');
	assertStringIncludes(html, 'aria-busy="true"');
	assertStringIncludes(html, ">JEV<");
	assertStringIncludes(html, ">Consult<");
	assertStringIncludes(html, "before_agent_start");
});

test("a missing activity renders nothing instead of an empty card", () => {
	const html = renderMessage(activityMessage("extension-activity", { activities: [] }));
	assertEquals(html, "");
});

test("each lifecycle state gets its own visible label, and only working is aria-busy", () => {
	const working = renderMessage(
		activityMessage("extension-activity", {
			activities: [activity({ state: "working" })],
		}),
	);
	assertStringIncludes(working, ">Working<");
	assertStringIncludes(working, 'aria-busy="true"');

	const done = renderMessage(
		activityMessage("extension-activity", {
			activities: [
				activity({ state: "done", finishedAt: 2100, durationText: "2.1s" }),
			],
		}),
	);
	assertStringIncludes(done, ">Done<");
	assertStringIncludes(done, "2.1s");
	assertStringExcludes(done, "aria-busy");

	const failed = renderMessage(
		activityMessage("extension-activity", {
			activities: [activity({ state: "error", error: "boom" })],
		}),
	);
	assertStringIncludes(failed, ">Failed<");
	assertStringIncludes(failed, "boom");

	const stopped = renderMessage(
		activityMessage("extension-activity", {
			activities: [activity({ state: "cancelled", summary: "Stopped" })],
		}),
	);
	assertStringIncludes(stopped, ">Stopped<");
});

test("an errored activity opens its output by default; a working one stays collapsed", () => {
	const working = renderMessage(
		activityMessage("extension-activity", {
			activities: [activity({ state: "working" })],
		}),
	);
	// `data-preserve-attr="open"` is always present (so a user's toggle survives a
	// patch); the bare boolean `open` attribute right after it is what actually
	// opens the <details> — present only when `openByDefault` is true.
	assertStringIncludes(working, 'data-preserve-attr="open">');
	assertStringExcludes(working, 'data-preserve-attr="open" open');

	const failed = renderMessage(
		activityMessage("extension-activity", {
			activities: [activity({ state: "error", error: "boom" })],
		}),
	);
	assertStringIncludes(failed, 'data-preserve-attr="open" open>');
});

test("a display:false payload is still shown, collapsed, and labelled hidden in terminal", () => {
	const html = renderMessage(
		activityMessage("extension-activity", {
			activities: [
				activity({
					state: "done",
					output: [
						{
							kind: "system-prompt",
							title: "Sent to model",
							text: "use 2 agents",
							hidden: true,
						},
					],
				}),
			],
		}),
	);
	assertStringIncludes(html, "data-hidden-payload");
	assertStringIncludes(html, "Sent to model");
	assertStringIncludes(html, "hidden in terminal");
	assertStringIncludes(html, "use 2 agents");
	assertStringIncludes(html, 'data-output-kind="system-prompt"');
});

test("output text is escaped, never raw HTML from the extension", () => {
	const html = renderMessage(
		activityMessage("extension-activity", {
			activities: [
				activity({
					state: "done",
					output: [
						{
							kind: "panel",
							title: "Panel (final frame)",
							text: "<script>evil()</script>",
						},
					],
				}),
			],
		}),
	);
	assertStringExcludes(html, "<script>evil()</script>");
	assertStringIncludes(html, "&lt;script&gt;");
});

test("a tool card folds extension activities in as steps, right after the header", () => {
	const html = renderMessage(
		activityMessage("tool", {
			title: "subagent_start",
			extension: { id: "jev", label: "JEV", path: "/ext/jev", source: "local" },
			activities: [
				activity({
					id: "xa-step",
					trigger: { kind: "tool", toolName: "subagent_start" },
				}),
			],
		}),
	);
	assertStringIncludes(html, "ext-activity-steps");
	assertStringIncludes(html, 'data-activity-id="xa-step"');
	assertStringIncludes(html, 'data-tool-extension="jev"');
	// The extension-owned tool's own dot uses the shared pink "working" class.
	assertStringIncludes(html, "status-dot-active");
});

test("a tool with no extension activities renders no steps and no extension attribution", () => {
	const html = renderMessage(
		activityMessage("tool", { activities: undefined, extension: undefined }),
	);
	assertStringExcludes(html, "ext-activity-steps");
	assertStringExcludes(html, "data-tool-extension=");
});

function chip(overrides: Partial<ExtensionActivityChip> = {}): ExtensionActivityChip {
	return {
		id: "xa-1",
		extensionLabel: "Advisor",
		state: "working",
		...overrides,
	};
}

test("prompt chips are buttons with an aria-label naming the extension and progress", () => {
	const html = renderExtensionActivityChips([
		chip({ progress: "reviewing…", anchorMessageId: "m-42" }),
	]);
	assertStringIncludes(html, "<button");
	assertStringIncludes(html, 'aria-label="Advisor working: reviewing…"');
	assertStringIncludes(html, "ext-activity-chip");
	assertStringIncludes(html, "reviewing…");
	assertStringIncludes(html, "m-42");
});

test("only a chip with an anchor message is marked actionable (drives its press feedback)", () => {
	const anchored = renderExtensionActivityChips([chip({ anchorMessageId: "m-42" })]);
	assertStringIncludes(anchored, "data-activity-chip-actionable");

	const unanchored = renderExtensionActivityChips([chip()]);
	assertStringExcludes(unanchored, "data-activity-chip-actionable");
});

test("no chips renders nothing", () => {
	assertEquals(renderExtensionActivityChips([]), "");
});

test("the chip row adds a +N overflow chip past two working activities", () => {
	const html = renderExtensionActivityChips([
		chip({ id: "xa-1" }),
		chip({ id: "xa-2" }),
		chip({ id: "xa-3" }),
		chip({ id: "xa-4" }),
	]);
	assertStringIncludes(html, "ext-activity-chip-more");
	assertStringIncludes(html, "+2");
	assertStringIncludes(html, 'aria-label="2 more working"');
	assertEquals(
		renderExtensionActivityChips([
			chip({ id: "xa-1" }),
			chip({ id: "xa-2" }),
		]).includes("ext-activity-chip-more"),
		false,
	);
});

test("the result line lives inside <summary>, so it stays visible while the card is collapsed", () => {
	const html = renderMessage(
		activityMessage("extension-activity", {
			activities: [
				activity({
					state: "done",
					summary: "A red square.",
					finishedAt: 8000,
					durationText: "8.0s",
					output: [
						{
							kind: "returned-message",
							title: "Sent to model",
							text: "A red square.",
							hidden: true,
						},
					],
				}),
			],
		}),
	);
	const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
	assertStringIncludes(summary, 'class="ext-activity-progress"');
	assertStringIncludes(summary, "A red square.");
	// A card with collapsible output shows the same chevron every context card does.
	assertStringIncludes(summary, "context-chevron");
});

test("a card with no output has nothing to expand, so it shows no chevron", () => {
	const html = renderMessage(
		activityMessage("extension-activity", {
			activities: [activity({ progress: "describing 1 image" })],
		}),
	);
	const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
	assertStringIncludes(summary, "describing 1 image");
	assertStringExcludes(html, "context-chevron");
});

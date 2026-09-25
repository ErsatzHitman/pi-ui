import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import { emptyLiveWorkspaceSnapshot } from "../live-workspace-types.ts";
import { assertStringExcludes } from "../testing/assertions.ts";
import { renderPromptAction } from "./prompt-action.tsx";
import { renderPromptStatus, renderUsageIndicators } from "./prompt-status.tsx";
import { appRenderSnapshot } from "./test-fixtures.ts";

test("usage fallback explains unavailable context and preserves session cost", () => {
	const snapshot = appRenderSnapshot({
		activityText: undefined,
		usage: {
			text: "$14.60 • ?/272k",
			costText: "$14.60",
			contextWindow: 272_000,
		},
	});
	const usageHtml = renderUsageIndicators(snapshot.usage);

	assertStringIncludes(usageHtml, "Available after next response");
	assertStringIncludes(usageHtml, "$14.60 session");
});

test("an extension dialog waiting for input shows its own status instead of Sending... (m6)", () => {
	const waiting = renderPromptStatus(
		appRenderSnapshot({
			liveWorkspace: {
				...emptyLiveWorkspaceSnapshot,
				turn: {
					phase: "waiting-for-extension",
					waitingKind: "select",
					waitingTitle: "Pick an option",
				},
			},
		}),
	);
	assertStringIncludes(waiting, "Waiting for extension input: Pick an option");
	assertStringIncludes(waiting, 'data-show="true"');
	assertStringExcludes(waiting, "Sending...");
});

test("an ordinary running turn keeps the Sending... status gated on the submit signal", () => {
	const running = renderPromptStatus(
		appRenderSnapshot({
			liveWorkspace: { ...emptyLiveWorkspaceSnapshot, turn: { phase: "running" } },
		}),
	);
	assertStringIncludes(running, "Sending...");
	assertStringIncludes(running, 'data-show="$_promptSubmitting"');
	assertStringExcludes(running, "Waiting for extension input");
});

test("an extension status bound to an open activity renders only as that activity's chip", () => {
	const html = renderPromptStatus(
		appRenderSnapshot({
			extensionStatuses: [
				{ key: "fake-vision", text: "describing 1 image…", activityId: "xa-1" },
				{ key: "fake-mode", text: "build" },
			],
			extensionActivityChips: [
				{
					id: "xa-1",
					extensionLabel: "Vision Proxy",
					state: "working",
					progress: "describing 1 image…",
				},
			],
		}),
	);
	// The bound status's own `.extension-status` chip is suppressed...
	assertStringExcludes(html, 'data-extension-status="fake-vision"');
	// ...in favor of the pink activity chip carrying the same text.
	assertStringIncludes(html, "ext-activity-chip");
	assertStringIncludes(html, "Vision Proxy");
	assertStringIncludes(html, "describing 1 image…");
	// An unrelated status (not bound to any activity) still renders as before.
	assertStringIncludes(html, 'data-extension-status="fake-mode"');
});

test("a working message attributed to an open activity defers to that activity's chip", () => {
	const html = renderPromptStatus(
		appRenderSnapshot({
			activityText: "reviewing…",
			extensionWorkingVisible: true,
			extensionWorkingActivityId: "xa-2",
			extensionActivityChips: [
				{
					id: "xa-2",
					extensionLabel: "Advisor",
					state: "working",
					progress: "reviewing…",
				},
			],
		}),
	);
	assertStringExcludes(html, "prompt-working-status");
	assertStringIncludes(html, "Advisor");
});

test("an unattributed working message still renders exactly as before", () => {
	const html = renderPromptStatus(
		appRenderSnapshot({
			activityText: "doing a thing…",
			extensionWorkingVisible: true,
		}),
	);
	assertStringIncludes(html, "prompt-working-status");
	assertStringIncludes(html, "doing a thing…");
});

test("the working status and extension statuses are keyed, so an entry fires once per insertion", () => {
	const html = renderPromptStatus(
		appRenderSnapshot({
			activityText: "doing a thing…",
			extensionWorkingVisible: true,
			extensionStatuses: [{ key: "fake mode/1", text: "build" }],
		}),
	);
	assertStringIncludes(html, 'id="prompt-working-status"');
	assertStringIncludes(html, 'id="extension-status-fake%20mode%2F1"');
});

test("abort acknowledges at t0 from both the click and Escape, and its label waits for the tooltip delay", () => {
	const abort = renderPromptAction(appRenderSnapshot({ activityText: "Working…" }));
	const setAborting = "el.setAttribute('data-aborting', '');";
	assertStringIncludes(abort, `data-on:click="${setAborting} @post('/abort'`);
	const escape = abort.slice(abort.indexOf("data-on:keydown__window"));
	const escapeMark = escape.indexOf(setAborting);
	assertEquals(escapeMark >= 0 && escapeMark < escape.indexOf("@post('/abort'"), true);
	assertStringIncludes(abort, "data-tooltip-delay");
	// Both svgs stay rendered; the class swap drives the crossfade.
	assertStringIncludes(abort, "prompt-send-icon prompt-action-icon-exit");
	assertStringIncludes(abort, "prompt-abort-icon prompt-action-icon-enter");
});

test("the Send click holds the transcript spacer before clearing the composer", () => {
	const send = renderPromptAction(appRenderSnapshot({ activityText: undefined }));
	const hold = send.indexOf("window.piUi.messageScroll.holdSpacerForSend?.();");
	const clear = send.indexOf("window.piUi.prompt.clear();");
	assertEquals(hold >= 0 && hold < clear, true);
});

import { test } from "bun:test";
import os from "node:os";

import { assertEquals, assertFalse, assertStringIncludes } from "#testing/assertions";

import {
	renderFilePickerResults,
	renderSessionPicker,
	renderSlashPicker,
	renderWorkspaceBrowserContent,
	renderWorkspaceDialogMenu,
	slashPickerOpenExpression,
} from "./pickers.tsx";
import { queueItemId, renderPromptBox, renderPromptQueue } from "./prompt-box.tsx";
import {
	renderModelPicker,
	renderThinkingPicker,
	renderWorkspacePicker,
} from "./prompt-pickers.tsx";
import { appRenderSnapshot } from "./test-fixtures.ts";

test("slash picker anchors its selected result nearest the prompt", () => {
	const html = renderSlashPicker(
		appRenderSnapshot({
			slashCommands: [
				{ name: "login", description: "Log in", source: "system" },
				{ name: "logout", description: "Log out", source: "system" },
			],
		}),
	);
	assertStringIncludes(html, 'id="slash-picker-list"');
	assertStringIncludes(html, 'aria-label="Commands"');
	assertStringIncludes(html, 'id="slash-option-login"');
	assertFalse(html.includes("<button"));
	assertFalse(html.includes("tabindex="));
	assertStringIncludes(html, 'aria-selected="true"');
	assertStringIncludes(html, "$prompt = '';");
	assertStringIncludes(html, "@post('/prompt'");
	assertStringIncludes(html, "payload: { prompt: &#34;/login&#34; }");
});

test("slash picker completes user-defined commands instead of running them", () => {
	const html = renderSlashPicker(
		appRenderSnapshot({
			slashCommands: [
				{ name: "skill:review", description: "Review code", source: "skill" },
				{ name: "plan", description: "Plan", source: "prompt" },
				{
					name: "compact",
					description: "Compact",
					source: "system",
					argumentHint: "[instructions]",
				},
				{ name: "reload", description: "Reload", source: "system" },
			],
		}),
	);
	assertStringIncludes(html, "window.piUi.pickers.complete(&#34;skill:review&#34;)");
	assertStringIncludes(html, "window.piUi.pickers.complete(&#34;plan&#34;)");
	assertStringIncludes(html, "window.piUi.pickers.complete(&#34;compact&#34;)");
	assertStringIncludes(html, "payload: { prompt: &#34;/reload&#34; }");
});

test("choosing the slash picker's /model row opens the model picker, not a bare completion", () => {
	// Regression: typing "/model" + Enter accepted the slash row, which completed the
	// prompt to "/model " and opened argument completions instead of the model picker —
	// the user was left in a list they could not pick from with the keyboard.
	const html = renderSlashPicker(
		appRenderSnapshot({
			slashCommands: [
				{
					name: "model",
					description: "Select model (opens selector UI)",
					source: "system",
					argumentHint: "<provider/model>",
				},
			],
		}),
	);
	assertStringIncludes(html, "payload: { prompt: &#34;/model&#34; }");
	assertFalse(html.includes("window.piUi.pickers.complete(&#34;model&#34;)"));
});

test("file suggestions have stable option ids without nested focus targets", () => {
	const html = renderFilePickerResults([
		{ value: '@"src/my file.ts"', label: "my file.ts" },
		{ value: "@src/", label: "src/" },
	]);
	assertStringIncludes(html, 'aria-label="Files"');
	assertStringIncludes(html, 'id="file-option-%40%22src%2Fmy%20file.ts%22"');
	assertStringIncludes(html, 'id="file-option-%40src%2F"');
	assertStringIncludes(html, 'role="option"');
	assertFalse(html.includes("<button"));
	assertFalse(html.includes("tabindex="));
});

test("slash picker uses pi fuzzy matching on command names", () => {
	const expression = slashPickerOpenExpression(
		appRenderSnapshot({
			slashCommands: [
				{ name: "login", description: "Log in", source: "system" },
				{ name: "skill:review", description: "Review code", source: "skill" },
			],
		}),
	);

	assertStringIncludes(expression, "$prompt.startsWith('/')");
	assertStringIncludes(expression, "!$prompt.includes(' ')");
	assertStringIncludes(expression, '["login","skill:review"].some');
	assertStringIncludes(
		expression,
		"window.piUi.pickers.fuzzyMatch($prompt.slice(1), name).matches",
	);
	assertFalse(expression.includes("log in system"));
	assertFalse(expression.includes("review code skill"));

	const emptyExpression = slashPickerOpenExpression(
		appRenderSnapshot({
			slashCommands: [],
		}),
	);
	assertStringIncludes(emptyExpression, "[].some");
});

test("session rows expose stable ids for resilient active descendants", () => {
	const path = `/sessions/a session.jsonl`;
	const html = renderSessionPicker(
		appRenderSnapshot({
			sessions: [
				{
					path,
					cwd: "/workspace",
					title: "Session",
					messageCount: 1,
					modified: "Today",
				},
			],
			currentSessionPath: undefined,
			sessionsHasMore: true,
		}),
	);
	assertStringIncludes(html, 'id="session-row-%2Fsessions%2Fa%20session.jsonl"');
	assertStringIncludes(html, 'src="/sessions/favicon?cwd=%2Fworkspace"');
	assertStringIncludes(html, "No matching sessions.");
	assertStringIncludes(html, "@post('/sessions/more'");
	assertStringIncludes(html, `data-show="$sessionSearch === ''"`);
	assertFalse(html.includes("data-session-rename-title"));
});

test("session picker formats numeric message counts", () => {
	for (const [messageCount, label] of [
		[0, "0 messages"],
		[1, "1 message"],
		[2, "2 messages"],
	] as const) {
		const html = renderSessionPicker(
			appRenderSnapshot({
				sessions: [
					{
						path: "/session",
						cwd: "/workspace",
						title: "Session",
						messageCount,
						modified: "Now",
					},
				],
			}),
		);
		assertStringIncludes(html, label);
	}
});

test("current running session is live but does not resume itself", () => {
	const path = "/sessions/current.jsonl";
	const html = renderSessionPicker(
		appRenderSnapshot({
			sessions: [
				{
					path,
					cwd: "/workspace",
					title: "Current session",
					messageCount: 1,
					modified: "Now",
				},
			],
			currentSessionPath: path,
			activityText: "Working...",
		}),
	);

	assertStringIncludes(html, 'aria-current="true"');
	assertStringIncludes(html, 'aria-label="Current session running"');
	assertStringIncludes(html, "@post('/sessions/rename'");
	assertStringIncludes(html, "@post('/abort'");
	assertFalse(html.includes("/sessions/resume"));
});

test("background sessions expose statuses and shortcuts", () => {
	const html = renderSessionPicker(
		appRenderSnapshot({
			sessions: [
				{
					path: "/sessions/running.jsonl",
					cwd: "/workspace",
					title: "Running session",
					messageCount: 1,
					modified: "Now",
					backgroundStatus: "running",
				},
				{
					path: "/sessions/completed.jsonl",
					cwd: "/workspace",
					title: "Completed session",
					messageCount: 2,
					modified: "Today",
					backgroundStatus: "completed",
				},
			],
			currentSessionPath: undefined,
		}),
	);

	assertStringIncludes(html, 'aria-label="Background session running"');
	assertStringIncludes(html, 'aria-label="Background session completed"');
	assertStringIncludes(html, '<kbd class="kbd">1</kbd>');
	assertStringIncludes(html, '<kbd class="kbd">2</kbd>');
	assertStringIncludes(html, "evt.code === 'Digit1'");
	// The picker owns ctrl+number while its dialog is open, using the filtered order.
	assertStringIncludes(html, "document.getElementById('session-dialog')?.open &&");
});

test("current idle session exposes deletion", () => {
	const path = "/sessions/current.jsonl";
	const html = renderSessionPicker(
		appRenderSnapshot({
			sessions: [
				{
					path,
					cwd: "/workspace",
					title: "Current session",
					messageCount: 1,
					modified: "Now",
				},
			],
			currentSessionPath: path,
		}),
	);

	assertStringIncludes(html, 'aria-label="Delete session Current session"');
	assertStringIncludes(html, "$sessionDeletePath");
});

test("workspace picker shows only the workspace folder name", () => {
	const nested = renderWorkspacePicker(
		appRenderSnapshot({
			workspacePath: "/home/user/Documents/Blenderanimation",
		}),
	);
	assertStringIncludes(nested, ">Blenderanimation</span>");
	assertStringIncludes(nested, 'aria-label="/home/user/Documents/Blenderanimation"');
	assertStringIncludes(nested, "$_workspaceAction = 'open'");

	const home = renderWorkspacePicker(
		appRenderSnapshot({
			workspacePath: os.homedir(),
		}),
	);
	assertStringIncludes(home, ">~</span>");
});

test("workspace rows show each collapsed path once", () => {
	const home = os.homedir();
	const html = renderWorkspaceDialogMenu(
		appRenderSnapshot({
			workspacePath: home,
			recentWorkspaces: [`${home}/projects/pi-ui`],
		}),
	);

	assertStringIncludes(html, ">~<");
	assertStringIncludes(html, ">~/projects/pi-ui<");
	assertStringIncludes(
		html,
		`src="/sessions/favicon?cwd=${encodeURIComponent(`${home}/projects/pi-ui`)}"`,
	);
	assertStringIncludes(html, 'aria-current="true"');
	assertFalse(
		new RegExp(`>\\s*${escapeRegExp(home)}(?:/projects/pi-ui)?\\s*<`).test(html),
	);
});

test("workspace browser navigates folders and opens the selected directory", () => {
	const html = renderWorkspaceBrowserContent({
		path: "/workspace",
		parent: "/",
		directories: ["/workspace/alpha"],
		showHidden: false,
	});

	assertStringIncludes(html, "Select folder");
	assertStringIncludes(html, "Open folder");
	assertStringIncludes(html, "Fork session");
	assertStringIncludes(html, "workspacePath: &#34;/workspace&#34;");
	assertStringIncludes(html, "/workspace/open");
	assertStringIncludes(html, "/sessions/fork-to-workspace");
	assertStringIncludes(html, "/workspace/browse");
	assertStringIncludes(html, ">alpha</span>");
	assertStringIncludes(html, "Show hidden");
});

test("workspace picker only opens existing workspace suggestions", () => {
	const html = renderWorkspaceDialogMenu(
		appRenderSnapshot({
			workspacePath: "/workspace",
			recentWorkspaces: [],
		}),
	);

	assertFalse(html.includes("Open typed path"));
	assertFalse(html.includes("data-empty"));
	assertStringIncludes(html, "Recent workspaces");
});

test("model picker distinguishes missing auth from an unselected model", () => {
	const withoutProvider = renderModelPicker(
		appRenderSnapshot({
			models: [],
			currentModel: undefined,
		}),
	);
	assertStringIncludes(withoutProvider, "no provider");
	assertStringIncludes(withoutProvider, "Log in to a provider");
	assertStringIncludes(withoutProvider, "/auth/open-login");
	assertFalse(withoutProvider.includes("dropdown-menu"));

	const withoutSelection = renderModelPicker(
		appRenderSnapshot({
			models: [
				{
					id: "claude-sonnet",
					provider: "anthropic",
					name: "Claude Sonnet",
					configured: true,
					scoped: false,
				},
			],
			currentModel: undefined,
		}),
	);
	assertStringIncludes(withoutSelection, "choose model");
	assertStringIncludes(withoutSelection, 'aria-label="Models"');
	assertStringIncludes(withoutSelection, "@post('/models/refresh', { payload: {} })");
	assertStringIncludes(withoutSelection, 'placeholder="Search models..."');
	assertStringIncludes(withoutSelection, "Claude Sonnet");
});

test("model picker refreshes keyboard state when it opens, not when it closes", () => {
	// Regression: the popover used to reset `.active`/aria-activedescendant only on
	// `evt.newState === 'closed'`, so a freshly-opened picker had no active row and a
	// bare Enter (before ever pressing an arrow key) silently did nothing — the user had
	// to reach for the mouse. `/model` with no argument (and Enter on the slash picker's
	// `/model` row) must let arrow keys + Enter select immediately on open.
	const html = renderModelPicker(
		appRenderSnapshot({
			models: [
				{
					id: "claude-sonnet",
					provider: "anthropic",
					name: "Claude Sonnet",
					configured: true,
					scoped: false,
				},
			],
			currentModel: "anthropic/claude-sonnet",
		}),
	);
	assertStringIncludes(html, "evt.newState === 'open'");
	assertStringIncludes(html, "window.piUi.modelPicker.reset(el)");
	assertFalse(html.includes("evt.newState === 'closed'"));
});

test("model picker is a dual-pane provider -> model picker", () => {
	const html = renderModelPicker(
		appRenderSnapshot({
			models: [
				{
					id: "claude-sonnet",
					provider: "anthropic",
					name: "Claude Sonnet",
					configured: true,
					scoped: false,
				},
				{
					id: "claude-haiku",
					provider: "anthropic",
					name: "Claude Haiku",
					configured: true,
					scoped: false,
				},
				{
					id: "gpt-5.6",
					provider: "openai-codex",
					name: "GPT 5.6",
					configured: false,
					scoped: false,
				},
			],
			currentModel: "anthropic/claude-sonnet",
		}),
	);

	// Provider pane: one row per provider, with a model count and current-provider marker.
	assertStringIncludes(html, 'id="model-provider-menu"');
	assertStringIncludes(html, 'aria-label="Providers"');
	assertStringIncludes(html, 'id="model-provider-9-anthropic"');
	assertStringIncludes(html, 'id="model-provider-12-openai-codex"');
	assertStringIncludes(html, 'data-provider="anthropic"');
	assertStringIncludes(html, 'aria-current="true"');
	assertStringIncludes(html, "2 models");
	assertStringIncludes(html, "1 model");
	assertStringIncludes(html, "no auth");

	// The current provider (backing the current model) gets the same visible
	// selection-dot marker as the current model row — not just a faint
	// aria-current attribute (audit: "only faintly highlighted").
	assertStringIncludes(
		html,
		'id="model-provider-9-anthropic" role="menuitem" class="model-option model-provider-option" data-preserve-attr="class" data-provider="anthropic" aria-current="true"',
	);
	assertStringIncludes(
		html,
		'</span><span class="selection-dot model-current-indicator" aria-hidden="true"></span></div><div id="model-provider-12-openai-codex"',
	);
	assertStringIncludes(
		html,
		'id="model-provider-12-openai-codex" role="menuitem" class="model-option model-provider-option" data-preserve-attr="class" data-provider="openai-codex" aria-current="false"',
	);
	assertStringIncludes(
		html,
		'<span class="selection-dot model-current-indicator" hidden aria-hidden="true"></span></div></div></div><div role="menu" id="model-select-menu"',
	);

	// Model pane: grouped by provider, one group per provider.
	assertStringIncludes(html, 'id="model-select-menu"');
	assertStringIncludes(html, 'data-provider-group="anthropic"');
	assertStringIncludes(html, 'data-provider-group="openai-codex"');
	assertStringIncludes(html, "Claude Sonnet");
	assertStringIncludes(html, "Claude Haiku");
	assertStringIncludes(html, "GPT 5.6");

	// The current model is pre-selected: its provider is the initial active provider/pane.
	assertStringIncludes(html, 'data-active-provider="anthropic"');
	assertStringIncludes(html, 'data-active-pane="models"');
	assertStringIncludes(html, 'data-multi-pane="true"');

	// Mobile drill-down needs a way back to the provider list.
	assertStringIncludes(html, "data-pane-back");
});

test("model rows show context-window and thinking badges from model metadata", () => {
	const html = renderModelPicker(
		appRenderSnapshot({
			models: [
				{
					id: "claude-sonnet",
					provider: "anthropic",
					name: "Claude Sonnet",
					configured: true,
					scoped: false,
					contextWindow: 200_000,
					reasoning: true,
				},
				{
					id: "gpt-5-mini",
					provider: "openai-codex",
					name: "GPT 5 mini",
					configured: true,
					scoped: false,
					contextWindow: 128_000,
					reasoning: false,
				},
				{
					id: "legacy-model",
					provider: "openai-codex",
					name: "Legacy",
					configured: true,
					scoped: false,
				},
			],
			currentModel: "anthropic/claude-sonnet",
		}),
	);

	// Context-window badge, formatted the same way prompt-status.tsx's usage bar does.
	assertStringIncludes(
		html,
		'<span class="badge model-meta-badge" data-variant="secondary" title="200k token context window">200k</span>',
	);
	assertStringIncludes(
		html,
		'<span class="badge model-meta-badge" data-variant="secondary" title="128k token context window">128k</span>',
	);
	// Thinking/reasoning badge, reusing the shared Brain icon (also used by the
	// thinking-level picker button).
	assertStringIncludes(
		html,
		'<span class="badge model-meta-badge model-thinking-badge" data-variant="secondary" title="Supports extended thinking" aria-label="Supports extended thinking">',
	);
	// A model with no context-window/reasoning metadata gets no badge wrapper at all.
	assertStringIncludes(html, 'data-model-id="legacy-model"');
	const legacyRowStart = html.indexOf('id="model-option-openai-codex%2Flegacy-model"');
	const legacyRowEnd = html.indexOf('id="model-group-body', legacyRowStart);
	assertFalse(html.slice(legacyRowStart, legacyRowEnd).includes("model-option-badges"));
});

test("model picker protects client-owned narrowing state from server re-renders", () => {
	// Regression (verifier fix pass): `applyActiveProvider()` (static/app/model-picker.js)
	// narrows the models pane by setting `hidden` on every non-active
	// `[data-provider-group]`, and `data-active-pane`/`data-active-provider`/
	// `data-searching` on the `.command` root track which pane/provider/search state is
	// live. None of this is server-rendered (the SSR markup below never sets `hidden` on
	// a provider group, nor `data-searching` at all), so without `data-preserve-attr`
	// Datastar's morph strips it back out on the next unrelated re-render of this dirty
	// region (e.g. another connected client changing the model, or this client toggling a
	// model's star) while the popover is still open — every provider's models reappear at
	// once and the active pane/provider/search flags silently reset. `.model-option` rows
	// a few lines below already guard themselves this way (`data-preserve-attr="class
	// hidden"`); the provider-group wrapper and the command root need the same guard.
	const html = renderModelPicker(
		appRenderSnapshot({
			models: [
				{
					id: "claude-sonnet",
					provider: "anthropic",
					name: "Claude Sonnet",
					configured: true,
					scoped: false,
				},
				{
					id: "gpt-5.6",
					provider: "openai-codex",
					name: "GPT 5.6",
					configured: false,
					scoped: false,
				},
			],
			currentModel: "anthropic/claude-sonnet",
		}),
	);

	assertStringIncludes(
		html,
		'data-provider-group="anthropic" data-preserve-attr="hidden"',
	);
	assertStringIncludes(
		html,
		'data-provider-group="openai-codex" data-preserve-attr="hidden"',
	);
	assertStringIncludes(
		html,
		'data-preserve-attr="data-active-pane data-active-provider data-searching"',
	);
});

test("model picker falls back to the providers pane with no model selected yet", () => {
	const html = renderModelPicker(
		appRenderSnapshot({
			models: [
				{
					id: "claude-sonnet",
					provider: "anthropic",
					name: "Claude Sonnet",
					configured: true,
					scoped: false,
				},
			],
			currentModel: undefined,
		}),
	);
	assertStringIncludes(html, 'data-active-pane="providers"');
	assertStringIncludes(html, 'data-active-provider="anthropic"');
});

test("provider names matching the picker's own fixed ids don't collide with them", () => {
	// A provider name comes from an extension's own registration and is arbitrary — a
	// provider literally named "menu" or "heading" must not produce
	// id="model-provider-menu"/id="model-provider-heading", which would collide with this
	// picker's own fixed `#model-provider-menu` (the whole providers pane) and
	// `#model-provider-heading` (the pane's own "Providers" heading).
	const html = renderModelPicker(
		appRenderSnapshot({
			models: [
				{
					id: "model-a",
					provider: "menu",
					name: "Model A",
					configured: true,
					scoped: false,
				},
				{
					id: "model-b",
					provider: "heading",
					name: "Model B",
					configured: true,
					scoped: false,
				},
			],
			currentModel: "menu/model-a",
		}),
	);
	// The fixed ids still appear exactly once each (the picker's own static elements).
	assertEquals(countOccurrences(html, 'id="model-provider-menu"'), 1);
	assertEquals(countOccurrences(html, 'id="model-provider-heading"'), 1);
	// The two providers get distinct, non-colliding derived ids instead.
	assertStringIncludes(html, 'id="model-provider-4-menu"');
	assertStringIncludes(html, 'id="model-provider-7-heading"');
	assertStringIncludes(html, 'id="model-group-body-4-menu"');
	assertStringIncludes(html, 'id="model-group-body-7-heading"');
	assertStringIncludes(html, 'id="model-group-4-menu"');
	assertStringIncludes(html, 'id="model-group-7-heading"');
});

test("model picker shows only the final model name in its trigger", () => {
	const html = renderModelPicker(
		appRenderSnapshot({
			models: [
				{
					id: "deepseek-ai/DeepSeek-R1",
					provider: "huggingface",
					name: "DeepSeek R1",
					configured: true,
					scoped: false,
				},
			],
			currentModel: "huggingface/deepseek-ai/DeepSeek-R1",
		}),
	);

	assertStringIncludes(html, ">DeepSeek-R1</span>");
	assertStringIncludes(html, ">deepseek-ai/DeepSeek-R1</span>");
});

test("thinking picker describes every supported maximum level", () => {
	const html = renderThinkingPicker(
		appRenderSnapshot({
			thinkingLevel: "max",
			thinkingLevels: ["xhigh", "max"],
		}),
	);

	assertStringIncludes(html, "Extra-high reasoning");
	assertStringIncludes(html, "Maximum reasoning");
});

test("file picker fragments escape dynamic values and expose list semantics", () => {
	const html = renderFilePickerResults([
		{
			value: `@src/"<unsafe>.ts`,
			label: `<unsafe>.ts`,
			description: `src/<unsafe>.ts`,
		},
	]);
	assertStringIncludes(html, 'id="file-picker-results"');
	assertStringIncludes(html, 'role="listbox"');
	assertStringIncludes(html, 'role="option"');
	assertStringIncludes(html, "&lt;unsafe&gt;.ts");
	assertStringIncludes(html, "src/&lt;unsafe&gt;.ts");
});

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test("prompt pickers toggle `hidden` (not data-show) so their exit can play", () => {
	const html = renderPromptBox(appRenderSnapshot({}));
	for (const id of [
		"prompt-slash-popover",
		"prompt-file-popover",
		"prompt-argument-popover",
	]) {
		const start = html.indexOf(`id="${id}"`);
		const tag = html.slice(start, html.indexOf(">", start));
		assertStringIncludes(tag, " hidden");
		assertStringIncludes(tag, "data-attr:hidden=");
		assertFalse(tag.includes("data-show"));
		assertFalse(tag.includes("display: none"));
	}
	assertStringIncludes(html, 'data-attr:hidden="!($_filePickerOpen)"');
});

test("Enter-send holds the transcript spacer before clearing; /copy does not", () => {
	const html = renderPromptBox(appRenderSnapshot({}));
	const copy = html.indexOf("if ($prompt.trim() === '/copy')");
	const hold = html.indexOf("window.piUi.messageScroll.holdSpacerForSend?.();");
	const copyReturn = html.indexOf("return;", copy);
	assertEquals(copy >= 0 && hold > copyReturn, true);
	assertEquals(hold < html.indexOf("window.piUi.prompt.clear();", hold), true);
});

test("queued messages are keyed: identical texts get distinct occurrence suffixes", () => {
	const html = renderPromptQueue(
		appRenderSnapshot({
			queuedSteeringMessages: ["same", "same"],
			queuedFollowUpMessages: ["same"],
		}),
	);
	assertStringIncludes(html, 'id="prompt-queue-list"');
	assertStringIncludes(html, `id="${queueItemId("steer", "same", 0)}"`);
	assertStringIncludes(html, `id="${queueItemId("steer", "same", 1)}"`);
	assertStringIncludes(html, `id="${queueItemId("followUp", "same", 0)}"`);
	assertEquals(queueItemId("steer", "same", 1).endsWith("-1"), true);
	assertFalse(queueItemId("steer", "a", 0) === queueItemId("steer", "b", 0));
});

test("the queue ✕ posts at once, blocks a second tap, and leaves the exit to the ghost", () => {
	const html = renderPromptQueue(appRenderSnapshot({ queuedSteeringMessages: ["hi"] }));
	const remove = html.slice(
		html.indexOf("data-on:click", html.indexOf("prompt-queue-text")),
	);
	// The guard is keyed by id: a streaming morph cannot clear it (it keeps `data-exit` too).
	assertStringIncludes(remove, "if (removing.has(item.id)) return;");
	assertStringIncludes(remove, "setAttribute('data-exit', 'down')");
	assertStringIncludes(html, 'data-preserve-attr="data-exit"');
	assertStringIncludes(remove, "@post('/prompt/queue/remove'");
	assertFalse(remove.includes("fill:'forwards'"));
	assertFalse(remove.includes(".finished"));
	// "Restore all" tells prompt-motion.js to ghost the items down into the composer.
	assertStringIncludes(html, "pi-ui-queue-restore");
});

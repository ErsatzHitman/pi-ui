import { test } from "bun:test";

import { assertStringIncludes } from "#testing/assertions";

import type { PiUiElement } from "../extension-surface-types.ts";
import { assertStringExcludes } from "../testing/assertions.ts";
import { renderPage } from "./page.tsx";
import {
	renderPiUiElement,
	renderPiUiSheets,
	renderPiUiWidgets,
} from "./pi-ui-elements.tsx";
import { appRenderSnapshot } from "./test-fixtures.ts";

function element(overrides: Partial<PiUiElement>): PiUiElement {
	return {
		id: "panel",
		ns: "ask-user",
		kind: "panel",
		placement: "sheet",
		data: {},
		revision: 1,
		openGeneration: 1,
		updatedAt: 0,
		...overrides,
	};
}

test("the page shell mounts the PIUI widget area and sheet host", () => {
	const page = renderPage({ ...appRenderSnapshot({}), messages: [] });
	assertStringIncludes(page, 'id="piui-widgets"');
	assertStringIncludes(page, 'id="piui-sheets"');
});

test("sheets keep their open state across morphs and reply close on dismiss", () => {
	const html = renderPiUiSheets({ extensionElements: [element({})] });
	assertStringIncludes(html, 'data-preserve-attr="open"');
	assertStringIncludes(html, "actionId: &#34;close&#34;");
});

test("the sheet host reports the browser's real color scheme once and on change (m9)", () => {
	const html = renderPiUiSheets({ extensionElements: [] });
	assertStringIncludes(html, "prefers-color-scheme: dark");
	assertStringIncludes(html, "/extensions/ui/color-scheme");
	assertStringIncludes(html, "mql.addEventListener");
});

test("the widget strip renders both the full list and a one-line summary, and the summary opens Live Workspace Extensions (m12)", () => {
	const widget = element({
		id: "w1",
		kind: "widget",
		placement: "pinned",
		title: "Build status",
		data: { lines: ["compiling"] },
	});
	const html = renderPiUiWidgets({ extensionElements: [widget] });
	assertStringIncludes(html, 'class="piui-widgets-list"');
	assertStringIncludes(html, 'class="btn piui-widgets-summary"');
	// A single element's summary shows its own title rather than a bare count.
	assertStringIncludes(html, "Build status");
	assertStringIncludes(html, "liveWorkspacePreferences.tab = 'extensions'");
});

test("the widget summary falls back to a count for more than one element", () => {
	const html = renderPiUiWidgets({
		extensionElements: [
			element({
				id: "w1",
				kind: "widget",
				placement: "pinned",
				data: { lines: [] },
			}),
			element({
				id: "w2",
				kind: "widget",
				placement: "inline",
				data: { lines: [] },
			}),
		],
	});
	assertStringIncludes(html, "2 extension updates");
});

test("the widget strip renders nothing (not even the summary) when there are no widgets", () => {
	const html = renderPiUiWidgets({ extensionElements: [] });
	assertStringExcludes(html, "piui-widgets-summary");
	assertStringExcludes(html, "piui-widgets-list");
});

test("a sheet with no body content shows an empty/loading state instead of blank space", () => {
	const html = renderPiUiSheets({
		extensionElements: [element({ kind: "panel", placement: "sheet", data: {} })],
	});
	assertStringIncludes(html, "piui-sheet-empty");
	assertStringIncludes(html, "Waiting for content");
});

test("a sheet with body content does not show the empty state", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				kind: "panel",
				placement: "sheet",
				data: { sections: [{ kind: "status", text: "hello" }] },
			}),
		],
	});
	assertStringExcludes(html, "piui-sheet-empty");
});

test("a sheet focuses its first field or action once it opens", () => {
	const html = renderPiUiSheets({ extensionElements: [element({})] });
	assertStringIncludes(html, "addEventListener('toggle'");
	assertStringIncludes(
		html,
		"input:not([type=checkbox]), textarea, select, .piui-actions .btn",
	);
});

test("forms without a submit action get one carrying valid signal references", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				data: { fields: [{ id: "selection", kind: "text", label: "Pick" }] },
			}),
		],
	});
	assertStringIncludes(html, ">Submit</button>");
	// Signal names must be identifiers (no `-` from the `ask-user` namespace) and be
	// referenced with `$` so Datastar reads the bound value.
	assertStringIncludes(html, "$_piuiField_ask_user_panel_selection");
	assertStringExcludes(html, "_piuiField_ask-user");
});

test("nested form sections render their fields and actions once", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				ns: "btw",
				placement: "screen",
				data: {
					sections: [
						{
							kind: "form",
							fields: [{ id: "q", kind: "text", label: "Ask btw" }],
							actions: [
								{ id: "submit", label: "Send", variant: "primary" },
							],
						},
					],
				},
			}),
		],
	});
	assertStringIncludes(html, "Ask btw");
	assertStringIncludes(html, ">Send</button>");
	assertStringIncludes(html, "$_piuiField_btw_panel_q");
});

test("every sheet gets one header close control instead of a footer Close fallback (btw-compact)", () => {
	const html = renderPiUiSheets({ extensionElements: [element({})] });
	// The header close button (native `command=\"close\"`, same mechanism the old footer
	// fallback used) is the sheet's only close control now — no separate "Close" text button.
	assertStringIncludes(html, 'aria-label="Close"');
	assertStringIncludes(html, 'command="close"');
	assertStringExcludes(html, ">Close</button>");
});

test("a sheet whose element declares its own 'close' action does not duplicate the header close control (fix pass, pi-mcp-adapter's mcp-setup-panel)", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				ns: "mcp",
				actions: [
					{ id: "run-setup", label: "Run setup" },
					{ id: "close", label: "Close" },
				],
			}),
		],
	});
	// Exactly one close control — the header icon button. The extension's own declared
	// `close` action must not also render as a redundant footer "Close" text button.
	assertStringIncludes(html, 'aria-label="Close"');
	assertStringExcludes(html, ">Close</button>");
	// Its other declared actions still render in the footer as usual.
	assertStringIncludes(html, ">Run setup</button>");
});

test("a sheet with no declared actions renders no footer at all (btw-compact)", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({ data: { sections: [{ kind: "status", text: "hello" }] } }),
		],
	});
	assertStringExcludes(html, "<footer>");
});

test("an action with an icon renders as an icon-only button, not a labeled one (btw-compact)", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				ns: "btw",
				placement: "screen",
				data: {
					sections: [
						{
							kind: "form",
							fields: [{ id: "q", kind: "text", placeholder: "Ask btw…" }],
							actions: [
								{
									id: "submit",
									label: "Send",
									variant: "primary",
									icon: "send",
								},
							],
						},
					],
				},
			}),
		],
	});
	assertStringIncludes(html, 'aria-label="Send"');
	assertStringExcludes(html, ">Send</button>");
});

test("a text field submits on Enter without a surrounding <form> (btw-compact)", () => {
	const html = renderPiUiSheets({
		extensionElements: [element({ data: { fields: [{ id: "q", kind: "text" }] } })],
	});
	assertStringIncludes(html, "evt.key === 'Enter'");
	assertStringIncludes(html, ".piui-actions .btn");
});

test("a text field without a visible label still gets an accessible name from its placeholder (btw-compact)", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				data: { fields: [{ id: "q", kind: "text", placeholder: "Ask btw…" }] },
			}),
		],
	});
	assertStringIncludes(html, 'aria-label="Ask btw…"');
});

test("a 'turns' section renders a compact chat without '› you'/'› btw' markdown headers (btw-compact)", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				ns: "btw",
				placement: "screen",
				data: {
					sections: [
						{
							kind: "turns",
							turns: [
								{ role: "user", text: "Hi. What is going on" },
								{ role: "assistant", text: "Not much." },
							],
						},
					],
				},
			}),
		],
	});
	assertStringIncludes(html, "piui-turn-user");
	assertStringIncludes(html, "piui-turn-assistant");
	assertStringIncludes(html, "Hi. What is going on");
	assertStringIncludes(html, "Not much.");
	assertStringExcludes(html, "› you");
	assertStringExcludes(html, "› btw");
	assertStringExcludes(html, "**");
});

test("a 'turns' section carries the role in an sr-only label for assistive tech", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				ns: "btw",
				title: "btw",
				placement: "screen",
				data: {
					sections: [{ kind: "turns", turns: [{ role: "user", text: "hi" }] }],
				},
			}),
		],
	});
	assertStringIncludes(html, 'class="sr-only"');
});

test("a 'meta' section renders one muted line", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				data: {
					sections: [
						{
							kind: "meta",
							text: "openai-codex/gpt-5.6-sol · Thinking: high",
						},
					],
				},
			}),
		],
	});
	assertStringIncludes(html, "piui-panel-meta");
	assertStringIncludes(html, "openai-codex/gpt-5.6-sol · Thinking: high");
});

test("actions send the namespaced elementId lib/bridge.ts expects", () => {
	const html = renderPiUiSheets({ extensionElements: [element({})] });
	// `lib/bridge.ts` derives the namespace as `elementId.split(":")[0]`; a
	// bare `element.id` would misroute the namespace-scoped `piui:<ns>` event.
	assertStringIncludes(html, "elementId: &#34;ask-user:panel&#34;");
});

// ask-user.ts's `buildBridgeFields()` sends a `select`/`multiselect` field with
// `options: [{ value, label, description }]` and `searchable: true` once its own
// `bridgeIsLive()` is fixed (round ux/ask-user-native) — these render it as a
// native selectable-rows-with-filter list, not a bare `<select>`, so the option
// descriptions the extension sends are not silently dropped.
test("a searchable select field renders option descriptions and a filter box, as radio rows sharing one name", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				data: {
					fields: [
						{
							id: "selection",
							kind: "select",
							label: "Where to next?",
							placeholder: "Type to filter...",
							searchable: true,
							options: [
								{
									value: "career",
									label: "Career or education",
									description: "Jobs, school, skills",
								},
								{ value: "health", label: "Health", description: "" },
							],
						},
					],
				},
			}),
		],
	});
	assertStringIncludes(html, "Career or education");
	assertStringIncludes(html, "Jobs, school, skills");
	assertStringIncludes(html, 'placeholder="Type to filter..."');
	assertStringIncludes(html, 'type="radio"');
	// Both rows share one `name` so the browser's native radio-group arrow-key
	// navigation moves between them without any client-side JS.
	assertStringIncludes(html, 'name="_piuiField_ask_user_panel_selection_options"');
	assertStringExcludes(html, "<select");
});

// ask-user.ts titles its sheet with the question and labels the options field with the
// same question; showing it twice read as bloat (ux merge). The label stays for
// assistive tech, visually hidden; a label that differs from the title stays visible.
test("a field label that repeats the sheet title is visually hidden, not dropped", () => {
	const question = "Where should we focus next?";
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				title: `${question} (1/2)`,
				data: {
					fields: [
						{
							id: "selection",
							kind: "select",
							label: question,
							searchable: true,
							options: [
								{
									value: "health",
									label: "Health",
									description: "Sleep",
								},
							],
						},
						{
							id: "picks",
							kind: "multiselect",
							label: question,
							options: [{ value: "a", label: "A", description: "first" }],
						},
						{ id: "freeform", kind: "text", label: "Custom answer" },
					],
				},
			}),
		],
	});
	assertStringIncludes(html, `<label class="sr-only">${question}</label>`);
	assertStringIncludes(html, `<legend class="sr-only">${question}</legend>`);
	assertStringIncludes(
		html,
		'<label for="piui-field-ask-user-panel-freeform">Custom answer</label>',
	);
});

test("a select field with no description and not marked searchable stays a plain select (no filter box, no regression for other bridge callers)", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				ns: "todo",
				data: {
					fields: [
						{
							id: "status",
							kind: "select",
							label: "Status",
							options: [{ id: "open", label: "Open" }],
						},
					],
				},
			}),
		],
	});
	assertStringIncludes(html, "<select");
	assertStringExcludes(html, 'type="search"');
	assertStringExcludes(html, 'type="radio"');
});

test("a searchable multiselect field renders option descriptions and a filter box alongside its checkboxes", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				data: {
					fields: [
						{
							id: "selections",
							kind: "multiselect",
							label: "Pick any",
							placeholder: "Type to filter...",
							searchable: true,
							options: [
								{ value: "a", label: "Option A", description: "First" },
								{ value: "b", label: "Option B", description: "Second" },
							],
						},
					],
				},
			}),
		],
	});
	assertStringIncludes(html, "Option A");
	assertStringIncludes(html, "First");
	assertStringIncludes(html, 'placeholder="Type to filter..."');
	assertStringIncludes(html, 'type="checkbox"');
});

test("the select/multiselect filter hides rows whose label and description do not match, client-side, via data-show", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				data: {
					fields: [
						{
							id: "selection",
							kind: "select",
							label: "Q",
							searchable: true,
							options: [
								{ value: "career", label: "Career", description: "Jobs" },
							],
						},
					],
				},
			}),
		],
	});
	// The row's own visibility expression checks the filter signal against its
	// own label/description text, case-insensitively, entirely in the browser.
	assertStringIncludes(html, "data-show=");
	assertStringIncludes(html, "toLocaleLowerCase");
});

test("a pinned roster renders as a compact summary strip, not a full row list", () => {
	const html = renderPiUiWidgets({
		extensionElements: [
			element({
				id: "fleet",
				kind: "roster",
				placement: "pinned",
				title: "Fleet",
				data: {
					rows: [
						{ id: "s1", label: "scout", status: "running" },
						{ id: "s2", label: "writer", status: "idle" },
					],
				},
			}),
		],
	});
	assertStringIncludes(html, "piui-summary");
	assertStringIncludes(html, "2 items");
	assertStringIncludes(html, "1 running");
	assertStringIncludes(html, ">Open</button>");
	// The full per-row list belongs to the Live Workspace Extensions tab, not this strip.
	assertStringExcludes(html, "piui-roster-row");
	// Sessions and Live Workspace are mutually exclusive (sidebar-exclusive): this "Open"
	// button opens Live Workspace, so it must also close Sessions if it's open.
	assertStringIncludes(html, "$_liveWorkspaceOpen = true;");
	assertStringIncludes(html, "getElementById('session-sidebar')");
});

test("a pinned progress element keeps its one-line bar inside the summary strip", () => {
	const html = renderPiUiWidgets({
		extensionElements: [
			element({
				id: "job",
				kind: "progress",
				placement: "pinned",
				data: { current: 3, total: 10 },
			}),
		],
	});
	assertStringIncludes(html, "piui-summary");
	assertStringIncludes(html, "piui-progress-track");
});

test("an inline widget with many lines starts collapsed", () => {
	const short = renderPiUiElement(
		element({
			id: "short",
			kind: "widget",
			placement: "inline",
			data: { lines: ["a", "b", "c"] },
		}),
	);
	assertStringExcludes(short, "<details");

	const long = renderPiUiElement(
		element({
			id: "long",
			kind: "widget",
			placement: "inline",
			data: { lines: ["a", "b", "c", "d", "e", "f", "g"] },
		}),
	);
	assertStringIncludes(long, "<details");
	assertStringIncludes(long, "7 lines");
});

test("roster rows render detail and per-row actions replying with the row id", () => {
	const html = renderPiUiElement(
		element({
			ns: "subagents",
			id: "roster",
			kind: "roster",
			placement: "pinned",
			data: {
				rows: [
					{
						id: "s1",
						label: "<b>scout</b>",
						state: "running",
						detail: "d1 · 12 tokens",
						actions: [{ id: "kill", label: "Kill", variant: "danger" }],
					},
				],
			},
		}),
	);
	assertStringIncludes(html, "d1 · 12 tokens");
	assertStringIncludes(html, 'data-variant="destructive"');
	assertStringIncludes(html, "{&#34;id&#34;:&#34;s1&#34;}");
	assertStringExcludes(html, "<b>scout</b>");
});

// UX audit: btw's composer lost keyboard focus after every send — a new turns/status
// section shifted the id-less form section, so the morph rebuilt the <input> instead of
// keeping it. A stable per-element, per-field id lets the morph keep the focused field.
test("text and textarea fields carry a stable id (and a label pointing at it) so a morph keeps the focused field", () => {
	const render = () =>
		renderPiUiSheets({
			extensionElements: [
				element({
					ns: "btw",
					data: {
						fields: [
							{ id: "q", kind: "text", label: "Ask" },
							{ id: "comment", kind: "textarea", label: "Extra context" },
						],
					},
				}),
			],
		});
	const html = render();
	assertStringIncludes(html, 'id="piui-field-btw-panel-q"');
	assertStringIncludes(html, 'for="piui-field-btw-panel-q"');
	assertStringIncludes(html, 'id="piui-field-btw-panel-comment"');
	assertStringIncludes(html, 'for="piui-field-btw-panel-comment"');
	assertStringIncludes(render(), 'id="piui-field-btw-panel-q"');
});

// UX audit: the plan asks for btw's composer to be ONE input row with an inline send icon;
// the icon button used to wrap onto its own row under the input.
test("a form section with one single-line field and only icon actions lays out as one inline composer row", () => {
	const composer = (
		actions: unknown[],
		fields: unknown[] = [{ id: "q", kind: "text" }],
	) =>
		renderPiUiSheets({
			extensionElements: [
				element({
					ns: "btw",
					data: { sections: [{ kind: "form", id: "c", fields, actions }] },
				}),
			],
		});
	const send = { id: "submit", label: "Send", variant: "primary", icon: "send" };
	const stop = { id: "cancel", label: "Stop", icon: "stop" };
	assertStringIncludes(
		composer([send, stop]),
		'class="piui-panel-section piui-panel-form piui-composer-row"',
	);
	assertStringExcludes(
		composer([{ id: "submit", label: "Send" }]),
		"piui-composer-row",
	);
	assertStringExcludes(
		composer([send], [{ id: "q", kind: "textarea" }]),
		"piui-composer-row",
	);
});

// With the composer's <input> now kept across morphs (stable id), nothing reset it after a
// send any more — the next message was appended to the previous one. Sending clears it.
test("a composer's primary (send) action clears its field after posting; its stop action keeps the draft", () => {
	const html = renderPiUiSheets({
		extensionElements: [
			element({
				ns: "btw",
				data: {
					sections: [
						{
							kind: "form",
							id: "c",
							fields: [{ id: "q", kind: "text" }],
							actions: [
								{
									id: "submit",
									label: "Send",
									variant: "primary",
									icon: "send",
								},
								{
									id: "cancel",
									label: "Stop",
									variant: "secondary",
									icon: "stop",
								},
							],
						},
					],
				},
			}),
		],
	});
	const clear = "$_piuiField_btw_panel_q = ''";
	const send = html.slice(
		html.indexOf('aria-label="Send"') - 600,
		html.indexOf('aria-label="Send"'),
	);
	const stop = html.slice(
		html.indexOf('aria-label="Send"'),
		html.indexOf('aria-label="Stop"'),
	);
	assertStringIncludes(send, clear);
	assertStringExcludes(stop, clear);
});

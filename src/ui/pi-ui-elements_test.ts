import { test } from "bun:test";

import { assertStringIncludes } from "#testing/assertions";

import type { PiUiElement } from "../extension-surface-types.ts";
import { assertStringExcludes } from "../testing/assertions.ts";
import { renderPage } from "./page.tsx";
import { renderPiUiElement, renderPiUiSheets } from "./pi-ui-elements.tsx";
import { appRenderSnapshot } from "./test-fixtures.ts";

function element(overrides: Partial<PiUiElement>): PiUiElement {
	return {
		id: "panel",
		ns: "ask-user",
		kind: "panel",
		placement: "sheet",
		data: {},
		revision: 1,
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
				actions: [{ id: "close", label: "Close" }],
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
	// The element declares its own close action, so the built-in Close button is omitted.
	assertStringExcludes(html, 'command="close"');
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

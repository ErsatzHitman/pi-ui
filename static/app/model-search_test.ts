import { test } from "bun:test";

import { fuzzyFilter } from "@earendil-works/pi-tui/dist/fuzzy.js";

import { assertEquals } from "#testing/assertions";

import { modelSearchText, orderProviderGroups } from "./model-search.js";

test("model search ranks DeepSeek above Claude Sonnet for ds4", () => {
	const models = [
		{
			id: "claude-sonnet-4",
			provider: "opencode",
			name: "Claude Sonnet 4",
		},
		{
			id: "deepseek-v4-flash",
			provider: "opencode",
			name: "DeepSeek V4 Flash",
		},
	];
	assertEquals(
		fuzzyFilter(models, "ds4", (model) =>
			modelSearchText(model.id, model.provider, model.name),
		),
		[models[1], models[0]],
	);
});

test("model search matches provider and combined provider/model terms", () => {
	const model = { id: "gpt-5.6", provider: "openai-codex", name: "GPT 5.6" };
	const search = (item: typeof model) =>
		modelSearchText(item.id, item.provider, item.name);
	assertEquals(fuzzyFilter([model], "opai g56", search), [model]);
	assertEquals(fuzzyFilter([model], "openai-codex/gpt-5.6", search), [model]);
});

test("a model search puts the best match's provider group first", () => {
	// Regression: the dual-pane picker groups rows by provider, so the first visible row
	// (the one Enter picks) came from the first provider in server order even when a
	// later provider held the best match — "scripted" + Enter chose Claude Opus.
	const appended: string[] = [];
	const parent = { append: (group: { name: string }) => appended.push(group.name) };
	const group = (name: string) => ({ name, parentElement: parent });
	const anthropic = group("anthropic");
	const fake = group("pi-ui-fake-stream");
	const row = (owner: ReturnType<typeof group>) => ({ closest: () => owner });
	orderProviderGroups([row(fake), row(anthropic), row(fake)] as unknown as Element[]);
	assertEquals(appended, ["pi-ui-fake-stream", "anthropic"]);
});

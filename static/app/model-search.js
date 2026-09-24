import { fuzzyFilter } from "@earendil-works/pi-tui/dist/fuzzy.js";

import { getModelSelectorSearchText } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/model-search.js";
import { refreshControls } from "./controls.js";
import { applyActiveProvider } from "./model-picker.js";

export function filterModelSearch(input, query) {
	if (!(input instanceof HTMLInputElement)) return;
	const command = input.closest(".command");
	if (!(command instanceof HTMLElement)) return;
	// Only the models pane is searched — the picker's dual-pane layout narrows the
	// models pane to one provider at a time, but a query searches across ALL of them
	// (grouped by provider, per `[data-provider-group]`), not just the active one.
	const menu = command.querySelector('[data-pane="models"]') ?? command;
	const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(
		(item) => item instanceof HTMLElement,
	);
	const originalItems = items.toSorted(
		(first, second) =>
			Number(first.dataset.modelSearchOrder) -
			Number(second.dataset.modelSearchOrder),
	);
	const searching = query.trim() !== "";
	const matches = fuzzyFilter(originalItems, query, (item) =>
		modelSearchText(
			item.dataset.modelId ?? "",
			item.dataset.modelProvider ?? "",
			item.dataset.modelName ?? "",
		),
	);
	const visible = new Set(matches);
	const orderedItems = searching
		? [...matches, ...originalItems.filter((item) => !visible.has(item))]
		: originalItems;

	for (const item of orderedItems) {
		item.hidden = !visible.has(item);
		item.parentElement?.append(item);
	}

	orderProviderGroups(searching ? matches : originalItems);

	command.dataset.searching = searching ? "true" : "false";
	if (searching) {
		// Reveal every provider's group that still has a visible match; empty groups
		// (and their heading) stay hidden so a narrow query doesn't leave blank headers.
		command.dataset.activePane = "models";
		for (const group of command.querySelectorAll("[data-provider-group]")) {
			group.hidden = ![...group.querySelectorAll('[role="menuitem"]')].some(
				(item) => !item.hidden,
			);
		}
	} else {
		applyActiveProvider(command);
	}
	refreshControls(command);
}

/**
 * Orders the `[data-provider-group]` groups by the first of `items` each one holds: the
 * best match's group first while searching (so the row Enter picks, the first visible
 * one, is the best match rather than the first provider's weaker one), server order
 * (`items` sorted by `data-model-search-order`) once the query is cleared.
 */
export function orderProviderGroups(items) {
	const groups = [];
	for (const item of items) {
		const group = item.closest("[data-provider-group]");
		if (group && !groups.includes(group)) groups.push(group);
	}
	for (const group of groups) group.parentElement?.append(group);
}

export function modelSearchText(id, provider, name) {
	// Preserve camel-case boundaries that pi's case-insensitive matcher cannot see.
	const expandedName = name.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2");
	return `${expandedName} ${id} ${provider} ${name} ${getModelSelectorSearchText({ id, provider, name })}`;
}

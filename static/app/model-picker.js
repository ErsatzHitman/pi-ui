import { activateCommandItem } from "./controls.js";

/**
 * Drives the model picker's dual-pane behaviour (`src/ui/prompt-pickers.tsx`
 * `renderModelPicker`): a providers pane on the left, that provider's models on the
 * right, `data-active-pane`/`data-active-provider` on the `.command` root say which
 * pane has keyboard focus and which provider's model group is showing. `controls.js`
 * owns generic `.command` keyboard movement (arrows/Enter/Home/End) and ArrowLeft/
 * ArrowRight pane switching for any `data-multi-pane` command; this module only knows
 * what a provider row *means* — narrowing the models pane to that provider's group.
 */

function commandOf(el) {
	return el instanceof Element ? el.closest(".command") : null;
}

function providerGroups(command) {
	return [...command.querySelectorAll("[data-provider-group]")];
}

function providerRows(command) {
	return [...command.querySelectorAll('[role="menuitem"][data-provider]')];
}

function modelRowsFor(command, provider) {
	const group = command.querySelector(
		`[data-provider-group="${CSS.escape(provider)}"]`,
	);
	return group ? [...group.querySelectorAll('[role="menuitem"]')] : [];
}

function visible(items) {
	return items.filter((item) => !item.hidden);
}

/** The row search would land on for "select the current one, else the first". */
function preferred(items) {
	return items.find((item) => item.getAttribute("aria-current") === "true") ?? items[0];
}

/**
 * Shows only the active provider's group of models. While searching (`data-searching`)
 * every group with a match is shown instead — see `model-search.js`, which owns
 * `data-searching` and calls this once a cleared query hands narrowing back to the
 * active provider.
 */
export function applyActiveProvider(command) {
	if (command.dataset.searching === "true") return;
	const active = command.dataset.activeProvider;
	for (const group of providerGroups(command)) {
		group.hidden = group.dataset.providerGroup !== active;
	}
}

function markCurrentProviderRow(command) {
	const active = command.dataset.activeProvider;
	for (const row of providerRows(command)) {
		row.setAttribute(
			"aria-current",
			row.dataset.provider === active ? "true" : "false",
		);
	}
}

/** `data-on:click` on a providers-pane row: narrows the models pane to that provider
 * and drills into it (both the mouse path and, via `controls.js`'s ArrowRight -> click
 * on the active row, the keyboard path). */
export function selectProvider(el, provider) {
	const command = commandOf(el);
	if (!command) return;
	command.dataset.activeProvider = provider;
	command.dataset.activePane = "models";
	markCurrentProviderRow(command);
	applyActiveProvider(command);
	activateCommandItem(command, preferred(visible(modelRowsFor(command, provider))));
}

/** `data-on:click` on the "← Providers" back button (also `controls.js`'s
 * ArrowLeft from the models pane): returns to the providers pane without losing which
 * provider was active. */
export function back(el) {
	const command = commandOf(el);
	if (!command) return;
	command.dataset.activePane = "providers";
	activateCommandItem(command, preferred(visible(providerRows(command))));
}

/**
 * `data-on:beforetoggle` on `#model-select-popover`, `evt.newState === 'open'`.
 * Regression fix: the popover used to refresh `.active`/`aria-activedescendant` only
 * when it *closed*, so a freshly opened picker had nothing active and a bare Enter did
 * nothing until the user first pressed an arrow key. Re-derives panes from the
 * server-rendered defaults (`data-active-pane`, `data-active-provider`, `aria-current`)
 * every open, so `/model` (and the slash picker's `/model` row) land on the current
 * provider + model, ready for arrows/Enter immediately.
 */
export function reset(popover) {
	const command = popover.querySelector(".command");
	if (!command) return;
	command.dataset.searching = "false";
	markCurrentProviderRow(command);
	applyActiveProvider(command);
	const pane = command.dataset.activePane === "providers" ? "providers" : "models";
	const items =
		pane === "providers"
			? visible(providerRows(command))
			: visible(modelRowsFor(command, command.dataset.activeProvider));
	activateCommandItem(command, preferred(items));
}

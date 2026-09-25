import { activateCommandItem } from "./controls.js";
import { duration, easing, reducedMotion } from "./motion.js";

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
 * Which pane `reset()` should land the popover on. Bug (fix pass 1, item 6): with a
 * single provider (`renderModelPicker`, prompt-pickers.tsx, skips the whole providers
 * pane — `providers.length > 1` — so it never renders any `[role="menuitem"][data-provider]`
 * rows) and no current model yet, the old `hasCurrent ? "models" : "providers"` always
 * chose "providers" in that case: `reset()` then asked for `visible(providerRows(command))`,
 * an always-empty list since the pane doesn't exist, so `preferred([])` was `undefined` and
 * nothing became active — a bare Enter did nothing. Falling back to "models" whenever there
 * is no providers pane to land on (regardless of `hasCurrent`) fixes it: `reset()`'s own
 * `preferred(visible(modelRowsFor(...)))` then picks the first model row.
 */
export function resolveActivePane(hasCurrent, hasProvidersPane) {
	if (!hasProvidersPane) return "models";
	return hasCurrent ? "models" : "providers";
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

/**
 * Phone width only (prompt-pickers.css shows one pane at a time below 30rem): a drill is a
 * pane change, so the incoming pane slides a short 8% in from its side; arrowing within a
 * pane stays instant. Not while searching (a single-pane result list). WAAPI on a user
 * action, not `@starting-style`, which would also fire on every popover open and every
 * time search clears.
 */
export function drillIn(command, selector, fromX) {
	if (command.dataset.multiPane !== "true" || command.dataset.searching === "true")
		return;
	if (globalThis.matchMedia?.("(width <= 30rem)").matches !== true) return;
	const pane = command.querySelector(selector);
	if (!(pane instanceof HTMLElement)) return;
	const reduce = reducedMotion();
	pane.animate(
		reduce
			? [{ opacity: 0 }, { opacity: 1 }]
			: [
					{ opacity: 0, translate: `${fromX} 0` },
					{ opacity: 1, translate: "0 0" },
				],
		{ duration: reduce ? duration.sm : duration.md, easing: easing.out },
	);
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
	drillIn(command, ".model-model-pane", "8%");
	activateCommandItem(command, preferred(visible(modelRowsFor(command, provider))));
}

/** `data-on:click` on the "← Providers" back button (also `controls.js`'s
 * ArrowLeft from the models pane): returns to the providers pane without losing which
 * provider was active. */
export function back(el) {
	const command = commandOf(el);
	if (!command) return;
	command.dataset.activePane = "providers";
	drillIn(command, ".model-provider-pane", "-8%");
	activateCommandItem(command, preferred(visible(providerRows(command))));
}

/**
 * The provider whose models the current model actually lives in, straight from the
 * `aria-current="true"` marker `renderModelPicker` (src/ui/prompt-pickers.tsx) always
 * keeps in sync with `state.currentModel` on every render — unlike `data-active-provider`
 * on the `.command` root, this isn't protected by `data-preserve-attr`, so it's the one
 * piece of pane/provider truth a patch can never leave stale. Falls back to the first
 * provider group in server order (mirrors `renderModelPicker`'s own
 * `current?.provider ?? providers[0]?.provider` fallback) when nothing is current yet.
 */
function currentProvider(command) {
	// `[data-model-provider]` (only a *model* row carries it) rules out the providers
	// pane's own rows, which reuse the same `.model-option` class and can also carry
	// `aria-current="true"` (for the current provider) — without it, `querySelector`'s
	// document-order match would land on the providers-pane row instead, since that pane
	// renders first.
	const current = command.querySelector(
		'.model-option[data-model-provider][aria-current="true"]',
	);
	if (current instanceof HTMLElement && current.dataset.modelProvider) {
		return { provider: current.dataset.modelProvider, hasCurrent: true };
	}
	const first = providerGroups(command)[0];
	return { provider: first?.dataset.providerGroup ?? "", hasCurrent: false };
}

/**
 * `data-on:beforetoggle` on `#model-select-popover`, `evt.newState === 'open'`.
 * Regression fix: the popover used to refresh `.active`/`aria-activedescendant` only
 * when it *closed*, so a freshly opened picker had nothing active and a bare Enter did
 * nothing until the user first pressed an arrow key.
 *
 * `data-active-pane`/`data-active-provider`/`data-searching` on the `.command` root are
 * `data-preserve-attr`-guarded (prompt-pickers.tsx) so an unrelated re-render while the
 * popover is open can't silently reset them out from under a user who's mid-browse or
 * mid-search — which also means they can go stale (e.g. another connected client changed
 * the model while this popover was last open). This is the one place that's supposed to
 * resync them: every open, re-derive pane/provider from `currentProvider()`'s ground
 * truth (not the possibly-stale dataset) so `/model` (and the slash picker's `/model`
 * row) reliably land on the current provider + model, ready for arrows/Enter immediately.
 */
export function reset(popover) {
	const command = popover.querySelector(".command");
	if (!command) return;
	command.dataset.searching = "false";
	const { provider, hasCurrent } = currentProvider(command);
	command.dataset.activeProvider = provider;
	command.dataset.activePane = resolveActivePane(
		hasCurrent,
		providerRows(command).length > 0,
	);
	markCurrentProviderRow(command);
	applyActiveProvider(command);
	const pane = command.dataset.activePane === "providers" ? "providers" : "models";
	const items =
		pane === "providers"
			? visible(providerRows(command))
			: visible(modelRowsFor(command, command.dataset.activeProvider));
	activateCommandItem(command, preferred(items));
}

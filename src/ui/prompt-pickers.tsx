import {
	authDialogAction,
	cycleModelAction,
	cycleThinkingAction,
	toggleDialogAction,
} from "../commands/actions.ts";
import { activeKeybind, keybindAction, keybindActions } from "../keybinds.ts";
import { endpoints } from "../server/routes/endpoints.ts";
import type { AppThinkingLevel } from "../state/app-store.ts";
import type { AppStateSnapshot } from "../state/app-store.ts";
import { formatTokens } from "../utils/format.ts";
import { workspaceDisplayName } from "../utils/workspace.ts";
import { Icon } from "./icon.tsx";
import { Brain, Folder, Star } from "./icons.ts";
import { ShortcutKbd, ShortcutTooltip } from "./keyboard.tsx";
import { syncHtml } from "./sync-html.ts";

export function renderWorkspacePicker(state: AppStateSnapshot): string {
	const label = workspaceDisplayName(state.workspacePath);
	return syncHtml(
		<button
			id="workspace-picker"
			class="btn prompt-context-button workspace-picker"
			data-variant="ghost"
			data-size="sm"
			type="button"
			aria-haspopup="dialog"
			aria-controls="workspace-dialog"
			aria-label={state.workspacePath}
			data-attr:disabled="$_sessionTransitionStatus === 'loading'"
			commandfor="workspace-dialog"
			command="show-modal"
			data-on:click="$_workspaceAction = 'open'"
			data-on:keydown__window={keybindAction(
				"change-workspace",
				`$_workspaceAction = 'open'; ${toggleDialogAction()}`,
			)}
			data-tooltip="Workspace"
			data-tooltip-delay
		>
			<Icon icon={Folder} class="prompt-context-icon" />
			<span class="prompt-context-label" safe>
				{label}
			</span>
			<ShortcutTooltip
				label="Workspace"
				shortcut={activeKeybind("change-workspace")}
			/>
		</button>,
	);
}

export function renderThinkingPicker(state: AppStateSnapshot): string {
	const current = state.thinkingLevel;
	return syncHtml(
		<div id="thinking-picker" class="prompt-context-picker">
			<label class="sr-only" for="thinking-select-trigger">
				Thinking level
			</label>
			<div
				id="thinking-select"
				class="dropdown-menu"
				data-on:keydown__window={keybindActions(
					["cycle-thinking", cycleThinkingAction("forward")],
					["cycle-thinking-backward", cycleThinkingAction("backward")],
				)}
			>
				<button
					type="button"
					class="btn prompt-context-button thinking-picker-button"
					data-variant="ghost"
					data-size="sm"
					id="thinking-select-trigger"
					aria-haspopup="menu"
					aria-controls="thinking-select-popover"
					aria-label={`Thinking: ${thinkingLabel(current)}`}
					popovertarget="thinking-select-popover"
					data-tooltip="Thinking"
					data-tooltip-delay
					disabled={state.thinkingLevels.length <= 1}
				>
					<Icon icon={Brain} class="prompt-context-icon" />
					<span class="prompt-context-label">{thinkingLabel(current)}</span>
					<ShortcutTooltip
						label="Thinking"
						shortcut={activeKeybind("cycle-thinking")}
					/>
				</button>
				<div
					id="thinking-select-popover"
					popover="auto"
					data-popover
					data-side="top"
					data-align="end"
					class="thinking-popover"
					role="menu"
					aria-labelledby="thinking-select-trigger"
				>
					<div role="group" aria-labelledby="thinking-select-heading">
						<div
							role="heading"
							id="thinking-select-heading"
							class="picker-heading"
						>
							<span>Thinking</span>
							<ShortcutKbd shortcut={activeKeybind("cycle-thinking")} />
						</div>
						{state.thinkingLevels.map((level) => (
							<button
								type="button"
								role="menuitemradio"
								tabindex="-1"
								autofocus={level === current}
								aria-checked={level === current ? "true" : "false"}
								commandfor="thinking-select-popover"
								command="hide-popover"
								data-on:click={`@post('${endpoints.thinking}', {
								payload: { thinkingLevel: ${JSON.stringify(level)} },
								});`}
							>
								<span class="picker-option-text">
									<span class="picker-option-title">
										{thinkingLabel(level)}
									</span>
									<span class="picker-option-description">
										{thinkingDescription(level)}
									</span>
								</span>
								<span
									class="selection-dot"
									data-ignore
									data-indicator
									aria-hidden="true"
								/>
							</button>
						))}
					</div>
				</div>
			</div>
		</div>,
	);
}

function thinkingLabel(level: AppThinkingLevel): string {
	return level === "off" ? "thinking off" : level;
}

function thinkingDescription(level: AppThinkingLevel): string {
	switch (level) {
		case "off":
			return "No extended reasoning";
		case "minimal":
			return "Very brief reasoning";
		case "low":
			return "Light reasoning";
		case "medium":
			return "Moderate reasoning";
		case "high":
			return "Deep reasoning";
		case "xhigh":
			return "Extra-high reasoning";
		case "max":
			return "Maximum reasoning";
	}
}

/**
 * A provider-derived element id that can't collide with any of this file's own fixed ids
 * (`model-provider-menu`, `model-provider-heading`, …). A provider name comes from an
 * extension's own registration and is arbitrary — it could literally be "menu" or
 * "heading" — and `encodeURIComponent` alone doesn't change either (both are already
 * URL-safe), so `model-provider-${encodeURIComponent(provider)}` would collide outright
 * with `model-provider-menu`/`model-provider-heading`. Prefixing the encoded name's own
 * length (with a separator no fixed suffix in this file uses right after the prefix) makes
 * every derived id's provider segment start with a digit — no fixed id here does — and
 * also keeps two distinct provider names from ever colliding with each other (a standard
 * length-prefixed/prefix-free encoding).
 */
function providerElementId(prefix: string, provider: string): string {
	const encoded = encodeURIComponent(provider);
	return `${prefix}${encoded.length}-${encoded}`;
}

export function renderModelPicker(state: AppStateSnapshot): string {
	const current = state.models.find(
		(model) => `${model.provider}/${model.id}` === state.currentModel,
	);
	const hasModels = state.models.length > 0;
	if (!hasModels) {
		return syncHtml(
			<div id="model-picker" class="prompt-context-picker model-picker">
				<button
					type="button"
					class="btn prompt-context-button model-picker-button"
					data-variant="ghost"
					data-size="sm"
					data-tooltip="Log in to a provider"
					data-tooltip-delay
					data-on:click={authDialogAction("login")}
				>
					<span class="prompt-context-label">no provider</span>
					<ShortcutTooltip label="Log in to a provider" />
				</button>
			</div>,
		);
	}
	const currentLabel = current ? modelTriggerLabel(current) : "choose model";
	const providers = modelPickerProviders(state.models);
	const activeProvider = current?.provider ?? providers[0]?.provider ?? "";
	// Pre-select the current provider + model (spec); with nothing chosen yet there is no
	// model to land on, so open on the providers pane instead of an empty models pane.
	const activePane = current ? "models" : "providers";
	return syncHtml(
		<div id="model-picker" class="prompt-context-picker model-picker">
			<label class="sr-only" for="model-select-trigger">
				Model
			</label>
			<div
				id="model-select"
				class="popover model-select"
				data-on:keydown__window={keybindActions(
					[
						"switch-model",
						"document.getElementById('model-select-trigger')?.click();",
					],
					["cycle-model", cycleModelAction("forward")],
					["cycle-model-backward", cycleModelAction("backward")],
				)}
			>
				<button
					type="button"
					class="btn prompt-context-button model-picker-button"
					data-variant="ghost"
					data-size="sm"
					id="model-select-trigger"
					aria-label={`Model: ${currentLabel}`}
					aria-haspopup="dialog"
					aria-controls="model-select-popover"
					popovertarget="model-select-popover"
					data-tooltip="Model"
					data-tooltip-delay
					data-on:click__capture={`if (!document.getElementById('model-select-popover')?.matches(':popover-open')) {
						$_modelQuery = '';
						@post('${endpoints.modelsRefresh}', { payload: {} });
					}`}
				>
					<span class="prompt-context-label" safe>
						{currentLabel}
					</span>
					<ShortcutTooltip
						label="Model"
						shortcut={activeKeybind("switch-model")}
					/>
				</button>
				<dialog
					id="model-select-popover"
					popover="auto"
					data-popover
					data-side="top"
					data-align="end"
					class="model-popover"
					aria-label="Models"
					// Reset keyboard/pane state as the picker OPENS (not closes): the popover
					// starts with nothing marked `.active`, so a picker refreshed only on close
					// left a bare Enter with no active row to click — the user had to reach for
					// an arrow key or the mouse first. Mirrors `resetCommandDialogOnOpen`
					// (command-menu.tsx) and `selectTreeEntryAction` (tree-picker.tsx).
					data-on:beforetoggle="if (evt.newState === 'open') window.piUi.modelPicker.reset(el)"
				>
					<div
						class="command model-command"
						data-multi-pane={providers.length > 1 ? "true" : undefined}
						data-active-pane={activePane}
						data-active-provider={activeProvider}
						data-searching="false"
						// `data-active-pane`/`data-active-provider`/`data-searching` are the
						// picker's live pane/provider/search state — set by this render, then
						// mutated client-side by `window.piUi.modelPicker`/`modelSearch`
						// (static/app/model-picker.js, model-search.js) as the user browses or
						// types, all *while this same popover stays open*. Any other dirty-region
						// re-render (another client changing the model, this client toggling a
						// model's star, a thinking-level change, …) re-renders this whole picker
						// from scratch and would otherwise morph these three attributes back to
						// this render's values, silently discarding which pane/provider the user
						// had drilled into (or that they were mid-search) even though the popover
						// never closed. `reset()` (called on open, via `data-on:beforetoggle`
						// above) is the one place meant to resync them, deriving the truth from
						// the fresh `aria-current` markers this render always keeps up to date
						// rather than trusting these three attributes.
						data-preserve-attr="data-active-pane data-active-provider data-searching"
					>
						<header>
							<input
								id="model-select-input"
								type="text"
								placeholder="Search models..."
								autocomplete="off"
								data-preserve-attr="aria-activedescendant"
								autocorrect="off"
								spellcheck="false"
								aria-autocomplete="list"
								role="combobox"
								aria-expanded="true"
								aria-controls="model-select-menu"
								autofocus
								data-bind:_model-query
								data-effect="window.piUi.modelSearch.filter(el, $_modelQuery)"
							/>
						</header>
						{providers.length > 1 && (
							<button
								type="button"
								class="btn model-back-button"
								data-variant="ghost"
								data-size="sm"
								data-pane-back
								aria-label="Back to providers"
								data-on:click="window.piUi.modelPicker.back(el)"
							>
								<span aria-hidden="true">←</span> Providers
							</button>
						)}
						<div class="model-picker-body">
							{providers.length > 1 && (
								<div
									role="menu"
									id="model-provider-menu"
									class="model-pane model-provider-pane"
									data-pane="providers"
									aria-label="Providers"
								>
									<div
										role="group"
										aria-labelledby="model-provider-heading"
									>
										<div
											role="heading"
											id="model-provider-heading"
											class="picker-heading"
										>
											<span>Providers</span>
										</div>
										{providers.map((provider) => (
											<div
												id={providerElementId(
													"model-provider-",
													provider.provider,
												)}
												role="menuitem"
												class="model-option model-provider-option"
												data-preserve-attr="class"
												data-provider={provider.provider}
												aria-current={
													provider.provider === activeProvider
														? "true"
														: "false"
												}
												data-on:click={`window.piUi.modelPicker.selectProvider(el, ${JSON.stringify(provider.provider)})`}
											>
												<span class="picker-option-text">
													<span
														class="picker-option-title"
														safe
													>
														{provider.provider}
													</span>
													<span
														class="picker-option-description"
														safe
													>
														{provider.count}{" "}
														{provider.count === 1
															? "model"
															: "models"}
														{provider.configured
															? ""
															: " • no auth"}
													</span>
												</span>
												<span
													class="selection-dot model-current-indicator"
													hidden={
														current?.provider !==
														provider.provider
													}
													aria-hidden="true"
												/>
											</div>
										))}
									</div>
								</div>
							)}
							<div
								role="menu"
								id="model-select-menu"
								class="model-pane model-model-pane"
								data-pane="models"
								aria-labelledby="model-select-trigger"
								data-empty="No models found."
							>
								<div
									role="heading"
									id="model-select-heading"
									class="picker-heading"
								>
									<span>Models</span>
									<ShortcutKbd
										shortcut={activeKeybind("switch-model")}
									/>
								</div>
								{providers.map((provider) => (
									<div
										// `modelPickerProviders` orders providers by each provider's
										// first-appearing model, and `enabledModels`/scoping toggles
										// re-sort `state.models` scoped/current-first — so a scope
										// toggle can reorder these groups between renders. A stable,
										// globally-unique id lets the morph engine (idiomorph-style
										// `getElementById` reuse in static/vendor/datastar.js) track
										// each provider's own group NODE across that reorder instead
										// of positionally reassigning fresh content onto whichever
										// node happens to sit in a given slot — without it, the
										// `data-preserve-attr="hidden"` below could end up preserved
										// on the wrong provider's node after a reorder.
										id={providerElementId(
											"model-group-body-",
											provider.provider,
										)}
										role="group"
										data-provider-group={provider.provider}
										// Client-owned narrowing (`applyActiveProvider()` in
										// static/app/model-picker.js sets `hidden` here to show only
										// the active provider's group): this render never sets
										// `hidden` itself, so without this guard a later re-render's
										// morph would strip it back out from under the open popover.
										// Same reasoning as the `.model-option` rows below.
										data-preserve-attr="hidden"
										aria-labelledby={
											providers.length > 1
												? providerElementId(
														"model-group-",
														provider.provider,
													)
												: "model-select-heading"
										}
									>
										{providers.length > 1 && (
											<div
												role="heading"
												id={providerElementId(
													"model-group-",
													provider.provider,
												)}
												class="picker-heading model-group-heading"
											>
												<span safe>{provider.provider}</span>
											</div>
										)}
										{provider.models.map(({ model, index }) => {
											const value = `${model.provider}/${model.id}`;
											const configured = model.configured
												? ""
												: " • no auth";
											return (
												<div
													id={`model-option-${encodeURIComponent(value)}`}
													role="menuitem"
													class="model-option"
													data-preserve-attr="class hidden"
													aria-current={
														value === state.currentModel
															? "true"
															: "false"
													}
													data-model-id={model.id}
													data-model-provider={model.provider}
													data-model-name={model.name}
													data-model-search-order={index}
													data-on:click={`
												$_modelQuery = '';
												document.getElementById('model-select-trigger')?.click();
												@post('${endpoints.model}', {
												payload: { model: ${JSON.stringify(value)} },
											});
												requestAnimationFrame(() => document.getElementById('prompt-input')?.focus());
											`}
												>
													<span class="picker-option-text">
														<span
															class="picker-option-title"
															safe
														>
															{model.id}
														</span>
														<span
															class="picker-option-description"
															safe
														>
															{model.provider}
															{configured}
														</span>
													</span>
													{(model.contextWindow ||
														model.reasoning) && (
														<span class="model-option-badges">
															{Boolean(
																model.contextWindow,
															) && (
																<span
																	class="badge model-meta-badge"
																	data-variant="secondary"
																	title={`${formatTokens(model.contextWindow ?? 0)} token context window`}
																>
																	{formatTokens(
																		model.contextWindow ??
																			0,
																	)}
																</span>
															)}
															{model.reasoning && (
																<span
																	class="badge model-meta-badge model-thinking-badge"
																	data-variant="secondary"
																	title="Supports extended thinking"
																	aria-label="Supports extended thinking"
																>
																	<Icon icon={Brain} />
																</span>
															)}
														</span>
													)}
													<span
														class="selection-dot model-current-indicator"
														hidden={
															value !== state.currentModel
														}
														aria-hidden="true"
													/>
													<button
														type="button"
														class={[
															"btn model-scope-button",
															model.scoped
																? "model-scope-button-active"
																: "",
														]}
														data-variant={
															model.scoped
																? "secondary"
																: "ghost"
														}
														data-size="icon-sm"
														aria-pressed={
															model.scoped
																? "true"
																: "false"
														}
														aria-label="Toggle scoped model"
														data-on:click__stop={`@post('${endpoints.modelsScopeToggle}', {
												payload: { model: ${JSON.stringify(value)} },
												});`}
													>
														<Icon
															icon={Star}
															class={
																model.scoped
																	? "model-scope-icon-active"
																	: undefined
															}
														/>
													</button>
												</div>
											);
										})}
									</div>
								))}
							</div>
						</div>
					</div>
				</dialog>
			</div>
		</div>,
	);
}

type ModelPickerProvider = {
	provider: string;
	count: number;
	configured: boolean;
	models: { model: AppStateSnapshot["models"][number]; index: number }[];
};

/**
 * Groups `state.models` (already sorted scoped/current-first, then provider, then id —
 * see `compareModelPickerOrder`) into providers for the picker's left pane, preserving
 * each provider's first-appearance order and each provider's own model order.
 */
function modelPickerProviders(models: AppStateSnapshot["models"]): ModelPickerProvider[] {
	const byProvider = new Map<string, ModelPickerProvider>();
	models.forEach((model, index) => {
		let entry = byProvider.get(model.provider);
		if (!entry) {
			entry = {
				provider: model.provider,
				count: 0,
				configured: model.configured,
				models: [],
			};
			byProvider.set(model.provider, entry);
		}
		entry.count += 1;
		entry.models.push({ model, index });
	});
	return [...byProvider.values()];
}

function modelTriggerLabel(model: AppStateSnapshot["models"][number]): string {
	return model.id.slice(model.id.lastIndexOf("/") + 1);
}

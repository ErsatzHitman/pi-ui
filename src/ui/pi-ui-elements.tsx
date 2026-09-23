import {
	type PiUiAction,
	type PiUiElement,
	piUiDialogId,
	piUiSlug,
} from "../extension-surface-types.ts";
import { endpoints } from "../server/routes/endpoints.ts";
import type { AppStateSnapshot } from "../state/app-store.ts";
import type { JsonObject, JsonValue } from "../utils/json-types.ts";
import { isBoolean, isJsonObject, isNumber, isString } from "../utils/type-guards.ts";
import { renderMarkdownStreaming } from "./markdown.tsx";
import { syncHtml } from "./sync-html.ts";

/**
 * Renders decoded "Pi UI Bridge" (PIUI) elements — the wire vocabulary
 * bridge-aware extensions emit over `ctx.ui.notify()` (see `pi-ui-bridge.ts`
 * and `~/.pi/agent/extensions/lib/bridge.ts`) — natively, by placement:
 *
 * - `status` → a status chip, same row as `ctx.ui.setStatus()`'s own chips.
 * - `pinned`/`inline` → the widget area above the editor (widget, roster,
 *   progress, log, markdown, diff).
 * - `sheet`/`screen` → a native `<dialog>` sheet (bottom sheet on mobile),
 *   with `actions`/fields (`panel`, `form`).
 * - `composer` → not rendered here; `ExtensionUiController` pushes its text
 *   straight into the prompt editor as a side effect of decoding.
 *
 * `renderPiUiElement()` is exported standalone so the Live Workspace pane
 * (R1-C) can reuse the same per-kind rendering for its Extensions tab.
 */

const widgetPlacements = new Set(["pinned", "inline"]);
const sheetPlacements = new Set(["sheet", "screen"]);

export function renderPiUiStatusChips(
	state: Pick<AppStateSnapshot, "extensionElements">,
): string {
	return syncHtml(
		<>
			{state.extensionElements
				.filter((element) => element.placement === "status")
				.map((element) => (
					<span
						class="extension-status piui-status"
						data-piui-element={domId(element)}
						safe
					>
						{textField(element.data.text) ?? element.title ?? ""}
					</span>
				))}
		</>,
	);
}

export function renderPiUiWidgets(
	state: Pick<AppStateSnapshot, "extensionElements">,
): string {
	return syncHtml(
		<div id="piui-widgets" class="piui-widgets" aria-live="polite">
			{state.extensionElements
				.filter(
					(element) =>
						widgetPlacements.has(element.placement) &&
						element.kind !== "composer",
				)
				.map((element) => renderPiUiElement(element))}
		</div>,
	);
}

export function renderPiUiSheets(
	state: Pick<AppStateSnapshot, "extensionElements">,
): string {
	return syncHtml(
		<div id="piui-sheets">
			{state.extensionElements
				.filter((element) => sheetPlacements.has(element.placement))
				.map((element) => renderPiUiSheetDialog(element))}
		</div>,
	);
}

/** Ids of `sheet`/`screen` elements currently present — used to auto-open new ones. */
export function piUiSheetIds(
	state: Pick<AppStateSnapshot, "extensionElements">,
): readonly string[] {
	return state.extensionElements
		.filter((element) => sheetPlacements.has(element.placement))
		.map((element) => dialogId(element));
}

export function renderPiUiElement(element: PiUiElement): string {
	return syncHtml(
		<div
			class={`piui-element piui-element-${element.kind}`}
			data-piui-element={domId(element)}
		>
			{element.title && (
				<div class="piui-element-title" safe>
					{element.title}
				</div>
			)}
			{renderPiUiBody(element)}
			{renderPiUiActions(element)}
		</div>,
	);
}

function renderPiUiSheetDialog(element: PiUiElement): string {
	return syncHtml(
		<dialog
			id={dialogId(element)}
			class="dialog piui-sheet"
			aria-labelledby={`${dialogId(element)}-title`}
			closedby="any"
			data-on:close={dismissAction(element)}
		>
			<header>
				<h2 id={`${dialogId(element)}-title`} safe>
					{element.title ?? element.ns}
				</h2>
			</header>
			{renderPiUiBody(element)}
			<footer>
				<button
					type="button"
					class="btn"
					data-variant="outline"
					commandfor={dialogId(element)}
					command="close"
				>
					Close
				</button>
				{renderPiUiActions(element)}
			</footer>
		</dialog>,
	);
}

function renderPiUiBody(element: PiUiElement): string {
	switch (element.kind) {
		case "status":
			return syncHtml(<span safe>{textField(element.data.text) ?? ""}</span>);
		case "widget":
			return renderLines(element.data.lines, "piui-widget-lines");
		case "log":
			return renderLines(element.data.lines, "piui-log-lines");
		case "progress":
			return renderProgress(element);
		case "roster":
			return renderRoster(element);
		case "markdown":
			return renderMarkdownBody(element);
		case "diff":
			return renderDiffBody(element);
		case "panel":
		case "form":
			return renderPanelBody(element);
		case "composer":
			return "";
	}
}

function renderLines(value: JsonValue | undefined, className: string): string {
	const lines = stringArray(value);
	if (lines.length === 0) return "";
	return syncHtml(
		<div class={className}>
			{lines.map((line) => (
				<div safe>{line}</div>
			))}
		</div>,
	);
}

function renderProgress(element: PiUiElement): string {
	const current = numberField(element.data.current);
	const total = numberField(element.data.total);
	const percent = numberField(element.data.percent);
	const ratio =
		percent !== undefined
			? clampPercent(percent)
			: current !== undefined && total
				? clampPercent((current / total) * 100)
				: undefined;
	const label = textField(element.data.label);
	return syncHtml(
		<div class="piui-progress">
			{ratio !== undefined ? (
				<span class="piui-progress-track">
					<span class="piui-progress-value" style={`width: ${ratio}%`} />
				</span>
			) : (
				<span class="piui-progress-indeterminate" />
			)}
			{(label ?? (current !== undefined && total !== undefined)) && (
				<span class="piui-progress-label" safe>
					{label ?? `${current} / ${total}`}
				</span>
			)}
		</div>,
	);
}

function renderRoster(element: PiUiElement): string {
	const rows = arrayField(element.data);
	if (!rows) return renderGenericData(element.data);
	return syncHtml(
		<ul class="piui-roster">{rows.map((row) => renderRosterRow(row))}</ul>,
	);
}

function renderRosterRow(row: JsonValue): string {
	if (!isJsonObject(row)) {
		return syncHtml(
			<li class="piui-roster-row">
				<span safe>{String(row)}</span>
			</li>,
		);
	}
	const record = row;
	const label =
		textField(record.name) ??
		textField(record.title) ??
		textField(record.label) ??
		textField(record.id) ??
		"—";
	const state = textField(record.state) ?? textField(record.status);
	return syncHtml(
		<li class="piui-roster-row" data-piui-roster-state={state}>
			<span class="piui-roster-label" safe>
				{label}
			</span>
			{state && (
				<span class="piui-roster-state" safe>
					{state}
				</span>
			)}
		</li>,
	);
}

function renderMarkdownBody(element: PiUiElement): string {
	const text = textField(element.data.text) ?? "";
	if (!text) return "";
	return syncHtml(
		<div class="piui-markdown markdown-content">
			{renderMarkdownStreaming(text, {
				cacheKey: `piui:${element.ns}:${element.id}`,
			})}
		</div>,
	);
}

function renderDiffBody(element: PiUiElement): string {
	const diffText =
		textField(element.data.unifiedDiff) ?? textField(element.data.diff) ?? "";
	if (!diffText) return "";
	// A dedicated syntax-highlighted diff view belongs to whichever consumer
	// (this widget area, or R1-C's Live Workspace) wants to invest in it; a
	// `<pre>` keeps this correct and dependency-free in the meantime.
	return syncHtml(
		<pre class="piui-diff" safe>
			{diffText}
		</pre>,
	);
}

type PiUiFieldSpec = {
	id: string;
	kind: string;
	label?: string;
	placeholder?: string;
	options: Array<{ id: string; label: string }>;
};

function renderPanelBody(element: PiUiElement): string {
	const sections = arrayFieldOf(element.data.sections);
	const fields = normalizeFields(element.data.fields);
	if (!sections && fields.length === 0) return renderGenericData(element.data);
	return syncHtml(
		<div class="piui-panel">
			{sections?.map((section) => renderPanelSection(section))}
			{fields.length > 0 && renderFields(element, fields)}
		</div>,
	);
}

function renderPanelSection(section: JsonValue): string {
	if (!isJsonObject(section)) return "";
	const record = section;
	const kind = textField(record.kind);
	const text = textField(record.text) ?? "";
	if (kind === "markdown") {
		return syncHtml(
			<div class="piui-panel-section piui-panel-markdown markdown-content">
				{renderMarkdownStreaming(text)}
			</div>,
		);
	}
	if (kind === "log") {
		return syncHtml(
			<div class="piui-panel-section piui-panel-log" safe>
				{text}
			</div>,
		);
	}
	return syncHtml(
		<div class="piui-panel-section piui-panel-status" safe>
			{text}
		</div>,
	);
}

function normalizeFields(value: JsonValue | undefined): PiUiFieldSpec[] {
	if (!Array.isArray(value)) return [];
	const fields: PiUiFieldSpec[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isJsonObject(raw)) continue;
		const record = raw;
		const kind = textField(record.kind) ?? "text";
		const id = textField(record.id) ?? `field-${index}`;
		const options: Array<{ id: string; label: string }> = [];
		if (Array.isArray(record.options)) {
			for (const option of record.options) {
				if (!isJsonObject(option)) continue;
				const optionRecord = option;
				options.push({
					id: textField(optionRecord.id) ?? textField(optionRecord.value) ?? "",
					label:
						textField(optionRecord.label) ??
						textField(optionRecord.title) ??
						textField(optionRecord.id) ??
						"",
				});
			}
		}
		fields.push({
			id,
			kind,
			label: textField(record.label) ?? textField(record.title),
			placeholder: textField(record.placeholder),
			options,
		});
	}
	return fields;
}

function renderFields(element: PiUiElement, fields: PiUiFieldSpec[]): string {
	return syncHtml(
		<div class="piui-fields">
			{fields.map((field) => renderField(element, field))}
		</div>,
	);
}

function renderField(element: PiUiElement, field: PiUiFieldSpec): string {
	const signal = fieldSignal(element, field);
	if (field.kind === "textarea") {
		return syncHtml(
			<div class="field">
				{field.label && <label safe>{field.label}</label>}
				<textarea
					class="dialog-editor"
					placeholder={field.placeholder}
					data-signals={`{${signal}: ''}`}
					data-bind={signal}
				/>
			</div>,
		);
	}
	if (field.kind === "select") {
		return syncHtml(
			<div class="field">
				{field.label && <label safe>{field.label}</label>}
				<select data-signals={`{${signal}: ''}`} data-bind={signal}>
					{field.options.map((option) => (
						<option value={option.id} safe>
							{option.label}
						</option>
					))}
				</select>
			</div>,
		);
	}
	if (field.kind === "multiselect") {
		return syncHtml(
			<fieldset class="field piui-multiselect">
				{field.label && <legend safe>{field.label}</legend>}
				<div data-signals={`{${signal}: []}`}>
					{field.options.map((option) => (
						<label class="piui-multiselect-option">
							<input
								type="checkbox"
								data-on:change={`${signal} = evt.target.checked ? [...${signal}, ${JSON.stringify(option.id)}] : ${signal}.filter((value) => value !== ${JSON.stringify(option.id)})`}
							/>
							<span safe>{option.label}</span>
						</label>
					))}
				</div>
			</fieldset>,
		);
	}
	return syncHtml(
		<div class="field">
			{field.label && <label safe>{field.label}</label>}
			<input
				type="text"
				placeholder={field.placeholder}
				data-signals={`{${signal}: ''}`}
				data-bind={signal}
				autocomplete="off"
			/>
		</div>,
	);
}

function renderPiUiActions(element: PiUiElement): string {
	if (!element.actions || element.actions.length === 0) return "";
	const fields = normalizeFields(element.data.fields);
	return syncHtml(
		<div class="piui-actions">
			{element.actions.map((action) => (
				<button
					type="button"
					class="btn"
					data-variant={action.variant === "primary" ? undefined : "outline"}
					data-on:click={actionClick(element, action, fields)}
					safe
				>
					{action.label}
				</button>
			))}
		</div>,
	);
}

function renderGenericData(data: Readonly<Record<string, JsonValue>>): string {
	const entries = Object.entries(data).filter(([key]) => key !== "text");
	if (entries.length === 0) return "";
	return syncHtml(
		<dl class="piui-generic-data">
			{entries.map(([key, value]) => (
				<>
					<dt safe>{key}</dt>
					<dd safe>{summarize(value)}</dd>
				</>
			))}
		</dl>,
	);
}

function domId(element: PiUiElement): string {
	return `${element.ns}:${element.id}`;
}

function dialogId(element: PiUiElement): string {
	return piUiDialogId(element);
}

function fieldSignal(element: PiUiElement, field: PiUiFieldSpec): string {
	return `_piuiField_${piUiSlug(element.ns)}_${piUiSlug(element.id)}_${piUiSlug(field.id)}`;
}

function dismissAction(element: PiUiElement): string {
	return actionPost(element, "dismiss", "undefined");
}

function actionClick(
	element: PiUiElement,
	action: PiUiAction,
	fields: PiUiFieldSpec[],
): string {
	const valueExpression =
		fields.length > 0
			? `{ ${fields.map((field) => `${JSON.stringify(field.id)}: ${fieldSignal(element, field)}`).join(", ")} }`
			: "undefined";
	const post = actionPost(element, action.id, valueExpression);
	return action.confirm
		? `if (confirm(${JSON.stringify(action.confirm)})) { ${post} }`
		: post;
}

function actionPost(
	element: PiUiElement,
	actionId: string,
	valueExpression: string,
): string {
	// `elementId`/`actionId` match the `PiUiActionRequest` contract exactly —
	// this is what `lib/bridge.ts`'s `pi_ui_event` handler expects to decode.
	return `@post('${endpoints.extensionUiAction}', { payload: {
		elementId: ${JSON.stringify(element.id)},
		actionId: ${JSON.stringify(actionId)},
		value: ${valueExpression},
	} })`;
}

function textField(value: JsonValue | undefined): string | undefined {
	return isString(value) ? value : undefined;
}

function numberField(value: JsonValue | undefined): number | undefined {
	return isNumber(value) ? value : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => (isString(entry) ? entry : summarize(entry)));
}

function arrayFieldOf(value: JsonValue | undefined): JsonValue[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

/** Finds the first array-valued field on an element's data — used as a
 * best-effort fallback when a `roster` doesn't use the conventional
 * `rows`/`entries` field name. */
function arrayField(data: JsonObject): JsonValue[] | undefined {
	if (Array.isArray(data.rows)) return data.rows;
	if (Array.isArray(data.entries)) return data.entries;
	if (Array.isArray(data.items)) return data.items;
	for (const value of Object.values(data)) {
		if (Array.isArray(value)) return value;
	}
	return undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function summarize(value: JsonValue): string {
	if (isString(value)) return value;
	if (isNumber(value) || isBoolean(value)) return String(value);
	if (value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

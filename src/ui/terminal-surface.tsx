import {
	terminalSurfaceDialogId,
	type TerminalSurface,
	type TerminalSurfaceOverlayOptions,
} from "../agent/terminal-surface/types.ts";
import { endpoints } from "../server/routes/endpoints.ts";
import type { AppStateSnapshot } from "../state/app-store.ts";
import { isString } from "../utils/type-guards.ts";
import { Icon } from "./icon.tsx";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from "./icons.ts";
import { syncHtml } from "./sync-html.ts";

/**
 * Client-facing rendering for the terminal-surface host (see
 * `terminal-surface-controller.ts`): a monospace cell grid per surface,
 * `overlay`-kind surfaces wrapped in a native `<dialog>` styled like every
 * other pi-ui dialog/sheet. Every line is already pre-escaped, safe HTML
 * from `ansiLineToHtml` — never re-escaped here (matching how
 * `renderMarkdownStreaming`'s trusted output is embedded elsewhere in this
 * codebase). Key forwarding, cell-grid measurement/resize, and the mobile
 * soft-key bar's behavior live in `static/app/terminal-keys.js`; this module
 * only emits the markup and data attributes that script reads.
 */

const persistentKinds = new Set<TerminalSurface["kind"]>(["widget", "footer", "header"]);

export function renderTerminalSurfaceOverlays(
	state: Pick<AppStateSnapshot, "terminalSurfaces">,
): string {
	return syncHtml(
		<div id="terminal-surface-overlays">
			{state.terminalSurfaces
				.filter((surface) => surface.kind === "overlay")
				.map((surface) => renderTerminalSurfaceDialog(surface))}
		</div>,
	);
}

export function renderTerminalSurfacePersistent(
	state: Pick<AppStateSnapshot, "terminalSurfaces">,
): string {
	return syncHtml(
		<div id="terminal-surface-persistent" aria-live="polite">
			{state.terminalSurfaces
				.filter((surface) => persistentKinds.has(surface.kind))
				.map((surface) => renderTerminalSurfaceBlock(surface))}
		</div>,
	);
}

/**
 * Open effects for currently-mounted `overlay`-kind surfaces — used to
 * auto-open newly created ones, both on the initial SSE view (`renderView`)
 * and via `AppStore.setTerminalSurfaces`'s per-surface diffing. `modal`
 * mirrors `OverlayOptions.nonCapturing`: a non-capturing overlay is shown
 * non-modally (`.show()`) so it never steals focus from the prompt.
 */
export function terminalSurfaceOverlayEffects(
	state: Pick<AppStateSnapshot, "terminalSurfaces">,
): readonly { id: string; modal: boolean }[] {
	return state.terminalSurfaces
		.filter((surface) => surface.kind === "overlay")
		.map((surface) => ({
			id: terminalSurfaceDialogId(surface.id),
			modal: !surface.overlayOptions?.nonCapturing,
		}));
}

/** The 9-way `OverlayAnchor` values `terminal-surface.css` has a `[data-anchor=…]` rule for. */
const knownAnchors = new Set([
	"top-left",
	"top-right",
	"top-center",
	"bottom-left",
	"bottom-right",
	"bottom-center",
	"left-center",
	"right-center",
	"center",
]);

function sizeValue(value: number | string | undefined, unit: string): string | undefined {
	if (value === undefined) return undefined;
	return isString(value) ? value : `${value}${unit}`;
}

/**
 * Projects `OverlayOptions` (columns/rows/anchor/offsets) onto CSS custom
 * properties `terminal-surface.css` reads — a best-effort approximation of
 * pi-tui's cell-based overlay layout using the same `ch`/`lh` units the
 * cell grid itself is sized with, not pixel-perfect terminal math.
 */
function overlayStyleVars(
	options: TerminalSurfaceOverlayOptions | undefined,
): string | undefined {
	if (!options) return undefined;
	const decls: string[] = [];
	const width = sizeValue(options.width, "ch");
	if (width) decls.push(`--terminal-overlay-width:${width}`);
	if (options.minWidth !== undefined) {
		decls.push(`--terminal-overlay-min-width:${options.minWidth}ch`);
	}
	const maxHeight = sizeValue(options.maxHeight, "lh");
	if (maxHeight) decls.push(`--terminal-overlay-max-height:${maxHeight}`);
	if (options.offsetX) decls.push(`--terminal-overlay-offset-x:${options.offsetX}ch`);
	if (options.offsetY) decls.push(`--terminal-overlay-offset-y:${options.offsetY}lh`);
	if (options.margin !== undefined) {
		decls.push(`--terminal-overlay-margin:${options.margin}ch`);
	}
	return decls.length > 0 ? decls.join(";") : undefined;
}

function renderTerminalSurfaceDialog(surface: TerminalSurface): string {
	const id = terminalSurfaceDialogId(surface.id);
	const options = surface.overlayOptions;
	const nonCapturing = options?.nonCapturing === true;
	const anchor =
		options?.anchor && knownAnchors.has(options.anchor) ? options.anchor : "center";
	return syncHtml(
		<dialog
			id={id}
			class="dialog terminal-surface-dialog"
			aria-labelledby={surface.title ? `${id}-title` : undefined}
			aria-label={surface.title ? undefined : "Extension panel"}
			closedby="any"
			data-preserve-attr="open"
			data-nonblocking={nonCapturing ? "true" : undefined}
			data-anchor={anchor}
			style={overlayStyleVars(options)}
			data-on:close={`@post('${endpoints.terminalSurfaceInput}', { payload: { surfaceId: ${JSON.stringify(surface.id)}, data: '\\u001b' } })`}
		>
			<div class="terminal-surface-dialog-content">
				{surface.title && (
					<header>
						<h2 id={`${id}-title`} safe>
							{surface.title}
						</h2>
					</header>
				)}
				{renderTerminalSurfaceBody(surface)}
			</div>
		</dialog>,
	);
}

function renderTerminalSurfaceBlock(surface: TerminalSurface): string {
	return syncHtml(
		<div
			class={`terminal-surface terminal-surface-${surface.kind}`}
			data-terminal-surface={surface.id}
		>
			{surface.title && (
				<div class="terminal-surface-title" safe>
					{surface.title}
				</div>
			)}
			{renderTerminalSurfaceBody(surface)}
		</div>,
	);
}

function renderTerminalSurfaceBody(surface: TerminalSurface): string {
	const cursor = surface.cursor;
	const caretStyle = cursor
		? `--terminal-cursor-row:${cursor.row};--terminal-cursor-col:${cursor.column}`
		: undefined;
	const label = surface.title ?? "Terminal panel";
	return syncHtml(
		<div
			class="terminal-surface-grid"
			data-terminal-surface-grid={surface.id}
			role="group"
			aria-label={label}
		>
			<pre
				class={
					cursor ? "terminal-surface-body has-caret" : "terminal-surface-body"
				}
				data-terminal-surface-body={surface.id}
				data-cols={surface.cols}
				data-rows={surface.rows}
				data-revision={surface.revision}
				style={caretStyle}
			>
				{surface.lines.join("\n")}
			</pre>
			<textarea
				class="terminal-surface-input"
				data-terminal-surface-input={surface.id}
				aria-label={label}
				spellcheck="false"
				rows="1"
				style={caretStyle}
				attrs={{
					autocomplete: "off",
					autocorrect: "off",
					autocapitalize: "off",
				}}
			/>
			{renderSoftKeyBar(surface.id)}
		</div>,
	);
}

function renderSoftKeyBar(surfaceId: string): string {
	return syncHtml(
		<div
			class="terminal-surface-keys"
			data-terminal-surface-keys={surfaceId}
			role="toolbar"
			aria-label="Terminal keys"
		>
			<button
				type="button"
				class="btn terminal-key"
				data-variant="outline"
				data-terminal-key="escape"
			>
				Esc
			</button>
			<button
				type="button"
				class="btn terminal-key"
				data-variant="outline"
				data-terminal-key="tab"
			>
				Tab
			</button>
			<button
				type="button"
				class="btn terminal-key"
				data-variant="outline"
				data-size="icon-sm"
				data-terminal-key="up"
				aria-label="Up"
			>
				<Icon icon={ArrowUp} />
			</button>
			<button
				type="button"
				class="btn terminal-key"
				data-variant="outline"
				data-size="icon-sm"
				data-terminal-key="down"
				aria-label="Down"
			>
				<Icon icon={ArrowDown} />
			</button>
			<button
				type="button"
				class="btn terminal-key"
				data-variant="outline"
				data-size="icon-sm"
				data-terminal-key="left"
				aria-label="Left"
			>
				<Icon icon={ArrowLeft} />
			</button>
			<button
				type="button"
				class="btn terminal-key"
				data-variant="outline"
				data-size="icon-sm"
				data-terminal-key="right"
				aria-label="Right"
			>
				<Icon icon={ArrowRight} />
			</button>
			<button
				type="button"
				class="btn terminal-key"
				data-variant="outline"
				data-size="icon-sm"
				data-terminal-key="enter"
				aria-label="Enter"
			>
				<Icon icon={CornerDownLeft} />
			</button>
			<button
				type="button"
				class="btn terminal-key terminal-key-sticky"
				data-variant="outline"
				data-terminal-key="ctrl"
				aria-pressed="false"
			>
				Ctrl
			</button>
			<button
				type="button"
				class="btn terminal-key terminal-key-sticky"
				data-variant="outline"
				data-terminal-key="alt"
				aria-pressed="false"
			>
				Alt
			</button>
		</div>,
	);
}

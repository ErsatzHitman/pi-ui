import {
	terminalSurfaceDialogId,
	type TerminalSurface,
} from "../agent/terminal-surface/types.ts";
import { endpoints } from "../server/routes/endpoints.ts";
import type { AppStateSnapshot } from "../state/app-store.ts";
import { syncHtml } from "./sync-html.ts";

/**
 * Minimal server-rendered markup for the terminal-surface host (see
 * `terminal-surface-controller.ts`): a `<pre>`-like block per surface,
 * `overlay`-kind surfaces wrapped in a native `<dialog>`. Every line is
 * already pre-escaped, safe HTML from `ansiLineToHtml` — never re-escaped
 * here (matching how `renderMarkdownStreaming`'s trusted output is embedded
 * elsewhere in this codebase).
 *
 * This intentionally stops at "functional, not final": full client-side key
 * forwarding, cell-grid measurement, and visual polish (matching pi-ui's
 * dialog/sheet chrome per the Round 2 plan's "Visual consistency") are a
 * separate client workstream (`static/app/terminal-keys.js`,
 * `terminal-surface.css`) layered on top of these element ids without
 * changing them.
 */

// Non-overlay `custom()` surfaces ("inline") take the TUI editor's place there; in the browser they
// render with the other persistent surfaces just above the prompt editor.
const persistentKinds = new Set<TerminalSurface["kind"]>([
	"inline",
	"widget",
	"footer",
	"header",
]);

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
				.map((surface) =>
					surface.kind === "inline" ? surface : trimBlankEdges(surface),
				)
				.filter((surface) => surface.lines.length > 0)
				.map((surface) => renderTerminalSurfaceBlock(surface))}
		</div>,
	);
}

/** True when a rendered line (already-escaped HTML from `ansiLineToHtml`) shows only blanks. */
function isBlankLine(html: string): boolean {
	return html.replace(/<[^>]*>/g, "").trim() === "";
}

/**
 * Widget/header/footer components are laid out for a full terminal, where blank padding
 * rows (a splash header sized to `terminal.rows`, a spacer line) cost nothing. Above the
 * prompt they would push the editor off screen, so leading/trailing blank rows are dropped
 * and a surface with nothing visible is not rendered at all.
 */
function trimBlankEdges(surface: TerminalSurface): TerminalSurface {
	const { lines } = surface;
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankLine(lines[start] ?? "")) start += 1;
	while (end > start && isBlankLine(lines[end - 1] ?? "")) end -= 1;
	if (start === 0 && end === lines.length) return surface;
	const cursor =
		surface.cursor && surface.cursor.row >= start && surface.cursor.row < end
			? { ...surface.cursor, row: surface.cursor.row - start }
			: undefined;
	return { ...surface, lines: lines.slice(start, end), cursor };
}

/** Ids of currently-mounted `overlay`-kind surfaces — used to auto-open newly created ones. */
export function terminalSurfaceOverlayIds(
	state: Pick<AppStateSnapshot, "terminalSurfaces">,
): readonly string[] {
	return state.terminalSurfaces
		.filter((surface) => surface.kind === "overlay")
		.map((surface) => terminalSurfaceDialogId(surface.id));
}

function renderTerminalSurfaceDialog(surface: TerminalSurface): string {
	const id = terminalSurfaceDialogId(surface.id);
	return syncHtml(
		<dialog
			id={id}
			class="dialog terminal-surface-dialog"
			aria-labelledby={surface.title ? `${id}-title` : undefined}
			closedby="any"
			data-preserve-attr="open"
			data-on:close={`@post('${endpoints.terminalSurfaceInput}', { payload: { surfaceId: ${JSON.stringify(surface.id)}, data: '\\u001b' } })`}
		>
			{/* The dialog's single child is its panel (shared `.dialog > *` chrome); the panel is
			    sized to the surface's column grid, capped to the viewport. */}
			<div class="terminal-surface-panel">
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

/** A Datastar expression posting `data` (an expression) to this surface's input route. */
function postTerminalInput(surfaceId: string, data: string): string {
	return `@post('${endpoints.terminalSurfaceInput}', { payload: { surfaceId: ${JSON.stringify(surfaceId)}, data: ${data} } })`;
}

function renderTerminalSurfaceBody(surface: TerminalSurface): string {
	// Keys, pastes and wheel gestures are encoded client-side into the terminal byte
	// sequences a pi-tui `Component` expects (static/app/terminal-keys.js) and forwarded
	// to the focused component through the input route.
	const onKeydown = `const data = window.piUi.terminal.encodeKey(evt); if (data !== undefined) { evt.preventDefault(); evt.stopPropagation(); ${postTerminalInput(surface.id, "data")} }`;
	const onPaste = `evt.preventDefault(); ${postTerminalInput(surface.id, "window.piUi.terminal.encodePaste(evt.clipboardData?.getData('text') ?? '')")}`;
	// Fit the component's column grid to the space the surface actually has (the viewport for
	// an overlay, the prompt column otherwise). The expression embeds the current cols, so it
	// re-runs after each resize re-render and settles once the measured fit matches.
	// An inline `custom()` takes the editor's place (and its focus) in the TUI, so it takes
	// keyboard focus here too; overlays get it from `autofocus` when their dialog opens.
	const focusInline =
		surface.kind === "inline" ? "el.focus({ preventScroll: true }); " : "";
	const onInit = `${focusInline}const cols = window.piUi.terminal.fitColumns(el); if (cols !== undefined && cols !== ${surface.cols}) { @post('${endpoints.terminalSurfaceResize}', { payload: { surfaceId: ${JSON.stringify(surface.id)}, cols, rows: ${surface.rows} } }) }`;
	const onWheel = `const data = window.piUi.terminal.encodeWheel(evt); if (data !== undefined) { evt.preventDefault(); ${postTerminalInput(surface.id, "data")} }`;
	return syncHtml(
		<pre
			class="terminal-surface-body"
			data-terminal-surface-body={surface.id}
			autofocus={surface.kind === "overlay"}
			data-init={onInit}
			data-on:keydown={onKeydown}
			data-on:paste={onPaste}
			{...{ "data-on:wheel__throttle.100ms": onWheel }}
			data-cols={surface.cols}
			data-rows={surface.rows}
			data-revision={surface.revision}
			data-cursor-row={surface.cursor?.row}
			data-cursor-column={surface.cursor?.column}
			style={`--terminal-cols: ${surface.width}`}
			tabindex="0"
		>
			{surface.lines.join("\n")}
		</pre>,
	);
}

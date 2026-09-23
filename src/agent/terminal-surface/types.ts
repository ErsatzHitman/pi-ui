/** Where a terminal surface's component is mounted (mirrors `ExtensionUIContext`'s own split). */
export type TerminalSurfaceKind = "overlay" | "inline" | "widget" | "footer" | "header";

/** A JSON-serializable projection of `pi-tui`'s `OverlayOptions` for the client to size/anchor a dialog. */
export type TerminalSurfaceOverlayOptions = {
	readonly width?: number | string;
	readonly minWidth?: number;
	readonly maxHeight?: number | string;
	readonly anchor?: string;
	readonly offsetX?: number;
	readonly offsetY?: number;
	readonly row?: number | string;
	readonly col?: number | string;
	readonly margin?: number;
};

export type TerminalSurfaceCursor = { readonly row: number; readonly column: number };

/**
 * One rendered `pi-tui` `Component` tree, projected to safe HTML lines for
 * the browser. This is `AppStore`'s public shape for the terminal-surface
 * host — `TerminalSurfaceController` is the only writer, via its `onUpdate`
 * callback (see `terminal-surface-controller.ts`).
 */
export type TerminalSurface = {
	readonly id: string;
	readonly kind: TerminalSurfaceKind;
	readonly title: string | undefined;
	readonly overlayOptions: TerminalSurfaceOverlayOptions | undefined;
	/** Pre-escaped HTML for each rendered line (see `ansiLineToHtml`); never raw ANSI. */
	readonly lines: readonly string[];
	readonly cursor: TerminalSurfaceCursor | undefined;
	/** The host grid (client-measured, see `resize`). */
	readonly cols: number;
	readonly rows: number;
	/**
	 * Columns the component was actually rendered at: an overlay's resolved
	 * `OverlayOptions.width` (as pi-tui's own overlay layout computes it), else `cols`.
	 */
	readonly width: number;
	/** Bumped on every committed frame; lets the client ignore an out-of-order patch. */
	readonly revision: number;
};

/** Defensive cap on a single component's rendered height — see `terminal-surface-controller.ts`. */
export const maxTerminalSurfaceLines = 2000;
/** Defensive cap on a single rendered line's length. */
export const maxTerminalSurfaceLineLength = 4000;

/** The `<dialog>` element id an `overlay`-kind surface renders under. */
export function terminalSurfaceDialogId(id: string): string {
	return `terminal-surface-${id}`;
}

import type {
	KeybindingsManager,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	KeybindingsManager as TuiKeybindingsManager,
	type OverlayHandle,
	type OverlayOptions,
	TUI_KEYBINDINGS,
	type TUI,
} from "@earendil-works/pi-tui";

import { StreamingFrameScheduler } from "../../state/streaming-frame-scheduler.ts";
import { isNumber, isString } from "../../utils/type-guards.ts";
import { ansiLineToHtml } from "./ansi-to-html.ts";
import {
	clampTerminalSize,
	defaultTerminalColumns,
	defaultTerminalRows,
	HeadlessTerminal,
} from "./headless-terminal.ts";
import { resolveTerminalTheme, type TerminalSurfaceColorScheme } from "./theme.ts";
import { TuiShim } from "./tui-shim.ts";
import {
	maxTerminalSurfaceLineLength,
	maxTerminalSurfaceLines,
	type TerminalSurface,
	type TerminalSurfaceKind,
	type TerminalSurfaceOverlayOptions,
} from "./types.ts";

/** Coalesced render rate for every terminal surface (see the Round 2 plan: "≤30fps"). */
const surfaceFrameHz = 30;

/** Passed to `setWidget`/`setHeader` factories, which declare but never read a 3rd argument. */
const noopFooterData: ReadonlyFooterDataProvider = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 0,
	onBranchChange: () => () => {},
};

export type DisposableComponent = Component & { dispose?(): void };

export type CustomComponentFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => DisposableComponent | Promise<DisposableComponent>;

/**
 * Covers both `setWidget`/`setHeader` (2-arg) and `setFooter` (3-arg, with a
 * `ReadonlyFooterDataProvider`) factories — a wider parameter list than a
 * caller declares is always assignable to a narrower one, so this one type
 * fits all three `ExtensionUIContext` members without three near-identical
 * aliases.
 */
export type PersistentComponentFactory = (
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => DisposableComponent;

export type MountCustomParams<T> = {
	readonly id: string;
	readonly factory: CustomComponentFactory<T>;
	readonly overlay: boolean;
	readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
	readonly onHandle?: (handle: OverlayHandle) => void;
	readonly colorScheme: TerminalSurfaceColorScheme;
	readonly title?: string;
	readonly cols?: number;
	readonly rows?: number;
};

export type MountPersistentParams = {
	readonly id: string;
	readonly kind: "widget" | "footer" | "header";
	readonly factory: PersistentComponentFactory;
	/** Only meaningful for `kind: "footer"`; ignored by widget/header factories. */
	readonly footerData?: ReadonlyFooterDataProvider;
	readonly colorScheme: TerminalSurfaceColorScheme;
	readonly title?: string;
	readonly cols?: number;
	readonly rows?: number;
	/**
	 * Mirrors the TUI, where `setFooter` always sits below the editor and `setHeader` above
	 * it; a `setWidget` component factory takes its placement from the same
	 * `{ placement: "aboveEditor" | "belowEditor" }` option the string-line form honours (M3).
	 */
	readonly belowEditor?: boolean;
};

type Mount = {
	readonly id: string;
	readonly kind: TerminalSurfaceKind;
	readonly terminal: HeadlessTerminal;
	readonly tui: TuiShim;
	readonly scheduler: StreamingFrameScheduler<true>;
	/** Raw (unconverted) overlay options resolver — kept raw so `visible()` can still be called. */
	readonly overlayOptionsResolver: (() => OverlayOptions | undefined) | undefined;
	readonly overlay: boolean;
	/** Mirrors `ExtensionUIContext.setWidget`'s `belowEditor`/`aboveEditor` option (M3). */
	readonly belowEditor: boolean;
	component: DisposableComponent | undefined;
	title: string | undefined;
	revision: number;
	disposed: boolean;
	/**
	 * Aborts the outstanding `custom()` promise (resolving it `undefined`);
	 * only set for `mountCustom` surfaces. A real `done(result)` resolution
	 * goes through `mountCustom`'s own closure instead of this field — `T`
	 * is erased on `Mount` (one map holds every surface's mount, whatever
	 * its `custom<T>()` type argument was), so this abort-only hook never
	 * needs to carry a result value.
	 */
	settle: (() => void) | undefined;
};

export type TerminalSurfaceControllerOptions = {
	/** Called with the full current surface list after every coalesced frame commit or disposal. */
	onUpdate: (surfaces: readonly TerminalSurface[]) => void;
};

/**
 * Owns every headless `pi-tui` `TUI`/`Component` mount for one session (one
 * `TerminalSurfaceController` per `ExtensionUiController`, matching its
 * per-`RuntimeController` lifetime). Each surface — a `custom()` overlay or
 * inline replacement, a `setWidget` component, a `setFooter`/`setHeader`
 * component — gets its own `HeadlessTerminal` + `TuiShim` + coalesced
 * `StreamingFrameScheduler`, so one surface's high-frequency re-renders
 * (an animated spinner inside a `custom()` overlay) never starve another
 * surface's frames or the rest of the app's commit pipeline.
 */
export class TerminalSurfaceController {
	readonly #mounts = new Map<string, Mount>();
	readonly #snapshots = new Map<string, TerminalSurface>();
	/**
	 * `ExtensionUIContext.custom()`'s `keybindings` parameter is typed as
	 * pi-coding-agent's own `KeybindingsManager` subclass (adds `reload()`/
	 * `getEffectiveConfig()`/a private `configPath` over pi-tui's base
	 * class), but that subclass is only re-exported *type-only* from the
	 * package root — its `export declare class` lives under `core/
	 * keybindings.ts`, outside the package's public `exports` map, so it
	 * cannot be constructed here.
	 *
	 * SAFETY: pi-tui's real `KeybindingsManager` (which the exported type
	 * extends, adding only members no `Component` reads: `reload()`,
	 * `getEffectiveConfig()`, a private `configPath`) is constructed instead
	 * and asserted to the exported subtype; every extension-visible member
	 * of that subtype is inherited unchanged from this base class.
	 */
	readonly #keybindings = new TuiKeybindingsManager(
		TUI_KEYBINDINGS,
	) as KeybindingsManager;

	constructor(private readonly options: TerminalSurfaceControllerOptions) {}

	get keybindings(): KeybindingsManager {
		return this.#keybindings;
	}

	/**
	 * Mirrors real interactive-mode's `showExtensionCustom`: resolves the
	 * component from `factory`, then either shows it as an overlay or mounts
	 * it inline as this surface's sole root child. Resolves when `done()` is
	 * called (by the component itself, or by `dispose()`/`disposeAll()`
	 * externally) — never rejects, matching the "never throw into the
	 * extension" non-negotiable; a factory that throws or rejects resolves
	 * `undefined` instead.
	 */
	async mountCustom<T>(params: MountCustomParams<T>): Promise<T> {
		const { promise, resolve } = Promise.withResolvers<T>();
		let settled = false;
		const resolveWith = (result: T | undefined) => {
			if (settled) return;
			settled = true;
			// SAFETY: a `dispose()`-driven abort has no real `T` to offer and
			// intentionally resolves `undefined` regardless (see the doc
			// comment above and `Mount.settle`) — matching every other
			// `ExtensionUIContext` method's "never throw, resolve undefined
			// on abort" contract, even for a `T` that doesn't itself include
			// `undefined`.
			resolve(result as T);
		};
		const mount = this.#create({
			id: params.id,
			kind: params.overlay ? "overlay" : "inline",
			overlay: params.overlay,
			title: params.title,
			colorScheme: params.colorScheme,
			cols: params.cols,
			rows: params.rows,
			overlayOptionsResolver: params.overlayOptions
				? () => resolveOverlayOptions(params.overlayOptions)
				: undefined,
		});
		mount.settle = () => resolveWith(undefined);
		const theme = resolveTerminalTheme(params.colorScheme);
		const close = (result: T) => {
			if (settled) return;
			resolveWith(result);
			this.dispose(params.id);
		};
		let component: DisposableComponent;
		try {
			component = await params.factory(mount.tui, theme, this.#keybindings, close);
		} catch (error) {
			console.error(`Terminal surface "${params.id}" factory failed`, error);
			this.dispose(params.id);
			return promise;
		}
		if (settled) {
			// `close()`/`dispose()` already ran while the factory was still
			// resolving (e.g. session switch mid-await) — never mount a
			// component onto an already-torn-down surface.
			try {
				component.dispose?.();
			} catch {
				/* ignore dispose errors */
			}
			return promise;
		}
		mount.component = component;
		if (params.overlay) {
			const resolvedOptions = resolveOverlayOptions(params.overlayOptions);
			const handle = mount.tui.showOverlay(component, resolvedOptions);
			try {
				params.onHandle?.(handle);
			} catch (error) {
				console.error(`Terminal surface "${params.id}" onHandle failed`, error);
			}
		} else {
			mount.tui.addChild(component);
			mount.tui.setFocus(component);
		}
		this.#commitFrame(params.id);
		return promise;
	}

	/** Mounts (or replaces) a persistent, non-blocking surface: a widget/footer/header component. */
	mountPersistent(params: MountPersistentParams): void {
		this.dispose(params.id);
		const mount = this.#create({
			id: params.id,
			kind: params.kind,
			overlay: false,
			title: params.title,
			colorScheme: params.colorScheme,
			cols: params.cols,
			rows: params.rows,
			overlayOptionsResolver: undefined,
			// A footer always sits below the editor (matching the TUI); a header stays
			// above it; a widget takes its placement from the caller's option (M3).
			belowEditor: params.kind === "footer" || params.belowEditor === true,
		});
		const theme = resolveTerminalTheme(params.colorScheme);
		let component: DisposableComponent;
		try {
			component = params.factory(
				mount.tui,
				theme,
				params.footerData ?? noopFooterData,
			);
		} catch (error) {
			console.error(`Terminal surface "${params.id}" factory failed`, error);
			this.dispose(params.id);
			return;
		}
		mount.component = component;
		mount.tui.addChild(component);
		mount.tui.setFocus(component);
		this.#commitFrame(params.id);
	}

	/** Routes a raw terminal byte sequence (already client-encoded) to a surface. Returns `false` if unknown. */
	handleInput(id: string, data: string): boolean {
		const mount = this.#mounts.get(id);
		if (!mount || mount.disposed) return false;
		mount.tui.handleInput(data);
		return true;
	}

	/** Applies a client-measured grid resize. Returns `false` if the surface is unknown. */
	resize(id: string, size: { columns: number; rows: number }): boolean {
		const mount = this.#mounts.get(id);
		if (!mount || mount.disposed) return false;
		// The size is client-measured and untrusted; `setSize` clamps it (`clampTerminalSize`).
		mount.terminal.setSize(size);
		return true;
	}

	/** Disposes one surface: stops its terminal, disposes its component, resolves any pending promise. */
	dispose(id: string): void {
		const mount = this.#mounts.get(id);
		if (!mount || mount.disposed) return;
		mount.disposed = true;
		mount.scheduler.clear();
		mount.tui.stop();
		try {
			mount.component?.dispose?.();
		} catch (error) {
			console.error(`Terminal surface "${id}" dispose() failed`, error);
		}
		mount.settle?.();
		this.#mounts.delete(id);
		this.#snapshots.delete(id);
		this.#publish();
	}

	/** Disposes every surface — session switch, reload, or runtime teardown. */
	disposeAll(): void {
		for (const id of this.#mounts.keys()) this.dispose(id);
	}

	snapshot(): TerminalSurface[] {
		return [...this.#snapshots.values()];
	}

	#create(params: {
		id: string;
		kind: TerminalSurfaceKind;
		overlay: boolean;
		title: string | undefined;
		colorScheme: TerminalSurfaceColorScheme;
		cols: number | undefined;
		rows: number | undefined;
		overlayOptionsResolver: (() => OverlayOptions | undefined) | undefined;
		belowEditor?: boolean;
	}): Mount {
		const size = clampTerminalSize({
			columns: params.cols ?? defaultTerminalColumns,
			rows: params.rows ?? defaultTerminalRows,
		});
		const terminal = new HeadlessTerminal(size);
		const tui = new TuiShim(terminal, {
			requestRender: (force) => {
				if (force) mount.scheduler.flush(true);
				else mount.scheduler.schedule(true);
			},
		});
		const scheduler = new StreamingFrameScheduler<true>(() =>
			this.#commitFrame(params.id),
		);
		scheduler.setDisplayHz(surfaceFrameHz);
		const mount: Mount = {
			id: params.id,
			kind: params.kind,
			terminal,
			tui,
			scheduler,
			overlayOptionsResolver: params.overlayOptionsResolver,
			overlay: params.overlay,
			belowEditor: params.belowEditor === true,
			component: undefined,
			title: params.title,
			revision: 0,
			disposed: false,
			settle: undefined,
		};
		this.#mounts.set(params.id, mount);
		tui.start();
		return mount;
	}

	#commitFrame(id: string): void {
		const mount = this.#mounts.get(id);
		if (!mount || mount.disposed) return;
		const cols = mount.terminal.columns;
		const rows = mount.terminal.rows;
		const rawOverlayOptions = mount.overlayOptionsResolver?.();
		if (rawOverlayOptions?.visible && !rawOverlayOptions.visible(cols, rows)) {
			// The extension's own responsive predicate says "don't show this
			// overlay at this size" — keep the last published frame rather than
			// publishing an empty one.
			return;
		}
		const overlayOptions = mount.overlay
			? toTerminalSurfaceOverlayOptions(rawOverlayOptions)
			: undefined;
		const rawLines = mount.tui.render(cols).slice(0, maxTerminalSurfaceLines);
		// An overlay renders at its resolved `OverlayOptions.width`, not the full grid.
		const width =
			mount.overlay && mount.tui.lastOverlayWidth > 0
				? mount.tui.lastOverlayWidth
				: cols;
		const lines: string[] = [];
		let cursor: TerminalSurface["cursor"];
		for (const [index, rawLine] of rawLines.entries()) {
			const clipped =
				rawLine.length > maxTerminalSurfaceLineLength
					? rawLine.slice(0, maxTerminalSurfaceLineLength)
					: rawLine;
			const rendered = ansiLineToHtml(clipped);
			lines.push(rendered.html);
			if (rendered.cursorColumn !== undefined && cursor === undefined) {
				cursor = { row: index, column: rendered.cursorColumn };
			}
		}
		mount.revision += 1;
		this.#snapshots.set(id, {
			id,
			kind: mount.kind,
			title: mount.title,
			overlayOptions,
			belowEditor: mount.belowEditor,
			lines,
			cursor,
			cols,
			rows,
			width,
			revision: mount.revision,
		});
		this.#publish();
	}

	#publish(): void {
		this.options.onUpdate(this.snapshot());
	}
}

function isOverlayOptionsFactory(
	overlayOptions: OverlayOptions | (() => OverlayOptions) | undefined,
): overlayOptions is () => OverlayOptions {
	return typeof overlayOptions === "function";
}

function resolveOverlayOptions(
	overlayOptions: OverlayOptions | (() => OverlayOptions) | undefined,
): OverlayOptions | undefined {
	if (isOverlayOptionsFactory(overlayOptions)) {
		try {
			return overlayOptions();
		} catch (error) {
			console.error("Terminal surface overlayOptions() threw", error);
			return undefined;
		}
	}
	return overlayOptions;
}

function toTerminalSurfaceOverlayOptions(
	options: OverlayOptions | undefined,
): TerminalSurfaceOverlayOptions | undefined {
	if (!options) return {};
	return {
		width: sizeOption(options.width),
		minWidth: cellOption(options.minWidth),
		maxHeight: sizeOption(options.maxHeight),
		anchor: options.anchor,
		offsetX: cellOption(options.offsetX),
		offsetY: cellOption(options.offsetY),
		row: sizeOption(options.row),
		col: sizeOption(options.col),
		margin: cellOption(
			isNumber(options.margin)
				? options.margin
				: (options.margin?.top ?? options.margin?.left),
		),
		nonCapturing: options.nonCapturing,
	};
}

/**
 * Extensions are untrusted at runtime whatever their declared types say, and
 * these values end up in a `style` attribute, so only finite numbers and
 * pi-tui's `N%` size strings survive.
 */
function cellOption(value: number | undefined): number | undefined {
	return isNumber(value) ? value : undefined;
}

function sizeOption(value: number | string | undefined): number | string | undefined {
	if (isNumber(value)) return cellOption(value);
	return isString(value) && /^\d+(?:\.\d+)?%$/.test(value) ? value : undefined;
}

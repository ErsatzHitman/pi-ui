import type {
	AutocompleteProviderFactory,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	TerminalInputHandler,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

/** Not re-exported from the package root; derived from the context methods. */
type EditorFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];
type FooterFactory = Parameters<ExtensionUIContext["setFooter"]>[0];
type HeaderFactory = Parameters<ExtensionUIContext["setHeader"]>[0];

import type { PiUiElement } from "../extension-surface-types.ts";
import type {
	AppExtensionDialog,
	AppExtensionWidget,
	AppExtensionWorkingIndicator,
	AppStore,
} from "../state/app-store.ts";
import type { JsonValue } from "../utils/json-types.ts";
import { isString } from "../utils/type-guards.ts";
import { PiUiBridgeDecoder, PiUiElementStore } from "./pi-ui-bridge.ts";

const defaultWorkingVisible = true;

/**
 * A `Theme` stand-in for the web UI, where there is no terminal to paint
 * ANSI escapes into. Every styling method degrades to identity (returns its
 * text argument unstyled) instead of throwing, so an extension that always
 * calls `ctx.ui.theme.fg(...)` — rather than gating on `ctx.mode === "tui"` —
 * still runs to completion. `pi-ui` does not currently expose a way to
 * recolor extension-authored `Component` trees anyway (see `custom()`
 * below), so styling calls here are inherently cosmetic no-ops.
 */
// SAFETY: every trap below returns a plausible value for its property; no
// real `Theme` internals (private `fgColors`/`bgColors`/`mode` fields) are
// ever read through this placeholder.
const identityTheme = new Proxy({} as Theme, {
	get(_target, property) {
		if (property === "name") return "pi-ui";
		if (property === "sourcePath" || property === "sourceInfo") return undefined;
		if (property === "getColorMode") return () => "truecolor";
		if (property === "getFgAnsi" || property === "getBgAnsi") return () => "";
		if (
			property === "getThinkingBorderColor" ||
			property === "getBashModeBorderColor"
		) {
			return () => (text: string) => text;
		}
		// fg/bg/bold/italic/underline/inverse/strikethrough all take the text to
		// style as their last argument and otherwise only take style keys.
		return (...args: unknown[]) => args.findLast(isString) ?? "";
	},
});

type PendingDialog = {
	dialog: AppExtensionDialog;
	respond(value: string | undefined, cancelled: boolean): void;
	signal?: AbortSignal;
	abort?: () => void;
	timer?: ReturnType<typeof setTimeout>;
};

export type ExtensionUiControllerHooks = {
	/**
	 * Receives PIUI `channel` ops. When set, the owner stores channel snapshots (so PIUI
	 * channels and the `pi.events` tap share one store) and this controller does not
	 * write `AppStore.extensionChannels` itself.
	 */
	onChannel?: (channel: string, payload: JsonValue) => void;
};

/** Bridges pi extension UI requests to backend-owned web state. */
export class ExtensionUiController {
	readonly #queue: PendingDialog[] = [];
	readonly #statuses = new Map<string, string>();
	readonly #widgets = new Map<string, AppExtensionWidget>();
	/**
	 * Widget keys an extension mounted a `(tui, theme) => Component` factory
	 * onto instead of a `string[]`. pi-ui cannot render a live `pi-tui`
	 * `Component` tree (see `custom()`), so these are recorded for
	 * diagnostics/future Live Workspace surfacing only — never rendered, and
	 * any earlier string-line widget under the same key is cleared, matching
	 * "this key is now a component-only widget" semantics.
	 */
	readonly #componentWidgetKeys = new Set<string>();
	readonly #terminalInputHandlers = new Set<TerminalInputHandler>();
	readonly #autocompleteProviders: AutocompleteProviderFactory[] = [];
	readonly #piUiDecoder = new PiUiBridgeDecoder();
	readonly #piUiElements = new PiUiElementStore();
	#active: PendingDialog | undefined;
	#workingIndicator: AppExtensionWorkingIndicator | undefined;
	#workingMessage: string | undefined;
	#workingVisible = defaultWorkingVisible;
	#hiddenThinkingLabel: string | undefined;
	#toolsExpanded = false;
	#footerFactory: FooterFactory | undefined;
	#headerFactory: HeaderFactory | undefined;
	#editorComponentFactory: EditorFactory | undefined;

	constructor(
		private readonly store: AppStore,
		private readonly hooks: ExtensionUiControllerHooks = {},
	) {}

	context(isActive: () => boolean): ExtensionUIContext {
		return {
			select: (title, options, dialogOptions) =>
				this.select(isActive, title, options, dialogOptions),
			confirm: (title, message, dialogOptions) =>
				this.confirm(isActive, title, message, dialogOptions),
			input: (title, placeholder, dialogOptions) =>
				this.input(isActive, title, placeholder, dialogOptions),
			notify: (message, type = "info") => this.notify(isActive, message, type),
			onTerminalInput: (handler) => {
				if (!isActive()) return () => {};
				this.#terminalInputHandlers.add(handler);
				return () => {
					this.#terminalInputHandlers.delete(handler);
				};
			},
			setStatus: (key, text) => {
				if (!isActive()) return;
				if (text === undefined) this.#statuses.delete(key);
				else this.#statuses.set(key, text);
				this.store.setExtensionStatuses(
					this.#statuses
						.entries()
						.map(([key, text]) => ({ key, text }))
						.toArray(),
				);
			},
			setWorkingMessage: (message) => {
				if (!isActive()) return;
				this.#workingMessage = message;
				this.syncWorking();
			},
			setWorkingVisible: (visible) => {
				if (!isActive()) return;
				this.#workingVisible = visible;
				this.syncWorking();
			},
			setWorkingIndicator: (options) => {
				if (!isActive()) return;
				this.#workingIndicator = normalizeWorkingIndicator(options);
				this.syncWorking();
			},
			setHiddenThinkingLabel: (label) => {
				if (!isActive()) return;
				this.#hiddenThinkingLabel = label;
			},
			setWidget: (key, content, options) => {
				if (!isActive()) return;
				if (content === undefined) {
					this.#widgets.delete(key);
					this.#componentWidgetKeys.delete(key);
				} else if (Array.isArray(content)) {
					this.#componentWidgetKeys.delete(key);
					this.#widgets.set(key, {
						key,
						lines: [...content],
						placement: options?.placement ?? "aboveEditor",
					});
				} else {
					// A `(tui, theme) => Component` factory: pi-ui has no terminal to
					// mount it into. Record that the key is now component-owned and
					// drop any prior string-line rendering for it, without throwing.
					this.#widgets.delete(key);
					this.#componentWidgetKeys.add(key);
				}
				this.store.setExtensionWidgets(this.#widgets.values().toArray());
			},
			setFooter: (factory) => {
				if (isActive()) this.#footerFactory = factory;
			},
			setHeader: (factory) => {
				if (isActive()) this.#headerFactory = factory;
			},
			setTitle: (title) => {
				if (isActive()) this.store.setDocumentTitle(title);
			},
			custom: async <T>() => {
				// Matches the SDK's own real RPC-mode contract (a headless client
				// has no terminal to mount a `Component` into): resolve `undefined`
				// instead of throwing, so a command handler that awaits `custom()`
				// degrades gracefully rather than crashing. A future terminal-surface
				// host can replace this with a real headless render.
				// SAFETY: `undefined` is the documented RPC-mode resolution for
				// every caller of `custom()`, regardless of `T`.
				return undefined as T;
			},
			pasteToEditor: (text) => {
				if (!isActive()) return;
				this.setEditorText(`${this.store.promptEditorText}${text}`);
			},
			setEditorText: (text) => {
				if (isActive()) this.setEditorText(text);
			},
			getEditorText: () => (isActive() ? this.store.promptEditorText : ""),
			editor: (title, prefill) => this.editor(isActive, title, prefill),
			addAutocompleteProvider: (factory) => {
				if (isActive()) this.#autocompleteProviders.push(factory);
			},
			setEditorComponent: (factory) => {
				if (isActive()) this.#editorComponentFactory = factory;
			},
			getEditorComponent: () => this.#editorComponentFactory,
			theme: identityTheme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({
				success: false,
				error: "TUI themes are unavailable in pi-ui",
			}),
			getToolsExpanded: () => this.#toolsExpanded,
			setToolsExpanded: (expanded) => {
				if (isActive()) this.#toolsExpanded = expanded;
			},
		};
	}

	/**
	 * The label an extension asked to hide reasoning/thinking blocks behind.
	 * Recorded (never rendered) for Round 2's terminal-surface host to read.
	 */
	getHiddenThinkingLabel(): string | undefined {
		return this.#hiddenThinkingLabel;
	}

	/** The most recently registered footer `Component` factory, if any. */
	getFooterFactory(): FooterFactory | undefined {
		return this.#footerFactory;
	}

	/** The most recently registered header `Component` factory, if any. */
	getHeaderFactory(): HeaderFactory | undefined {
		return this.#headerFactory;
	}

	/**
	 * Captures this session's PIUI elements before it leaves the foreground
	 * (e.g. going to background), so `restorePiUiElements` can bring them back
	 * unchanged if the session returns — otherwise `cancelAll()` (called on
	 * every session switch) would silently drop a still-open panel/roster/form
	 * that the extension never re-sent because, from its point of view,
	 * nothing changed (r1-audit #23).
	 */
	snapshotPiUiElements(): PiUiElement[] {
		return this.#piUiElements.elements();
	}

	/**
	 * Restores a snapshot captured by {@link snapshotPiUiElements} and
	 * republishes it. Only PIUI elements are restored — pending dialogs,
	 * widgets, and statuses are intentionally not (a session switch still
	 * cancels those, matching the existing, verified behavior).
	 */
	restorePiUiElements(elements: readonly PiUiElement[]): void {
		if (elements.length === 0) return;
		this.#piUiElements.restore(elements);
		this.store.setExtensionElements(this.#piUiElements.elements());
	}

	respond(id: string, value: string | undefined, cancelled: boolean): boolean {
		if (this.#active?.dialog.id !== id) return false;
		const active = this.#active;
		this.finish(active);
		active.respond(value, cancelled);
		this.showNext();
		return true;
	}

	cancelAll(): void {
		const pending = [this.#active, ...this.#queue].filter(
			(dialog): dialog is PendingDialog => dialog !== undefined,
		);
		this.#active = undefined;
		this.#queue.length = 0;
		for (const dialog of pending) {
			this.cleanup(dialog);
			dialog.respond(undefined, true);
		}
		this.#statuses.clear();
		this.#widgets.clear();
		this.#componentWidgetKeys.clear();
		this.#terminalInputHandlers.clear();
		this.#autocompleteProviders.length = 0;
		this.#piUiDecoder.reset();
		this.#piUiElements.clear();
		this.#workingIndicator = undefined;
		this.#workingMessage = undefined;
		this.#workingVisible = defaultWorkingVisible;
		this.#hiddenThinkingLabel = undefined;
		this.#toolsExpanded = false;
		this.#footerFactory = undefined;
		this.#headerFactory = undefined;
		this.#editorComponentFactory = undefined;
		this.store.setExtensionDialog(undefined);
		this.store.setExtensionStatuses([]);
		this.store.setExtensionWidgets([]);
		this.store.setExtensionElements([]);
		// With an `onChannel` owner, channels are cleared by that owner on session switch.
		if (!this.hooks.onChannel) this.store.setExtensionChannels([]);
		this.syncWorking();
		this.store.setDocumentTitle("pi-ui");
	}

	private notify(
		isActive: () => boolean,
		message: string,
		type: "info" | "warning" | "error",
	): void {
		if (!isActive()) return;
		if (PiUiBridgeDecoder.isPiUiMessage(message)) {
			// Bridge-aware extensions (see `~/.pi/agent/extensions/lib/bridge.ts`)
			// speak the "Pi UI Bridge" (PIUI) protocol over this same fire-and-
			// forget `notify()` channel whenever they detect a live RPC-mode
			// client — which pi-ui always is. These payloads are structured
			// element updates, never user-facing text, so they must NEVER reach
			// the transcript as a notice, whether or not they decode cleanly.
			const op = this.#piUiDecoder.decode(message);
			if (!op) return;
			if (op.op === "channel" && this.hooks.onChannel) {
				this.hooks.onChannel(op.channel, op.payload);
				return;
			}
			this.#piUiElements.apply(op);
			if (op.op === "channel") {
				this.store.setExtensionChannels(this.#piUiElements.channels());
			} else {
				this.store.setExtensionElements(this.#piUiElements.elements());
			}
			return;
		}
		// Each level gets its own status-dot color and prefix in the transcript
		// (renderSystemMessage) instead of every notice reading "Warning: …"
		// regardless of severity — see r1-audit #24.
		this.store.appendMessage("notice", message, { noticeTone: type });
	}

	private select(
		isActive: () => boolean,
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		if (!isActive()) return Promise.resolve(undefined);
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		this.enqueue(
			{
				dialog: {
					id: crypto.randomUUID(),
					kind: "select",
					title,
					options: [...options],
				},
				respond: (value, cancelled) =>
					resolve(
						!cancelled && value !== undefined && options.includes(value)
							? value
							: undefined,
					),
			},
			dialogOptions,
		);
		return promise;
	}

	private confirm(
		isActive: () => boolean,
		title: string,
		message: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		if (!isActive()) return Promise.resolve(false);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		this.enqueue(
			{
				dialog: { id: crypto.randomUUID(), kind: "confirm", title, message },
				respond: (value, cancelled) => resolve(!cancelled && value === "confirm"),
			},
			dialogOptions,
		);
		return promise;
	}

	private input(
		isActive: () => boolean,
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.textDialog(
			isActive,
			{
				id: crypto.randomUUID(),
				kind: "input",
				title,
				placeholder,
			},
			dialogOptions,
		);
	}

	private editor(
		isActive: () => boolean,
		title: string,
		prefill?: string,
	): Promise<string | undefined> {
		return this.textDialog(isActive, {
			id: crypto.randomUUID(),
			kind: "editor",
			title,
			prefill,
		});
	}

	private textDialog(
		isActive: () => boolean,
		dialog: Extract<AppExtensionDialog, { kind: "input" | "editor" }>,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		if (!isActive()) return Promise.resolve(undefined);
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		this.enqueue(
			{
				dialog,
				respond: (value, cancelled) =>
					resolve(cancelled ? undefined : (value ?? "")),
			},
			dialogOptions,
		);
		return promise;
	}

	private enqueue(
		pending: PendingDialog,
		options: ExtensionUIDialogOptions | undefined,
	): void {
		if (options?.signal?.aborted) {
			pending.respond(undefined, true);
			return;
		}
		pending.signal = options?.signal;
		if (pending.signal) {
			pending.abort = () => this.abort(pending);
			pending.signal.addEventListener("abort", pending.abort, { once: true });
		}
		if (options?.timeout !== undefined) {
			pending.timer = setTimeout(() => this.abort(pending), options.timeout);
		}
		this.#queue.push(pending);
		this.showNext();
	}

	private showNext(): void {
		if (this.#active) return;
		this.#active = this.#queue.shift();
		this.store.setExtensionDialog(this.#active?.dialog);
	}

	private abort(pending: PendingDialog): void {
		if (pending === this.#active) {
			this.finish(pending);
			pending.respond(undefined, true);
			this.showNext();
			return;
		}
		const index = this.#queue.indexOf(pending);
		if (index < 0) return;
		this.#queue.splice(index, 1);
		this.cleanup(pending);
		pending.respond(undefined, true);
	}

	private finish(pending: PendingDialog): void {
		this.cleanup(pending);
		this.#active = undefined;
		this.store.setExtensionDialog(undefined);
	}

	private cleanup(pending: PendingDialog): void {
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		if (pending.signal && pending.abort) {
			pending.signal.removeEventListener("abort", pending.abort);
		}
	}

	private setEditorText(text: string): void {
		this.store.setPromptEditorText(text);
	}

	private syncWorking(): void {
		this.store.setExtensionWorking({
			message: this.#workingMessage,
			visible: this.#workingVisible,
			indicator: this.#workingIndicator,
		});
	}
}

function normalizeWorkingIndicator(
	options: WorkingIndicatorOptions | undefined,
): AppExtensionWorkingIndicator | undefined {
	if (!options?.frames) return undefined;
	return { frames: [...options.frames], intervalMs: options.intervalMs };
}

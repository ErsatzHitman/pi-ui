// Matches bun-types' `*.txt` declaration (extensions.d.ts) for a Bun `type: "text"`
// import assertion, which bun-types doesn't cover for `.md` — used to embed
// pi-coding-agent's CHANGELOG.md into the compiled binary for `/changelog`.
declare module "*.md" {
	const content: string;
	export default content;
}

interface TransferFileCollection {
	readonly length: number;
}

interface FileTransferData {
	readonly files?: TransferFileCollection;
	readonly types?: readonly string[];
}

interface PiUiNamespace {
	controls: {
		refresh(root?: Document | Element): void;
		activate(command: HTMLElement, active: HTMLElement): void;
	};
	codeTheme: {
		loadFontPreviews(light: string, dark: string): void;
		loadPreviews(): void;
	};
	dateTime: {
		hydrate(element: HTMLTimeElement): void;
	};
	fonts: {
		apply(mono: string, sans: string): void;
	};
	fileTransfer: {
		pick(): Promise<void>;
		hasFiles(data?: FileTransferData): boolean;
		insert(data?: FileTransferData | TransferFileCollection): Promise<void>;
		hasAttachments(): boolean;
		canSubmit(prompt: string): boolean;
		submit(
			endpoint: string,
			prompt: string,
			streamingBehavior?: "steer" | "followUp",
		): Promise<boolean>;
		enterDrag(): boolean;
		leaveDrag(): boolean;
		resetDrag(): void;
	};
	messageScroll: {
		bindResize(): void;
		captureAnchor(): boolean;
		/** Arms the send-time prompt-spacer hold (real submit paths only, not /copy). */
		holdSpacerForSend(): void;
		hydratePierreDiff(element: HTMLElement): void;
		/** Gates nested entries while a whole transcript is inserted (ui-renderer.ts). */
		quietTranscript(options?: { hold?: boolean }): void;
		restoreAnchor(): void;
		/** Crossfades the pending "thinking..." row out in place (ui-renderer.ts). */
		retirePending(replaced?: boolean): void;
		scrollBottom(behavior?: "auto" | "smooth"): void;
		trimOldMessages(): void;
	};
	/** `static/app/motion.js` for Datastar expressions (addendum C-X4). */
	motion: {
		enter(
			element: Element | null | undefined,
			options?: { from?: "fade" | "rise" | "pop"; delay?: number },
		): Animation | undefined;
	};
	/** Pane motion engine (`src/client/pane-motion.ts`, WP-B); armed synchronously by
	 * every pane trigger before it changes the DOM (flow-critique #1). */
	paneMotion?: {
		arm(pane: "sessions" | "live" | "review", willOpen: boolean): void;
	};
	modelSearch: {
		filter(input: HTMLInputElement, query: string): void;
	};
	pickers: {
		close(): void;
		complete(name: string): void;
		fuzzyMatch(query: string, text: string): { matches: boolean; score: number };
		isFileOpen(): boolean;
		isOpen(): boolean;
		sync(reset?: boolean): void;
	};
	prompt: {
		clear(): void;
	};
	promptHistory: {
		handleInput(): void;
		handleKeydown(event: KeyboardEvent, entries: readonly string[]): boolean;
	};
	sessionPerformance: {
		observe(status: string, generation: number): void;
		start(): void;
	};
	windowFocus: {
		restore(): void;
		suspend(): void;
	};
	workspaceReview: {
		applyOpen(open: boolean): void;
		focusEditor(): void;
		focusFiles(): void;
		focusGit(): void;
	};
	liveWorkspace: {
		applyOpen(open: boolean): void;
		requestNotificationPermission(): Promise<void>;
		needsNotificationPermission(): boolean;
		notificationsOptedIn(): boolean;
	};
	/** `Last-Event-ID` for a forced stream reconnect (`static/app/stream-reconnect.js`). */
	streamResumeHeaders(): Record<string, string>;
	/** Web Push opt-in (`static/app/push.js`); set once the service worker is ready. */
	push?: {
		covers(): boolean;
	};
	notifications: {
		sessionFinished(detail: {
			id: number;
			workspace: string;
			sessionPath?: string;
		}): boolean;
	};
	terminal: {
		encodeKey(event: KeyboardEvent): string | undefined;
		encodePaste(text: string): string;
		encodeWheel(event: WheelEvent): string | undefined;
		fitColumns(element: HTMLElement): number | undefined;
		send(endpoint: string, surfaceId: string, data: string): void;
	};
	shouldAbortOnEscape(event: KeyboardEvent): boolean;
}

interface Window {
	piUi: PiUiNamespace;
}

declare namespace JSX {
	interface HtmlTag {
		autofocus?: boolean;
	}

	interface IntrinsicElements {
		"datastar-inspector": Record<string, never>;
	}
}

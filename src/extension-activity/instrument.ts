import type {
	Extension,
	ExtensionContext,
	ExtensionShortcut,
	ExtensionUIContext,
	RegisteredCommand,
	RegisteredTool,
} from "@earendil-works/pi-coding-agent";

import type {
	ExtensionActivityTrigger,
	ExtensionRef,
} from "../extension-activity-types.ts";
import { isRecord, isString } from "../utils/type-guards.ts";
import type { IdentitySource } from "./identity.ts";
import type { UiSignal } from "./ledger.ts";
import { isTimedHookEvent } from "./policy.ts";

/**
 * `Extension.handlers`' real element type (`HandlerFn` in the SDK's
 * `extensions/types.ts`, not exported): every runner call site does
 * `await handler(event, ctx)` — see `DESIGN-ext-activity.md` F9. `Result`
 * defaults to (and this module always uses) `unknown`, expressed as a
 * generic parameter rather than written inline so the compiled-away resolved
 * value's type is never inspected here — this module never needs it to be
 * anything narrower, since it only ever forwards it opaquely.
 */
type RawHandlerFn<Result = unknown> = (...args: unknown[]) => Promise<Result>;

/** One timed or carrier scope a hook/tool/command/shortcut invocation runs
 * in — the identity every `ctx.ui` call inside it is attributed to. A timed
 * scope is unique per invocation; a carrier scope is cached and reused per
 * `(extension, event)`, since carrier events (`message_start`, `tool_execution_*`,
 * …) can fire at high frequency and must allocate nothing per call (§2.3 point 5). */
export type InstrumentedScope = Readonly<{
	scopeId: string;
	timed: boolean;
	extension: ExtensionRef;
	trigger: ExtensionActivityTrigger;
	title: string;
	toolCallId?: string;
	/** The raw hook event object a timed hook scope was invoked with — lets
	 * the tracker diff a hook's return value against what it was actually
	 * given (e.g. `before_agent_start`'s `systemPrompt`, `context`'s
	 * `messages`) instead of always reporting the return value verbatim, per
	 * `DESIGN-ext-activity.md` §2.3. Only set for timed hook scopes: a carrier
	 * scope is cached and reused across dispatches (§2.3 point 5), so it has
	 * no single event to attach. */
	hookEvent?: unknown;
}>;

export type ScopeOutcomeRaw =
	| Readonly<{ ok: true; result: unknown }>
	| Readonly<{ ok: false; error: unknown }>;

/**
 * What `instrument.ts` reports; `ExtensionActivityTracker` implements this.
 * Every method here is called from inside a `try`/wrapped context in this
 * module — a throwing reporter can never change what the wrapped
 * handler/tool/command/shortcut itself returns or throws (transparency).
 */
export type InstrumentationReporter = Readonly<{
	scopeStart(scope: InstrumentedScope, now: number): void;
	/** `outcome.result`/`outcome.error` are the RAW hook/tool return value or
	 * thrown error; turning that into an activity's summary/output is
	 * event-specific and is the tracker's job, not this module's. */
	scopeEnd(scope: InstrumentedScope, now: number, outcome: ScopeOutcomeRaw): void;
	uiSignal(scope: InstrumentedScope, signal: UiSignal, now: number): void;
}>;

export type Clock = () => number;

const instrumentedExtensions = new WeakSet<Extension>();

/**
 * Wraps every handler, extension-owned tool, command and shortcut of each
 * not-yet-instrumented, non-hidden extension so every `ctx.ui` call it makes
 * — including one made long after its own hook/tool run returned, from a
 * closure that captured `ctx` (JEV's delayed widget close) — is attributed to
 * that extension and the run that caused it, and so timed runs report their
 * start/end to `reporter`. Every wrapped function's return value, thrown
 * error, argument identity (`signal`, `onUpdate`) and `this`-binding are
 * unchanged — see `instrument_test.ts`'s pinned contract. Idempotent per
 * `Extension` object (a `WeakSet`, matching `#piUiStores`'s pattern
 * elsewhere): call again after every reload/rebuild with the SDK's current
 * `LoadExtensionsResult.extensions` and already-instrumented ones are
 * skipped.
 */
export function instrumentExtensions(
	extensions: readonly Extension[],
	reporter: InstrumentationReporter,
	resolveRef: (source: IdentitySource) => ExtensionRef,
	clock: Clock = Date.now,
): void {
	for (const extension of extensions) {
		if (extension.hidden) continue;
		if (instrumentedExtensions.has(extension)) continue;
		instrumentedExtensions.add(extension);
		const ref = resolveRef({
			resolvedPath: extension.resolvedPath,
			source: extension.sourceInfo.source,
		});
		const carrierScopes = new Map<string, InstrumentedScope>();
		instrumentHandlers(extension, ref, reporter, clock, carrierScopes);
		instrumentTools(extension, ref, reporter, clock);
		instrumentCommands(extension, ref, reporter, clock);
		instrumentShortcuts(extension, ref, reporter, clock);
	}
}

function carrierScopeFor(
	carrierScopes: Map<string, InstrumentedScope>,
	ref: ExtensionRef,
	event: string,
): InstrumentedScope {
	const existing = carrierScopes.get(event);
	if (existing) return existing;
	const scope: InstrumentedScope = {
		scopeId: `carrier:${ref.id}:${event}`,
		timed: false,
		extension: ref,
		trigger: { kind: "hook", event },
		title: event,
	};
	carrierScopes.set(event, scope);
	return scope;
}

function extractToolCallId<Value>(hookEvent: Value): string | undefined {
	if (!isRecord(hookEvent)) return undefined;
	const candidate = hookEvent.toolCallId;
	return isString(candidate) ? candidate : undefined;
}

/**
 * Every runner call site reads `ext.handlers.get(event)?.slice() ?? []`
 * (F9). Converting each stored array to an `InstrumentedHandlerList` (whose
 * overridden `slice()` returns wrapped functions, everything else — `push`,
 * `indexOf`, `splice`, `.length` — inherited from `Array.prototype`
 * untouched) and overriding this `Map` instance's own `set` to convert any
 * array a later `pi.on` call stores is therefore the single hook point: it
 * needs no change to the loader or runner themselves.
 */
function instrumentHandlers(
	extension: Extension,
	ref: ExtensionRef,
	reporter: InstrumentationReporter,
	clock: Clock,
	carrierScopes: Map<string, InstrumentedScope>,
): void {
	const handlers = extension.handlers;
	const wrapCache = new WeakMap<RawHandlerFn, RawHandlerFn>();
	const wrap = (event: string, list: RawHandlerFn[]): InstrumentedHandlerList => {
		if (list instanceof InstrumentedHandlerList) return list;
		const instrumented = new InstrumentedHandlerList(
			ref,
			event,
			reporter,
			clock,
			carrierScopes,
			wrapCache,
		);
		instrumented.push(...list);
		return instrumented;
	};

	// Convert whatever is already registered (`session_start` listeners bound
	// before `createRuntime` calls this) using the native `Map.prototype.set`,
	// before this instance's own `set` is overridden below.
	for (const [event, list] of handlers) {
		if (!(list instanceof InstrumentedHandlerList))
			handlers.set(event, wrap(event, list));
	}

	const nativeSet = handlers.set.bind(handlers);
	Object.defineProperty(handlers, "set", {
		value: (event: string, list: RawHandlerFn[]) =>
			nativeSet(event, wrap(event, list)),
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

class InstrumentedHandlerList extends Array<RawHandlerFn> {
	static override readonly [Symbol.species] = Array;

	readonly #ref: ExtensionRef;
	readonly #event: string;
	readonly #reporter: InstrumentationReporter;
	readonly #clock: Clock;
	readonly #carrierScopes: Map<string, InstrumentedScope>;
	readonly #wrapCache: WeakMap<RawHandlerFn, RawHandlerFn>;

	constructor(
		ref: ExtensionRef,
		event: string,
		reporter: InstrumentationReporter,
		clock: Clock,
		carrierScopes: Map<string, InstrumentedScope>,
		wrapCache: WeakMap<RawHandlerFn, RawHandlerFn>,
	) {
		super();
		this.#ref = ref;
		this.#event = event;
		this.#reporter = reporter;
		this.#clock = clock;
		this.#carrierScopes = carrierScopes;
		this.#wrapCache = wrapCache;
	}

	override slice(start?: number, end?: number): RawHandlerFn[] {
		// SAFETY: `Symbol.species = Array` makes `super.slice()` return a plain
		// `Array`, never another `InstrumentedHandlerList` — `Array.prototype.slice`
		// always produces `Elem[]` for that species, matching this cast.
		const originals = super.slice(start, end) as RawHandlerFn[];
		return originals.map((fn) => this.#wrapOne(fn));
	}

	#wrapOne(fn: RawHandlerFn): RawHandlerFn {
		const cached = this.#wrapCache.get(fn);
		if (cached) return cached;
		const wrapped = createHookWrapper(
			fn,
			this.#ref,
			this.#event,
			this.#reporter,
			this.#clock,
			this.#carrierScopes,
		);
		this.#wrapCache.set(fn, wrapped);
		return wrapped;
	}
}

function createHookWrapper(
	original: RawHandlerFn,
	ref: ExtensionRef,
	event: string,
	reporter: InstrumentationReporter,
	clock: Clock,
	carrierScopes: Map<string, InstrumentedScope>,
): RawHandlerFn {
	const timed = isTimedHookEvent(event);
	// `hookEvent`/`ctx`/`rest` are intentionally left unannotated: every real
	// call site is `await handler(event, ctx)` (F9), and their types flow from
	// `RawHandlerFn`'s own signature through this function's declared
	// `RawHandlerFn` return type instead of a written `unknown` annotation.
	return async (hookEvent, ctx, ...rest) => {
		const scope: InstrumentedScope = timed
			? {
					scopeId: `hook:${crypto.randomUUID()}`,
					timed: true,
					extension: ref,
					trigger: { kind: "hook", event },
					title: event,
					toolCallId: extractToolCallId(hookEvent),
					hookEvent,
				}
			: carrierScopeFor(carrierScopes, ref, event);
		report(() => reporter.scopeStart(scope, clock()));
		const proxiedCtx = isExtensionContext(ctx)
			? proxyCtx(ctx, scope, reporter, clock)
			: ctx;
		try {
			const result = await original(hookEvent, proxiedCtx, ...rest);
			report(() => reporter.scopeEnd(scope, clock(), { ok: true, result }));
			return result;
		} catch (error) {
			report(() => reporter.scopeEnd(scope, clock(), { ok: false, error }));
			throw error;
		}
	};
}

/**
 * Wrapper → the function it wraps, for every tool `execute`, command handler
 * and shortcut handler this module installed. A tool definition object can be
 * shared by several `Extension` objects (a module-level definition registered
 * again when the SDK's factory cache re-runs a factory for another runtime),
 * so a definition met again is re-wrapped from its *original* function, never
 * stacked: one call must report one scope.
 */
const originalByWrapper = new WeakMap<object, unknown>();

function unwrapped<Fn extends object>(fn: Fn): Fn {
	const original = originalByWrapper.get(fn);
	// SAFETY: `originalByWrapper` only ever maps a wrapper to the same-typed
	// function it replaced (`wrapToolExecute`/`instrumentCommand`/`instrumentShortcut`).
	return original === undefined ? fn : (original as Fn);
}

/**
 * Runs `run` for every entry already in `map`, and again for every entry a
 * later `map.set` stores — the SDK's `registerTool`/`registerCommand`/
 * `registerShortcut` are plain `Map.set` calls on the `Extension`, and an
 * extension may register from `session_start` (after this module ran), e.g.
 * `bash-background.ts` registering its per-session `bash`.
 */
function instrumentMapEntries<Key, Value>(
	map: Map<Key, Value>,
	run: (key: Key, value: Value) => void,
): void {
	for (const [key, value] of map) run(key, value);
	const nativeSet = map.set.bind(map);
	Object.defineProperty(map, "set", {
		value: (key: Key, value: Value) => {
			try {
				run(key, value);
			} catch {
				// Instrumentation must never change whether a registration succeeds.
			}
			return nativeSet(key, value);
		},
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

function instrumentTools(
	extension: Extension,
	ref: ExtensionRef,
	reporter: InstrumentationReporter,
	clock: Clock,
): void {
	instrumentMapEntries(extension.tools, (toolName, registered) => {
		wrapToolExecute(registered.definition, toolName, ref, reporter, clock);
	});
}

type ToolExecute = RegisteredTool["definition"]["execute"];

function wrapToolExecute(
	definition: RegisteredTool["definition"],
	toolName: string,
	ref: ExtensionRef,
	reporter: InstrumentationReporter,
	clock: Clock,
): void {
	const original: ToolExecute = unwrapped(definition.execute);
	// A `function` (not an arrow) so `this` stays whatever the caller bound —
	// the SDK calls `definition.execute(…)`, so a method-style `execute` that
	// reads `this` keeps seeing its own definition. Every argument, including
	// any the SDK adds after `ctx`, is forwarded as-is.
	const wrapped = async function (
		this: RegisteredTool["definition"],
		...args: Parameters<ToolExecute>
	): ReturnType<ToolExecute> {
		const [toolCallId, , , , ctx] = args;
		const scope: InstrumentedScope = {
			scopeId: `tool:${crypto.randomUUID()}`,
			timed: true,
			extension: ref,
			trigger: { kind: "tool", toolName, toolCallId },
			title: toolName,
			toolCallId,
		};
		report(() => reporter.scopeStart(scope, clock()));
		const forwarded = [...args];
		if (isExtensionContext(ctx)) forwarded[4] = proxyCtx(ctx, scope, reporter, clock);
		try {
			// SAFETY: `forwarded` is `args` with at most `ctx` swapped for a
			// Proxy of the same object, so it still matches `ToolExecute`'s own
			// parameter list.
			const result = await original.apply(
				this,
				forwarded as Parameters<ToolExecute>,
			);
			report(() => reporter.scopeEnd(scope, clock(), { ok: true, result }));
			return result;
		} catch (error) {
			report(() => reporter.scopeEnd(scope, clock(), { ok: false, error }));
			throw error;
		}
	};
	originalByWrapper.set(wrapped, original);
	definition.execute = wrapped;
}

function instrumentCommands(
	extension: Extension,
	ref: ExtensionRef,
	reporter: InstrumentationReporter,
	clock: Clock,
): void {
	instrumentMapEntries(extension.commands, (name, command) => {
		type CommandHandler = RegisteredCommand["handler"];
		const original: CommandHandler = unwrapped(command.handler);
		const wrapped = async function (
			this: RegisteredCommand,
			...args: Parameters<CommandHandler>
		): ReturnType<CommandHandler> {
			const [, ctx] = args;
			const scope: InstrumentedScope = {
				scopeId: `command:${crypto.randomUUID()}`,
				timed: true,
				extension: ref,
				trigger: { kind: "command", name },
				title: `/${name}`,
			};
			report(() => reporter.scopeStart(scope, clock()));
			const forwarded = [...args];
			if (isExtensionContext(ctx))
				forwarded[1] = proxyCtx(ctx, scope, reporter, clock);
			try {
				// SAFETY: same reasoning as `wrapToolExecute`'s `forwarded`.
				const result = await original.apply(
					this,
					forwarded as Parameters<CommandHandler>,
				);
				report(() =>
					reporter.scopeEnd(scope, clock(), { ok: true, result: undefined }),
				);
				return result;
			} catch (error) {
				report(() => reporter.scopeEnd(scope, clock(), { ok: false, error }));
				throw error;
			}
		};
		originalByWrapper.set(wrapped, original);
		command.handler = wrapped;
	});
}

function instrumentShortcuts(
	extension: Extension,
	ref: ExtensionRef,
	reporter: InstrumentationReporter,
	clock: Clock,
): void {
	instrumentMapEntries(extension.shortcuts, (key, shortcut) => {
		type ShortcutHandler = ExtensionShortcut["handler"];
		const original: ShortcutHandler = unwrapped(shortcut.handler);
		const wrapped = async function (
			this: ExtensionShortcut,
			...args: Parameters<ShortcutHandler>
		): Promise<Awaited<ReturnType<ShortcutHandler>>> {
			const [ctx] = args;
			const scope: InstrumentedScope = {
				scopeId: `shortcut:${crypto.randomUUID()}`,
				timed: true,
				extension: ref,
				trigger: { kind: "shortcut", key },
				title: key,
			};
			report(() => reporter.scopeStart(scope, clock()));
			const forwarded = [...args];
			if (isExtensionContext(ctx))
				forwarded[0] = proxyCtx(ctx, scope, reporter, clock);
			try {
				// SAFETY: same reasoning as `wrapToolExecute`'s `forwarded`.
				const result = await original.apply(
					this,
					forwarded as Parameters<ShortcutHandler>,
				);
				report(() =>
					reporter.scopeEnd(scope, clock(), { ok: true, result: undefined }),
				);
				return result;
			} catch (error) {
				report(() => reporter.scopeEnd(scope, clock(), { ok: false, error }));
				throw error;
			}
		};
		originalByWrapper.set(wrapped, original);
		shortcut.handler = wrapped;
	});
}

/** A predicate wrapper around `typeof value === "function"`, so the runtime
 * check lives inside a type-guard function (this module's lint policy exempts
 * `typeof` only there) instead of inline at each call site. `Result` defaults
 * to `unknown` via a generic parameter (never written inline) for the same
 * reason as `RawHandlerFn` above — the narrowed value is only ever `.bind()`-ed
 * and forwarded, never called or inspected by this module. */
function isCallable<Value, Result = unknown>(
	value: Value,
): value is Value & ((...args: never[]) => Result) {
	return typeof value === "function";
}

/**
 * `new Proxy(ctx, { get(t, p) { const v = t[p]; … } })`: `ui` is read
 * through the real getter on every access (so the stale-ctx assertion
 * behaves exactly as before, F10). Plain property access — not
 * `Reflect.get(t, p, t)` — is used deliberately: with the receiver argument
 * equal to the target (as here), they are exactly equivalent, and this
 * module's lint policy bans `Reflect.get`. Everything else passes through
 * untouched except being (harmlessly) `.bind(target)`ed when it's a function.
 */
function proxyCtx<T extends ExtensionContext>(
	ctx: T,
	scope: InstrumentedScope,
	reporter: InstrumentationReporter,
	clock: Clock,
): T {
	return new Proxy(ctx, {
		get(target, property) {
			if (property === "ui") return proxyUi(target.ui, scope, reporter, clock);
			// SAFETY: this trap only ever runs for a real access on `target`
			// (`property` is whatever key the caller just read), so indexing
			// `target` by it, widened to `keyof T`, reads the same value plain
			// `target[property]` would if TypeScript could express a dynamic key.
			const value = target[property as keyof T];
			return isCallable(value) ? value.bind(target) : value;
		},
	});
}

function proxyUi(
	ui: ExtensionUIContext,
	scope: InstrumentedScope,
	reporter: InstrumentationReporter,
	clock: Clock,
): ExtensionUIContext {
	const signal = (value: UiSignal) =>
		report(() => reporter.uiSignal(scope, value, clock()));
	// Every tap forwards the caller's own argument list untouched (no invented
	// defaults, nothing dropped), so the real UI sees exactly the call the
	// extension made.
	return new Proxy(ui, {
		get(target, property) {
			if (property === "setStatus") {
				const setStatus: ExtensionUIContext["setStatus"] = (...args) => {
					const [key, text] = args;
					signal({ kind: "status", key, text });
					return target.setStatus(...args);
				};
				return setStatus;
			}
			if (property === "setWidget") {
				// `setWidget` is overloaded (string[] vs factory), so each branch
				// calls the overload its narrowed `content` matches.
				const setWidget: ExtensionUIContext["setWidget"] = (
					key,
					content,
					options,
				) => {
					if (content === undefined) {
						signal({ kind: "widgetClose", key });
						return target.setWidget(key, content, options);
					}
					if (Array.isArray(content)) {
						signal({ kind: "widgetFrame", key, text: content.join("\n") });
						return target.setWidget(key, content, options);
					}
					// A `(tui, theme) => Component` factory: its rendered frames are
					// reported later, from the terminal surface it mounts
					// (`ExtensionActivityTracker.observeWidgetFrame`).
					signal({ kind: "widgetMount", key });
					return target.setWidget(key, content, options);
				};
				return setWidget;
			}
			if (property === "setWorkingMessage") {
				const setWorkingMessage: ExtensionUIContext["setWorkingMessage"] = (
					...args
				) => {
					signal({ kind: "workingMessage", text: args[0] });
					return target.setWorkingMessage(...args);
				};
				return setWorkingMessage;
			}
			if (property === "notify") {
				const notify: ExtensionUIContext["notify"] = (...args) => {
					const [message, type] = args;
					signal({ kind: "notify", text: message, type: type ?? "info" });
					return target.notify(...args);
				};
				return notify;
			}
			if (property === "select") {
				const select: ExtensionUIContext["select"] = (...args) => {
					signal({ kind: "waiting", title: args[0] });
					return target.select(...args);
				};
				return select;
			}
			if (property === "confirm") {
				const confirm: ExtensionUIContext["confirm"] = (...args) => {
					signal({ kind: "waiting", title: args[0] });
					return target.confirm(...args);
				};
				return confirm;
			}
			if (property === "input") {
				const input: ExtensionUIContext["input"] = (...args) => {
					signal({ kind: "waiting", title: args[0] });
					return target.input(...args);
				};
				return input;
			}
			if (property === "editor") {
				const editor: ExtensionUIContext["editor"] = (...args) => {
					signal({ kind: "waiting", title: args[0] });
					return target.editor(...args);
				};
				return editor;
			}
			if (property === "custom") {
				const custom: ExtensionUIContext["custom"] = (...args) => {
					signal({ kind: "waiting", title: "custom UI" });
					return target.custom(...args);
				};
				return custom;
			}
			// SAFETY: same reasoning as `proxyCtx`'s default branch above — this
			// trap only runs for a real access on `target`.
			const value = target[property as keyof ExtensionUIContext];
			return isCallable(value) ? value.bind(target) : value;
		},
	});
}

function isExtensionContext<Value>(value: Value): value is Value & ExtensionContext {
	return isRecord(value) && "ui" in value;
}

function report(run: () => void): void {
	try {
		run();
	} catch {
		// The reporter (tracker) must never be able to change what a wrapped
		// handler/tool/command/shortcut itself returns or throws.
	}
}

/**
 * Resolves who "owns" a `pi.sendMessage`/`message_start` custom message
 * (§2.2.6): the extension that registered a message renderer for
 * `customType`, else the extension whose slug the type equals, starts with
 * (`"<slug>-…"`), or contains — otherwise unknown (the message renders as it
 * does today, unattached to any activity).
 */
export function identifyMessageOwner(
	extensions: readonly Extension[],
	customType: string,
	resolveRef: (source: IdentitySource) => ExtensionRef,
): ExtensionRef | undefined {
	const visible = extensions.filter((extension) => !extension.hidden);
	for (const extension of visible) {
		if (extension.messageRenderers.has(customType))
			return refFor(extension, resolveRef);
	}
	for (const extension of visible) {
		const ref = refFor(extension, resolveRef);
		if (
			customType === ref.id ||
			customType.startsWith(`${ref.id}-`) ||
			customType.includes(ref.id)
		) {
			return ref;
		}
	}
	return undefined;
}

/**
 * Resolves which loaded (non-hidden) extension registered `toolName`, so its
 * tool card can carry the extension's label and pink running dot
 * (DESIGN-ext-activity.md §3 "Extension tools generally"). Built-in and SDK
 * tools, and pi-ui's own hidden inline extensions, resolve to `undefined`.
 */
export function identifyToolOwner(
	extensions: readonly Extension[],
	toolName: string,
	resolveRef: (source: IdentitySource) => ExtensionRef,
): ExtensionRef | undefined {
	for (const extension of extensions) {
		if (extension.hidden || !extension.tools.has(toolName)) continue;
		return refFor(extension, resolveRef);
	}
	return undefined;
}

function refFor(
	extension: Extension,
	resolveRef: (source: IdentitySource) => ExtensionRef,
): ExtensionRef {
	return resolveRef({
		resolvedPath: extension.resolvedPath,
		source: extension.sourceInfo.source,
	});
}

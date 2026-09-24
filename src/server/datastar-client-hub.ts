import { sessionPerformance } from "../perf/session-performance.ts";
import { datastarStream, type DatastarStream } from "./datastar.ts";

export type DatastarClient = Pick<
	DatastarStream,
	"patchElements" | "patchSignals" | "executeScript" | "close"
>;
export type DatastarStreamFactory = typeof datastarStream;
export type DatastarClientStreamOptions = {
	onDisconnect?: () => void;
	/**
	 * The tab/WebView's stable per-connection id (`page.tsx`'s `displayClientId`).
	 * When a new stream arrives for a `clientId` that already has one registered —
	 * a reconnect race, or a duplicated connection from the same tab — the hub
	 * closes the older stream, so that tab never receives every patch twice and
	 * never holds two live SSE connections at once (round RM1 multi-client #2).
	 * Omit it (as every caller but `UiRenderer` does, e.g. a raw test double) to
	 * opt out of dedup entirely.
	 */
	clientId?: string;
	/**
	 * The `Last-Event-ID` a reconnecting client sent (see `routes/stream.ts`). When it
	 * still names a broadcast this hub can replay, `createStream` sends only the missed
	 * patches instead of the caller's full `initial()` view — see the "sse-resume" doc
	 * comment on `resumeSince` below.
	 */
	lastEventId?: string | null;
};

/** Bounds `hiddenClientIds` against reports for tabs that never (re)connect. */
const maxHiddenClientIds = 1024;

type BroadcastElementsOptions = {
	selector?: string;
	mode?: "outer" | "replace" | "append" | "after" | "remove";
};

type BroadcastEntry =
	| { kind: "elements"; elements: string; options?: BroadcastElementsOptions }
	| { kind: "signals"; signals: string }
	| { kind: "script"; script: string };

/**
 * One SSE frame this hub has broadcast to every connected client, kept around so a
 * reconnecting client can be caught back up without a full `renderView()`. `seq` is this
 * hub's own monotonically increasing counter; `eventId` (`<epochId>:<seq>`, sent as the SSE
 * `id:` line) is what a reconnecting browser echoes back as `Last-Event-ID` — see
 * `resumeSince`.
 */
type BroadcastRecord = BroadcastEntry & { seq: number; eventId: string };

/** Bounds how much broadcast history `resumeSince` can ever replay, by entry count. */
const defaultMaxRingBufferEntries = 512;
/** Bounds the same history by approximate content size (elements/signals/script chars). */
const defaultMaxRingBufferBytes = 2_000_000;

/**
 * Default interval between empty signal-patch heartbeats sent to every connected
 * client. A mobile carrier NAT/proxy or a backgrounded Android WebView commonly
 * drops an idle connection after 30-60s without notifying either end; sending real
 * SSE bytes on a shorter cadence keeps the connection alive and lets the transport
 * notice a genuinely dead socket (and disconnect it) instead of leaving a zombie
 * client registered indefinitely, since `idleTimeout: 0` never does that for us.
 */
const defaultHeartbeatIntervalMs = 20_000;

/** Owns long-lived Datastar clients and accepts only rendered presentation data. */
export class DatastarClientHub {
	private readonly clients = new Map<string, DatastarClient>();
	private readonly disconnectCallbacks = new Map<string, () => void>();
	/**
	 * The currently-registered internal stream id for each display client id
	 * that has one open, plus its inverse — see `DatastarClientStreamOptions.clientId`.
	 * Both directions are kept so `disconnect()` can drop a stale entry in O(1)
	 * without scanning every connected client.
	 */
	private readonly streamIdByClientId = new Map<string, string>();
	private readonly clientIdByStreamId = new Map<string, string>();
	/** Tabs (`displayClientId`s) whose page last reported itself hidden. Kept across a
	 * tab's reconnects (a background tab's stream reconnects too, and nothing re-reports
	 * then); only its own "visible" report clears it. Bounded, oldest dropped first. */
	private readonly hiddenClientIds = new Set<string>();
	private readonly heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	/**
	 * Identifies this hub's current unbroken run of connected clients (round RM2
	 * sse-resume). Regenerated in `disconnect` the moment `clients` drops to 0, which
	 * invalidates every previously issued `eventId`: once no client is connected the
	 * broadcast methods below (guarded by their callers' `clientCount > 0` checks, e.g.
	 * `UiRenderer.flush`) simply stop being called, so nothing is recorded for whatever the
	 * app state does next — an old `Last-Event-ID` from before the gap names a point a
	 * fresh render, not a replay, must resolve from. A resume is only ever valid across a
	 * connection blip where at least one other client kept the broadcast stream live.
	 */
	private epochId = crypto.randomUUID();
	private sequence = 0;
	private readonly ringBuffer: BroadcastRecord[] = [];
	private ringBufferBytes = 0;

	constructor(
		private readonly streamFactory: DatastarStreamFactory = datastarStream,
		private readonly recordPerformance = true,
		heartbeatIntervalMs: number = defaultHeartbeatIntervalMs,
		scheduleInterval: (
			callback: () => void,
			intervalMs: number,
		) => ReturnType<typeof setInterval> = setInterval,
		private readonly maxRingBufferEntries: number = defaultMaxRingBufferEntries,
		private readonly maxRingBufferBytes: number = defaultMaxRingBufferBytes,
	) {
		if (heartbeatIntervalMs <= 0) return;
		this.heartbeatTimer = scheduleInterval(
			() => this.sendHeartbeat(),
			heartbeatIntervalMs,
		);
		// SAFETY: Bun/Node timers expose `unref`; browsers/tests do not, and a
		// heartbeat that merely fails to unref is a harmless idle timer, not a bug.
		(this.heartbeatTimer as { unref?: () => void }).unref?.();
	}

	get clientCount(): number {
		return this.clients.size;
	}

	/**
	 * Connected streams whose tab's page is visible — "someone is looking". Web Push
	 * (`PushService`) sends only when this is 0: a backgrounded PWA, a frozen tab, or
	 * one parked in the back/forward cache keeps its stream open (so `clientCount`
	 * still counts it) but can't run an in-page notification. A stream with no
	 * `clientId` can't report and always counts.
	 */
	get visibleClientCount(): number {
		let count = 0;
		for (const id of this.clients.keys()) {
			const clientId = this.clientIdByStreamId.get(id);
			if (clientId === undefined || !this.hiddenClientIds.has(clientId)) count += 1;
		}
		return count;
	}

	/** A tab's page-visibility report (`routes/stream.ts`'s `streamVisibility`): sent
	 * once on load and on every `visibilitychange` (`page.tsx`). */
	setClientVisibility(clientId: string, visible: boolean): void {
		if (visible) {
			this.hiddenClientIds.delete(clientId);
			return;
		}
		this.hiddenClientIds.add(clientId);
		if (this.hiddenClientIds.size > maxHiddenClientIds) {
			const oldest = this.hiddenClientIds.values().next().value;
			if (oldest !== undefined) this.hiddenClientIds.delete(oldest);
		}
	}

	createStream(
		signal: AbortSignal,
		initial: () => {
			elements: string;
			signals: string;
			scripts?: readonly string[];
		},
		options: DatastarClientStreamOptions = {},
	): Response {
		const id = crypto.randomUUID();
		return this.streamFactory(
			(stream) => {
				this.clients.set(id, stream);
				if (options.onDisconnect) {
					this.disconnectCallbacks.set(id, options.onDisconnect);
				}
				if (options.clientId) this.supersedeStaleStream(options.clientId, id);
				try {
					const resume = this.resumeSince(options.lastEventId);
					if (resume) {
						this.replay(stream, resume);
					} else {
						const view = initial();
						this.patchClient(
							stream,
							view.elements,
							view.signals,
							view.scripts ?? [],
						);
					}
				} catch {
					this.disconnect(id, stream);
					return;
				}
				signal.addEventListener("abort", () => this.disconnect(id, stream), {
					once: true,
				});
			},
			{
				keepalive: true,
				onAbort: () => this.disconnectById(id),
			},
		);
	}

	patchView(elements: string, signals: string, scripts: readonly string[]): void {
		const elementsId = elements
			? this.recordBroadcast({ kind: "elements", elements }).eventId
			: undefined;
		const signalsId = this.recordBroadcast({ kind: "signals", signals }).eventId;
		const scriptId =
			scripts.length > 0
				? this.recordBroadcast({ kind: "script", script: scripts.join(";") })
						.eventId
				: undefined;
		for (const [id, client] of this.clients) {
			try {
				this.patchClient(client, elements, signals, scripts, {
					elements: elementsId,
					signals: signalsId,
					script: scriptId,
				});
			} catch {
				this.disconnect(id, client);
			}
		}
	}

	patchElement(
		elements: string,
		selector: string,
		options: {
			mode?: "outer" | "replace" | "append" | "after" | "remove";
			scripts?: readonly string[];
		} = {},
	): void {
		const mode = options.mode ?? "outer";
		const elementsRecord = this.recordBroadcast({
			kind: "elements",
			elements,
			options: { selector, mode },
		});
		const scriptRecords = (options.scripts ?? []).map((script) =>
			this.recordBroadcast({ kind: "script", script }),
		);
		for (const [id, client] of this.clients) {
			try {
				client.patchElements(elements, {
					selector,
					mode,
					eventId: elementsRecord.eventId,
				});
				for (const scriptRecord of scriptRecords) {
					client.executeScript(scriptRecord.script, {
						eventId: scriptRecord.eventId,
					});
				}
				if (this.recordPerformance) {
					sessionPerformance.recordTargetedMessagePatch(elements);
				}
			} catch {
				this.disconnect(id, client);
			}
		}
	}

	replaceElement(elements: string, selector: string): void {
		const record = this.recordBroadcast({
			kind: "elements",
			elements,
			options: { selector, mode: "replace" },
		});
		for (const [id, client] of this.clients) {
			try {
				client.patchElements(elements, {
					selector,
					mode: "replace",
					eventId: record.eventId,
				});
				if (this.recordPerformance) {
					sessionPerformance.recordFatMorph(elements);
					sessionPerformance.markFirstTranscriptPatch();
				}
			} catch {
				this.disconnect(id, client);
			}
		}
	}

	patchSignals(signals: string): void {
		const record = this.recordBroadcast({ kind: "signals", signals });
		for (const [id, client] of this.clients) {
			try {
				client.patchSignals(signals, { eventId: record.eventId });
			} catch {
				this.disconnect(id, client);
			}
		}
	}

	/** Stops the heartbeat timer; call on server shutdown to let the process exit. */
	dispose(): void {
		if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
	}

	private sendHeartbeat(): void {
		if (this.clients.size === 0) return;
		// An empty JSON Merge Patch changes no signal, so this is invisible to the client
		// beyond keeping the connection warm. Sent directly to every client (not through
		// the public `patchSignals`, which records a resumable broadcast): a heartbeat
		// carries no id and must never advance a client's Last-Event-ID or consume a
		// resume sequence number.
		for (const [id, client] of this.clients) {
			try {
				client.patchSignals("{}");
			} catch {
				this.disconnect(id, client);
			}
		}
	}

	private patchClient(
		client: DatastarClient,
		elements: string,
		signals: string,
		scripts: readonly string[],
		eventIds?: { elements?: string; signals?: string; script?: string },
	): void {
		if (elements) {
			client.patchElements(
				elements,
				eventIds?.elements ? { eventId: eventIds.elements } : undefined,
			);
			if (this.recordPerformance) {
				sessionPerformance.recordFatMorph(elements);
				if (elements.includes('id="messages"')) {
					sessionPerformance.markFirstTranscriptPatch();
				}
			}
		}
		client.patchSignals(
			signals,
			eventIds?.signals ? { eventId: eventIds.signals } : undefined,
		);
		if (scripts.length > 0) {
			client.executeScript(
				scripts.join(";"),
				eventIds?.script ? { eventId: eventIds.script } : undefined,
			);
		}
	}

	/**
	 * Reconnect race / duplicated connection: the tab already has a live stream
	 * registered, so close it now that `id` has taken over — never leave both
	 * delivering patches to the same tab (round RM1 multi-client #2). Runs only
	 * AFTER `id` is in `clients`, so a tab reconnecting over its own half-open
	 * stream never drops `clients` to 0 in between: that would reset the resume
	 * epoch (`resetResumeState`) and turn the tab's valid `Last-Event-ID` into a
	 * full render — dedupe and sse-resume must work together (round RM2 merge).
	 */
	private supersedeStaleStream(clientId: string, id: string): void {
		const staleStreamId = this.streamIdByClientId.get(clientId);
		const staleClient =
			staleStreamId !== undefined ? this.clients.get(staleStreamId) : undefined;
		this.streamIdByClientId.set(clientId, id);
		this.clientIdByStreamId.set(id, clientId);
		if (staleStreamId !== undefined && staleClient) {
			this.disconnect(staleStreamId, staleClient);
		}
	}

	private disconnectById(id: string): void {
		const client = this.clients.get(id);
		if (client) this.disconnect(id, client);
	}

	private disconnect(id: string, client: DatastarClient): void {
		if (!this.clients.delete(id)) return;
		const clientId = this.clientIdByStreamId.get(id);
		this.clientIdByStreamId.delete(id);
		// Only drop the display-client-id mapping if it still points at THIS
		// stream: a stale stream being force-closed by a fresher one for the
		// same tab must not clobber the fresh one's just-set entry.
		if (clientId !== undefined && this.streamIdByClientId.get(clientId) === id) {
			this.streamIdByClientId.delete(clientId);
		}
		const onDisconnect = this.disconnectCallbacks.get(id);
		this.disconnectCallbacks.delete(id);
		onDisconnect?.();
		if (this.clients.size === 0) this.resetResumeState();
		try {
			client.close();
		} catch {
			/* Already closed. */
		}
	}

	/** See the `epochId` doc comment: starts a fresh, empty resume window. */
	private resetResumeState(): void {
		this.epochId = crypto.randomUUID();
		this.sequence = 0;
		this.ringBuffer.length = 0;
		this.ringBufferBytes = 0;
	}

	/**
	 * Generic over the specific `BroadcastEntry` arm so callers keep their variant's own
	 * field (e.g. `.script`) on the returned record, instead of widening to the full
	 * `BroadcastRecord` union.
	 */
	private recordBroadcast<Entry extends BroadcastEntry>(
		entry: Entry,
	): Entry & { seq: number; eventId: string } {
		this.sequence += 1;
		const record = {
			...entry,
			seq: this.sequence,
			eventId: `${this.epochId}:${this.sequence}`,
		};
		this.ringBuffer.push(record);
		this.ringBufferBytes += this.approximateSize(record);
		this.evictRingBuffer();
		return record;
	}

	private evictRingBuffer(): void {
		while (
			this.ringBuffer.length > 0 &&
			(this.ringBuffer.length > this.maxRingBufferEntries ||
				this.ringBufferBytes > this.maxRingBufferBytes)
		) {
			const removed = this.ringBuffer.shift();
			if (removed) this.ringBufferBytes -= this.approximateSize(removed);
		}
	}

	private approximateSize(record: BroadcastRecord): number {
		if (record.kind === "elements") {
			return record.elements.length + (record.options?.selector?.length ?? 0);
		}
		if (record.kind === "signals") return record.signals.length;
		return record.script.length;
	}

	/**
	 * Resolves a reconnecting client's `Last-Event-ID` (see `DatastarClientStreamOptions`)
	 * against this hub's broadcast history.
	 *
	 * Returns the (possibly empty) list of broadcasts the client missed when resumable, or
	 * `undefined` when `createStream` must fall back to a full `initial()` render: no id
	 * given, an id from a different resume epoch (a different, unbroken connected-clients
	 * run — see `epochId` — including one ended by a server restart), a sequence number
	 * this hub never issued, or one older than what the bounded ring buffer still retains
	 * (a gap `resumeSince` cannot safely paper over).
	 */
	private resumeSince(
		lastEventId: string | null | undefined,
	): readonly BroadcastRecord[] | undefined {
		if (!lastEventId) return undefined;
		const separator = lastEventId.indexOf(":");
		if (separator < 0) return undefined;
		if (lastEventId.slice(0, separator) !== this.epochId) return undefined;
		const seq = Number(lastEventId.slice(separator + 1));
		if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.sequence)
			return undefined;
		if (seq === this.sequence) return [];
		const oldest = this.ringBuffer[0];
		if (oldest === undefined || oldest.seq > seq + 1) return undefined;
		return this.ringBuffer.filter((record) => record.seq > seq);
	}

	/** Sends previously broadcast records to exactly one (reconnecting) client. */
	private replay(client: DatastarClient, records: readonly BroadcastRecord[]): void {
		for (const record of records) {
			if (record.kind === "elements") {
				client.patchElements(record.elements, {
					eventId: record.eventId,
					...record.options,
				});
			} else if (record.kind === "signals") {
				client.patchSignals(record.signals, { eventId: record.eventId });
			} else {
				client.executeScript(record.script, { eventId: record.eventId });
			}
		}
	}
}

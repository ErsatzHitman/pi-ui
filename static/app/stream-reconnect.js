const DEFAULT_MIN_INTERVAL_MS = 5000;

/**
 * Decides when to force-reopen the main SSE stream instead of waiting for
 * Datastar's passive retry to notice a dead connection. A mobile carrier
 * NAT/proxy or a backgrounded Android WebView can silently drop an idle
 * connection without either end seeing an error; the transport only finds out
 * once new data is expected, which can be a long wait on a screen nobody is
 * looking at. Re-triggering the same `@get(...)` action is safe to call
 * repeatedly (see the `data-init`/`pi-ui-stream-reconnect` comment in
 * page.tsx), so this just needs to debounce bursts of near-simultaneous
 * triggers (e.g. `visibilitychange` and `online` firing together).
 */
export function createStreamReconnectMonitor(options) {
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
	const now = options.now ?? (() => Date.now());
	let lastSentAt;

	function maybeReconnect() {
		if (!options.isEligible()) return false;
		const timestamp = now();
		if (lastSentAt !== undefined && timestamp - lastSentAt < minIntervalMs) {
			return false;
		}
		lastSentAt = timestamp;
		options.send();
		return true;
	}

	return { maybeReconnect };
}

export function bindStreamReconnect() {
	const monitor = createStreamReconnectMonitor({
		isEligible: () => document.visibilityState === "visible",
		send: () => {
			window.dispatchEvent(new CustomEvent("pi-ui-stream-reconnect"));
		},
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") monitor.maybeReconnect();
	});
	// Only bfcache restores need a forced reconnect here: a fresh navigation's
	// `pageshow` fires shortly after `data-init` already opened the stream, so
	// reconnecting again would just be redundant work.
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) monitor.maybeReconnect();
	});
	window.addEventListener("online", () => monitor.maybeReconnect());
}

/**
 * Remembers the SSE `id:` of the last complete `/stream` event this page applied, so a
 * forced reconnect (above: `visibilitychange`, `online`, a bfcache restore) can resume
 * from it (`Last-Event-ID`, round RM2 sse-resume) instead of re-downloading the whole
 * view. Datastar only sends `Last-Event-ID` on its own internal retries; each forced
 * reconnect re-issues the `@get` action from scratch, which starts with no id — so the
 * page's stream action passes `window.piUi.streamResumeHeaders()` itself.
 *
 * Reads the stream as it passes through (never buffers or alters it) and records an id
 * only once its event's closing blank line arrived, as Datastar reads each chunk
 * (pull-driven, no read-ahead): an id is never remembered for an event Datastar hasn't
 * been handed yet.
 */
export function createStreamEventIdTracker() {
	let lastEventId;

	function tap(body) {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		let pendingId;
		return new ReadableStream(
			{
				async pull(controller) {
					const { value, done } = await reader.read();
					if (done) {
						controller.close();
						return;
					}
					buffered += decoder.decode(value, { stream: true });
					let newline = buffered.indexOf("\n");
					while (newline !== -1) {
						const line = buffered.slice(0, newline).replace(/\r$/, "");
						buffered = buffered.slice(newline + 1);
						if (line === "") {
							if (pendingId !== undefined) lastEventId = pendingId;
							pendingId = undefined;
						} else if (line.startsWith("id:")) {
							pendingId = line.slice(3).trimStart();
						}
						newline = buffered.indexOf("\n");
					}
					controller.enqueue(value);
				},
				cancel(reason) {
					return reader.cancel(reason);
				},
			},
			{ highWaterMark: 0 },
		);
	}

	function wrapFetch(fetchImpl) {
		return async (input, init) => {
			const response = await fetchImpl(input, init);
			const url = input instanceof Request ? input.url : String(input);
			const isStream =
				new URL(url, "http://localhost").pathname === "/stream" &&
				response.body &&
				response.headers.get("content-type")?.includes("text/event-stream");
			if (!isStream) return response;
			return new Response(tap(response.body), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		};
	}

	/** Lower-case key on purpose: Datastar's own retries set `last-event-id` on the same
	 * headers object, and two spellings would be sent as one comma-joined value. */
	function resumeHeaders() {
		return lastEventId ? { "last-event-id": lastEventId } : {};
	}

	return { wrapFetch, resumeHeaders };
}

/** Installs the tracker on `window.fetch`. Must run before Datastar opens the first
 * stream (`main.js` top level; Datastar's module loads after it). */
export function bindStreamEventIds() {
	const tracker = createStreamEventIdTracker();
	window.fetch = tracker.wrapFetch(window.fetch.bind(window));
	return tracker;
}

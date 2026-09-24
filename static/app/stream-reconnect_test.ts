import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	createStreamEventIdTracker,
	createStreamReconnectMonitor,
} from "./stream-reconnect.js";

test("forces a reconnect when eligible", () => {
	let sent = 0;
	const monitor = createStreamReconnectMonitor({
		isEligible: () => true,
		send: () => (sent += 1),
		now: () => 0,
	});
	assertEquals(monitor.maybeReconnect(), true);
	assertEquals(sent, 1);
});

test("skips reconnecting while ineligible (e.g. the page is hidden)", () => {
	let sent = 0;
	const monitor = createStreamReconnectMonitor({
		isEligible: () => false,
		send: () => (sent += 1),
	});
	assertEquals(monitor.maybeReconnect(), false);
	assertEquals(sent, 0);
});

test("debounces a burst of near-simultaneous triggers (visibilitychange + online)", () => {
	let sent = 0;
	let clock = 0;
	const monitor = createStreamReconnectMonitor({
		isEligible: () => true,
		send: () => (sent += 1),
		now: () => clock,
		minIntervalMs: 5000,
	});
	assertEquals(monitor.maybeReconnect(), true);
	clock = 1000;
	assertEquals(monitor.maybeReconnect(), false);
	assertEquals(sent, 1);
});

test("reconnects again once the debounce window has passed", () => {
	let sent = 0;
	let clock = 0;
	const monitor = createStreamReconnectMonitor({
		isEligible: () => true,
		send: () => (sent += 1),
		now: () => clock,
		minIntervalMs: 5000,
	});
	monitor.maybeReconnect();
	clock = 6000;
	assertEquals(monitor.maybeReconnect(), true);
	assertEquals(sent, 2);
});

function sseResponse(chunks: string[], contentType = "text/event-stream") {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ headers: { "content-type": contentType } },
	);
}

test("tracks the id of the last COMPLETE /stream event, across chunk boundaries", async () => {
	const tracker = createStreamEventIdTracker();
	assertEquals(tracker.resumeHeaders(), {});
	const fetchImpl = tracker.wrapFetch(async () =>
		sseResponse([
			"event: datastar-patch-signals\nid: ep",
			"och:1\ndata: signals {}\n\nevent: datastar-patch-elements\nid: epoch:2\ndata: elements <p>x</p>\n",
			"\nevent: datastar-patch-signals\nid: epoch:3\ndata: signals {}\n",
		]),
	);
	const response = await fetchImpl("/stream?clientId=a&appVersion=v");
	assertEquals(response.headers.get("content-type"), "text/event-stream");
	const body = await response.text();
	// The body passes through untouched...
	assertEquals(body.includes("id: epoch:3"), true);
	// ...and epoch:3's event never completed (no blank line), so it doesn't count.
	assertEquals(tracker.resumeHeaders(), { "last-event-id": "epoch:2" });
});

test("leaves every other request alone", async () => {
	const tracker = createStreamEventIdTracker();
	const fetchImpl = tracker.wrapFetch(async () =>
		sseResponse(["id: x:9\ndata: y\n\n"]),
	);
	await (await fetchImpl("/prompt")).text();
	assertEquals(tracker.resumeHeaders(), {});
});

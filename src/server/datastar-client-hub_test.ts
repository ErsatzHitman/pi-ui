import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import { assertStringExcludes } from "../testing/assertions.ts";
import { responseReader, readUntil } from "../testing/streams.ts";
import { DatastarClientHub, type DatastarClient } from "./datastar-client-hub.ts";
import { datastarStream, DatastarStream } from "./datastar.ts";

/** The last SSE `id:` line seen in an accumulated chunk of raw stream text. */
function extractLastEventId(text: string): string {
	const matches = [...text.matchAll(/^id: (.+)\r?$/gm)];
	const last = matches.at(-1);
	if (!last) throw new Error("No SSE 'id:' line found in the stream output.");
	return last[1] ?? "";
}

test("hub connects, sends an initial view, broadcasts fat and targeted patches, and aborts", async () => {
	const hub = new DatastarClientHub();
	const controller = new AbortController();
	const response = hub.createStream(controller.signal, () => ({
		elements: '<main id="app">initial</main>',
		signals: '{"ready":true}',
	}));
	assertEquals(hub.clientCount, 1);
	hub.patchView('<main id="app">updated</main>', '{"ready":false}', []);
	hub.patchElement('<article id="message">target</article>', "#message");
	hub.replaceElement('<main id="messages">replaced</main>', "#messages");
	hub.patchSignals('{"extra":true}');
	controller.abort();
	assertEquals(hub.clientCount, 0);

	const body = await response.text();
	assertStringIncludes(body, "initial");
	assertStringIncludes(body, "updated");
	assertStringIncludes(body, "selector #message");
	assertStringIncludes(body, "selector #messages");
	assertStringIncludes(body, "mode replace");
	assertStringIncludes(body, 'signals {"extra":true}');
});

test("hub broadcasts to multiple clients and disconnects them independently", async () => {
	const hub = new DatastarClientHub();
	const firstController = new AbortController();
	const secondController = new AbortController();
	const initial = () => ({ elements: '<main id="app">initial</main>', signals: "{}" });
	const first = hub.createStream(firstController.signal, initial);
	const second = hub.createStream(secondController.signal, initial);
	assertEquals(hub.clientCount, 2);

	firstController.abort();
	assertEquals(hub.clientCount, 1);
	hub.patchView('<main id="app">second only</main>', "{}", []);
	secondController.abort();

	assertStringExcludes(await first.text(), "second only");
	assertStringIncludes(await second.text(), "second only");
});

test("hub runs disconnect lifecycle once across overlapping close signals", () => {
	const hub = new DatastarClientHub();
	const controller = new AbortController();
	let disconnects = 0;
	const response = hub.createStream(
		controller.signal,
		() => ({ elements: "", signals: "{}" }),
		{ onDisconnect: () => (disconnects += 1) },
	);
	controller.abort();
	controller.abort();
	assertEquals(disconnects, 1);
	return response.body?.cancel();
});

test("hub sends a periodic empty signal-patch heartbeat to keep idle connections alive", async () => {
	let scheduled: (() => void) | undefined;
	const hub = new DatastarClientHub(datastarStream, false, 15_000, (callback) => {
		scheduled = callback;
		return 1 as unknown as ReturnType<typeof setInterval>;
	});
	const controller = new AbortController();
	const response = hub.createStream(controller.signal, () => ({
		elements: "",
		signals: "{}",
	}));
	scheduled?.();
	controller.abort();

	const body = await response.text();
	const heartbeats = body.match(/signals \{\}/g) ?? [];
	assertEquals(heartbeats.length, 2);
	// Heartbeats carry no SSE id (round RM2 sse-resume): they must never advance a
	// client's Last-Event-ID, and must never consume a resume sequence number.
	assertStringExcludes(body, "id:");
});

test("hub heartbeat is a no-op with no connected clients", () => {
	let scheduled: (() => void) | undefined;
	new DatastarClientHub(datastarStream, false, 15_000, (callback) => {
		scheduled = callback;
		return 1 as unknown as ReturnType<typeof setInterval>;
	});
	// Must not throw when nothing is connected to broadcast to.
	scheduled?.();
});

test("hub removes a client after a failed send", () => {
	let closed = false;
	let disconnects = 0;
	const client: DatastarClient = {
		patchElements: () => {
			throw new Error("disconnected");
		},
		patchSignals: () => [],
		executeScript: () => [],
		close: () => {
			closed = true;
		},
	};
	const stream = Object.assign(Object.create(DatastarStream.prototype), client);
	const factory: ConstructorParameters<typeof DatastarClientHub>[0] = (start) => {
		start(stream);
		return new Response();
	};
	const hub = new DatastarClientHub(factory);

	hub.createStream(
		new AbortController().signal,
		() => ({ elements: "initial", signals: "{}" }),
		{ onDisconnect: () => (disconnects += 1) },
	);
	assertEquals(hub.clientCount, 0);
	assertEquals(disconnects, 1);
	assertEquals(closed, true);
});

test("a reconnect with a valid Last-Event-ID replays only the missed broadcasts", async () => {
	const hub = new DatastarClientHub();
	// A second, still-connected client keeps the resume window alive across `a`'s drop:
	// `hub.clientCount` never reaches 0, so nothing invalidates the buffered history.
	const keepAlive = new AbortController();
	hub.createStream(keepAlive.signal, () => ({ elements: "", signals: "{}" }));

	const aController = new AbortController();
	const aReader = responseReader(
		hub.createStream(aController.signal, () => ({
			elements: '<main id="app">initial</main>',
			signals: "{}",
		})),
	);
	const initialOutput = await readUntil(aReader, (text) =>
		text.includes("event: datastar-patch-signals"),
	);
	assertStringIncludes(initialOutput, "initial");

	hub.patchView('<main id="app">first update</main>', "{}", []);
	const firstUpdateOutput = await readUntil(aReader, (text) =>
		text.includes("first update"),
	);
	const lastEventId = extractLastEventId(firstUpdateOutput);

	aController.abort();
	assertEquals(hub.clientCount, 1);

	// Broadcast while `a` is disconnected: this is exactly what a resume must replay.
	hub.patchView('<main id="app">missed update</main>', "{}", []);

	const reconnectController = new AbortController();
	const reconnectReader = responseReader(
		hub.createStream(
			reconnectController.signal,
			() => ({ elements: '<main id="app">FULL-RENDER</main>', signals: "{}" }),
			{ lastEventId },
		),
	);
	const reconnectOutput = await readUntil(reconnectReader, (text) =>
		text.includes("missed update"),
	);
	assertStringExcludes(reconnectOutput, "FULL-RENDER");
	assertStringExcludes(reconnectOutput, "initial");
	assertStringExcludes(reconnectOutput, "first update");

	reconnectController.abort();
	keepAlive.abort();
});

test("a reconnect with no missed broadcasts resumes with an empty replay", async () => {
	const hub = new DatastarClientHub();
	const keepAlive = new AbortController();
	hub.createStream(keepAlive.signal, () => ({ elements: "", signals: "{}" }));

	const aController = new AbortController();
	const aReader = responseReader(
		hub.createStream(aController.signal, () => ({
			elements: '<main id="app">initial</main>',
			signals: "{}",
		})),
	);
	await readUntil(aReader, (text) => text.includes("event: datastar-patch-signals"));
	// The initial view above carries no id (it is a per-connection full render, not a
	// broadcast); only an actual broadcast produces something to resume from.
	hub.patchView('<main id="app">caught up</main>', "{}", []);
	const caughtUpOutput = await readUntil(aReader, (text) => text.includes("caught up"));
	const lastEventId = extractLastEventId(caughtUpOutput);
	aController.abort();

	const reconnectController = new AbortController();
	const reconnectResponse = hub.createStream(
		reconnectController.signal,
		() => ({ elements: '<main id="app">FULL-RENDER</main>', signals: "{}" }),
		{ lastEventId },
	);
	hub.patchSignals('{"ping":true}');
	const reconnectOutput = await readUntil(responseReader(reconnectResponse), (text) =>
		text.includes("ping"),
	);
	assertStringExcludes(reconnectOutput, "FULL-RENDER");

	reconnectController.abort();
	keepAlive.abort();
});

test("a Last-Event-ID from a different server boot falls back to a full render", async () => {
	const hub = new DatastarClientHub();
	const controller = new AbortController();
	const response = hub.createStream(
		controller.signal,
		() => ({ elements: '<main id="app">fresh boot</main>', signals: "{}" }),
		{ lastEventId: `${crypto.randomUUID()}:5` },
	);
	const output = await readUntil(responseReader(response), (text) =>
		text.includes("event: datastar-patch-signals"),
	);
	assertStringIncludes(output, "fresh boot");
	controller.abort();
});

test("a Last-Event-ID with no boot separator falls back to a full render", async () => {
	const hub = new DatastarClientHub();
	const controller = new AbortController();
	const response = hub.createStream(
		controller.signal,
		() => ({ elements: '<main id="app">fresh boot</main>', signals: "{}" }),
		{ lastEventId: "not-a-real-event-id" },
	);
	const output = await readUntil(responseReader(response), (text) =>
		text.includes("event: datastar-patch-signals"),
	);
	assertStringIncludes(output, "fresh boot");
	controller.abort();
});

test("a Last-Event-ID older than the retained ring buffer falls back to a full render", async () => {
	// A 2-entry cap forces eviction after just a couple of broadcasts.
	const hub = new DatastarClientHub(datastarStream, true, 0, setInterval, 2);
	const keepAlive = new AbortController();
	hub.createStream(keepAlive.signal, () => ({ elements: "", signals: "{}" }));

	const aController = new AbortController();
	const aReader = responseReader(
		hub.createStream(aController.signal, () => ({
			elements: '<main id="app">initial</main>',
			signals: "{}",
		})),
	);
	await readUntil(aReader, (text) => text.includes("event: datastar-patch-signals"));
	hub.patchView('<main id="app">update 1</main>', "{}", []);
	const update1Output = await readUntil(aReader, (text) => text.includes("update 1"));
	const staleEventId = extractLastEventId(update1Output);
	aController.abort();

	hub.patchView('<main id="app">update 2</main>', "{}", []);
	hub.patchView('<main id="app">update 3</main>', "{}", []);
	hub.patchView('<main id="app">update 4</main>', "{}", []);

	const reconnectController = new AbortController();
	const reconnectOutput = await readUntil(
		responseReader(
			hub.createStream(
				reconnectController.signal,
				() => ({ elements: '<main id="app">FULL-RENDER</main>', signals: "{}" }),
				{ lastEventId: staleEventId },
			),
		),
		(text) => text.includes("event: datastar-patch-signals"),
	);
	assertStringIncludes(reconnectOutput, "FULL-RENDER");

	reconnectController.abort();
	keepAlive.abort();
});

test("resumability resets once every client disconnects, even with a matching boot id", async () => {
	const hub = new DatastarClientHub();
	const aController = new AbortController();
	const aReader = responseReader(
		hub.createStream(aController.signal, () => ({
			elements: '<main id="app">initial</main>',
			signals: "{}",
		})),
	);
	await readUntil(aReader, (text) => text.includes("event: datastar-patch-signals"));
	hub.patchView('<main id="app">update</main>', "{}", []);
	const updateOutput = await readUntil(aReader, (text) => text.includes("update"));
	const lastEventId = extractLastEventId(updateOutput);

	aController.abort();
	assertEquals(hub.clientCount, 0);

	const reconnectController = new AbortController();
	const reconnectOutput = await readUntil(
		responseReader(
			hub.createStream(
				reconnectController.signal,
				() => ({ elements: '<main id="app">FULL-RENDER</main>', signals: "{}" }),
				{ lastEventId },
			),
		),
		(text) => text.includes("event: datastar-patch-signals"),
	);
	assertStringIncludes(reconnectOutput, "FULL-RENDER");
	reconnectController.abort();
});

test("a resumed reconnect sends far fewer bytes than a fresh full render", async () => {
	const hub = new DatastarClientHub();
	const keepAlive = new AbortController();
	hub.createStream(keepAlive.signal, () => ({ elements: "", signals: "{}" }));

	const largeInitialView = `<main id="app">${"x".repeat(20_000)}</main>`;
	const aController = new AbortController();
	const aReader = responseReader(
		hub.createStream(aController.signal, () => ({
			elements: largeInitialView,
			signals: "{}",
		})),
	);
	await readUntil(aReader, (text) => text.includes("event: datastar-patch-signals"));

	hub.patchView('<span id="tick">1</span>', "{}", []);
	const tickOutput = await readUntil(aReader, (text) => text.includes('id="tick"'));
	const lastEventId = extractLastEventId(tickOutput);
	aController.abort();

	hub.patchView('<span id="tick">2</span>', "{}", []);

	const reconnectController = new AbortController();
	const resumedOutput = await readUntil(
		responseReader(
			hub.createStream(
				reconnectController.signal,
				() => ({ elements: largeInitialView, signals: "{}" }),
				{ lastEventId },
			),
		),
		(text) => text.includes('id="tick">2'),
	);
	reconnectController.abort();
	keepAlive.abort();

	assertStringExcludes(resumedOutput, "x".repeat(20_000));
	// The resumed reconnect (a single tiny targeted patch) must be a small fraction of
	// the size a fresh full render (the 20 KB view) would have cost.
	assertEquals(resumedOutput.length < largeInitialView.length * 0.05, true);
});

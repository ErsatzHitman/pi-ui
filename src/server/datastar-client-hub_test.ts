import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import { assertStringExcludes } from "../testing/assertions.ts";
import { DatastarClientHub, type DatastarClient } from "./datastar-client-hub.ts";
import { datastarStream, DatastarStream } from "./datastar.ts";

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

test("hub closes a stale stream when a new one connects with the same display client id", async () => {
	const hub = new DatastarClientHub();
	const firstController = new AbortController();
	const secondController = new AbortController();
	let firstDisconnected = false;
	const first = hub.createStream(
		firstController.signal,
		() => ({ elements: '<main id="app">first</main>', signals: "{}" }),
		{ clientId: "tab-1", onDisconnect: () => (firstDisconnected = true) },
	);
	assertEquals(hub.clientCount, 1);

	const second = hub.createStream(
		secondController.signal,
		() => ({ elements: '<main id="app">second</main>', signals: "{}" }),
		{ clientId: "tab-1" },
	);

	// The reconnect race (round RM1 multi-client #2): a duplicate `/stream` for the
	// same tab replaces, rather than adds to, the hub's registered clients.
	assertEquals(hub.clientCount, 1);
	assertEquals(firstDisconnected, true);

	hub.patchView('<main id="app">broadcast</main>', "{}", []);
	secondController.abort();

	assertStringExcludes(await first.text(), "broadcast");
	assertStringIncludes(await second.text(), "broadcast");
});

test("hub tracks distinct display client ids as separate connections", () => {
	const hub = new DatastarClientHub();
	const first = new AbortController();
	const second = new AbortController();
	hub.createStream(first.signal, () => ({ elements: "", signals: "{}" }), {
		clientId: "tab-1",
	});
	hub.createStream(second.signal, () => ({ elements: "", signals: "{}" }), {
		clientId: "tab-2",
	});
	assertEquals(hub.clientCount, 2);
	first.abort();
	assertEquals(hub.clientCount, 1);
	second.abort();
	assertEquals(hub.clientCount, 0);
});

test("hub does not dedupe connections that carry no display client id", () => {
	const hub = new DatastarClientHub();
	const first = new AbortController();
	const second = new AbortController();
	hub.createStream(first.signal, () => ({ elements: "", signals: "{}" }));
	hub.createStream(second.signal, () => ({ elements: "", signals: "{}" }));
	assertEquals(hub.clientCount, 2);
	first.abort();
	second.abort();
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

import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { PushService } from "./push-service.ts";
import type { PushSubscriptionRecord } from "./subscription-store.ts";
import type { VapidKeyPair } from "./vapid-keys.ts";

const vapidKeys: VapidKeyPair = {
	publicKeyRaw: Buffer.alloc(65),
	privateKeyD: Buffer.alloc(32),
};

function harness(options: {
	clientCount: number;
	remote: boolean;
	subscriptions: PushSubscriptionRecord[];
}) {
	const removed: string[] = [];
	const sent: Array<{ endpoint: string; payload: unknown }> = [];
	let outcomeByEndpoint: Record<string, "sent" | "gone" | "failed"> = {};

	const service = new PushService({
		vapidKeys,
		vapidSubject: "mailto:ops@example.com",
		hub: { visibleClientCount: options.clientCount },
		isRemoteMode: () => options.remote,
		subscriptions: {
			list: async () => options.subscriptions,
			remove: async (endpoint: string) => {
				removed.push(endpoint);
			},
		},
		sendWebPush: async (sendOptions) => {
			sent.push({
				endpoint: sendOptions.subscription.endpoint,
				payload: sendOptions.payload,
			});
			const outcome =
				outcomeByEndpoint[sendOptions.subscription.endpoint] ?? "sent";
			return outcome === "failed"
				? { outcome: "failed", statusCode: 500 }
				: { outcome };
		},
	});
	return {
		service,
		sent,
		removed,
		setOutcome: (endpoint: string, outcome: "sent" | "gone" | "failed") => {
			outcomeByEndpoint[endpoint] = outcome;
		},
	};
}

function subscription(endpoint: string): PushSubscriptionRecord {
	return { endpoint, p256dh: "p", auth: "a" };
}

test("sends nothing while a connected client is visible (someone is looking)", async () => {
	const h = harness({
		clientCount: 1,
		remote: true,
		subscriptions: [subscription("https://a")],
	});
	await h.service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(h.sent.length, 0);
});

test("sends nothing in local mode even with subscriptions and no clients", async () => {
	const h = harness({
		clientCount: 0,
		remote: false,
		subscriptions: [subscription("https://a")],
	});
	await h.service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(h.sent.length, 0);
});

test("sends nothing when there are no stored subscriptions", async () => {
	const h = harness({ clientCount: 0, remote: true, subscriptions: [] });
	await h.service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(h.sent.length, 0);
});

test("sends to every stored subscription when remote and no client is connected", async () => {
	const h = harness({
		clientCount: 0,
		remote: true,
		subscriptions: [subscription("https://a"), subscription("https://b")],
	});
	await h.service.notifySessionFinished({
		workspace: "~/work",
		sessionPath: "/sessions/x.jsonl",
	});
	assertEquals(h.sent.length, 2);
	assertEquals(h.sent.map((entry) => entry.endpoint).sort(), [
		"https://a",
		"https://b",
	]);
	assertEquals(h.sent[0]?.payload, {
		title: "Background session finished",
		body: "~/work",
		tag: "/sessions/x.jsonl",
		sessionPath: "/sessions/x.jsonl",
	});
});

test("titles a finished foreground run 'Turn finished', like the in-page notice", async () => {
	const h = harness({
		clientCount: 0,
		remote: true,
		subscriptions: [subscription("https://a")],
	});
	await h.service.notifySessionFinished(
		{ workspace: "~/work", sessionPath: "/sessions/x.jsonl" },
		false,
	);
	assertEquals(h.sent[0]?.payload, {
		title: "Turn finished",
		body: "~/work",
		tag: "/sessions/x.jsonl",
		sessionPath: "/sessions/x.jsonl",
	});
});

test("falls back to the workspace as the tag when there is no session path", async () => {
	const h = harness({
		clientCount: 0,
		remote: true,
		subscriptions: [subscription("https://a")],
	});
	await h.service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(h.sent[0]?.payload, {
		title: "Background session finished",
		body: "~/work",
		tag: "~/work",
		sessionPath: undefined,
	});
});

test("removes a subscription the push service reports gone", async () => {
	const h = harness({
		clientCount: 0,
		remote: true,
		subscriptions: [subscription("https://a"), subscription("https://b")],
	});
	h.setOutcome("https://a", "gone");
	await h.service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(h.removed, ["https://a"]);
});

test("a failed send (not gone) does not remove the subscription", async () => {
	const h = harness({
		clientCount: 0,
		remote: true,
		subscriptions: [subscription("https://a")],
	});
	h.setOutcome("https://a", "failed");
	await h.service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(h.removed, []);
});

test("a rejected send for one subscription doesn't crash the others or throw (never an unhandled rejection)", async () => {
	// `sendWebPush()` itself never rejects (network-level fetch failures resolve to
	// `{ outcome: "network-error" }`, see send-push_test.ts), but this is defence in depth for
	// `RuntimeControllerActivationOptions.sendWebPush`'s documented invariant: "a push failure
	// must never affect the session runtime". `notifySessionFinished()` must resolve, not reject,
	// even when an injected `sendWebPush` throws — and bun:test fails a test outright on any
	// unhandled rejection surfacing during it, so this also guards the real
	// `Promise.all`-without-a-catch regression directly.
	const sent: string[] = [];
	const service = new PushService({
		vapidKeys,
		vapidSubject: "mailto:ops@example.com",
		hub: { visibleClientCount: 0 },
		isRemoteMode: () => true,
		subscriptions: {
			list: async () => [subscription("https://bad"), subscription("https://good")],
			remove: async () => {},
		},
		sendWebPush: async (sendOptions) => {
			sent.push(sendOptions.subscription.endpoint);
			if (sendOptions.subscription.endpoint === "https://bad") {
				throw new Error("simulated fetch rejection");
			}
			return { outcome: "sent" };
		},
	});
	await service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(sent.sort(), ["https://bad", "https://good"]);
});

test("sends nothing while 'Notify on completion' is off (the bell is shared by every device)", async () => {
	// A phone keeps its PushSubscription when the bell is switched off on the desktop:
	// the server-side preference is the one switch every device sees.
	let optedIn = false;
	const sent: unknown[] = [];
	const service = new PushService({
		vapidKeys,
		vapidSubject: "mailto:ops@example.com",
		hub: { visibleClientCount: 0 },
		isRemoteMode: () => true,
		isOptedIn: () => optedIn,
		subscriptions: {
			list: async () => [subscription("https://a")],
			remove: async () => {},
		},
		sendWebPush: async (options) => {
			sent.push(options.payload);
			return { outcome: "sent" };
		},
	});
	await service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(sent.length, 0);
	optedIn = true;
	await service.notifySessionFinished({ workspace: "~/work" });
	assertEquals(sent.length, 1);
});

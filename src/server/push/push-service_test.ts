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
		hub: { clientCount: options.clientCount },
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

test("sends nothing when a client is connected (the in-page notification already covers it)", async () => {
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

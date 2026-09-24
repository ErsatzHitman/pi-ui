import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { base64UrlToUint8Array, createPushOptIn } from "./push.js";

type PushSubscription = {
	toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
	unsubscribe: () => Promise<boolean>;
};

type Registration = {
	pushManager: {
		getSubscription: () => Promise<PushSubscription | undefined>;
		subscribe: (options: unknown) => Promise<PushSubscription>;
	};
};

function fakeSubscription(endpoint = "https://push.example/abc"): PushSubscription {
	return {
		toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-secret" } }),
		unsubscribe: async () => true,
	};
}

function harness(
	overrides: {
		isRemoteMode?: () => boolean;
		applicationServerKey?: string;
		permission?: string;
		registration?: Registration | undefined;
		existingSubscription?: PushSubscription | undefined;
	} = {},
) {
	const posts: Array<{ url: string; body: unknown }> = [];
	const subscribeCalls: unknown[] = [];
	const unsubscribeCalls: number[] = [];
	const defaultRegistration: Registration = {
		pushManager: {
			getSubscription: async () => overrides.existingSubscription,
			subscribe: async (options: unknown) => {
				subscribeCalls.push(options);
				return fakeSubscription();
			},
		},
	};
	const registration =
		"registration" in overrides ? overrides.registration : defaultRegistration;
	const applicationServerKey =
		"applicationServerKey" in overrides ? overrides.applicationServerKey : "abc123";

	const pushOptIn = createPushOptIn({
		isRemoteMode: overrides.isRemoteMode ?? (() => true),
		applicationServerKey,
		getPermission: () => overrides.permission ?? "granted",
		getRegistration: async () => registration,
		toApplicationServerKey: (key: string) => `bytes(${key})`,
		post: async (url: string, body: unknown) => {
			posts.push({ url, body });
		},
	});

	return { pushOptIn, posts, subscribeCalls, unsubscribeCalls, registration };
}

test("subscribes and posts the subscription when opted in, granted, and remote", async () => {
	const h = harness();
	await h.pushOptIn.ensureSubscribed();

	assertEquals(h.subscribeCalls, [
		{ userVisibleOnly: true, applicationServerKey: "bytes(abc123)" },
	]);
	assertEquals(h.posts, [
		{
			url: "/push/subscribe",
			body: {
				endpoint: "https://push.example/abc",
				keys: { p256dh: "p256dh-key", auth: "auth-secret" },
			},
		},
	]);
});

test("does nothing in local mode", async () => {
	const h = harness({ isRemoteMode: () => false });
	await h.pushOptIn.ensureSubscribed();
	assertEquals(h.subscribeCalls, []);
	assertEquals(h.posts, []);
});

test("does nothing without a public key (server-side push not configured)", async () => {
	const h = harness({ applicationServerKey: undefined });
	await h.pushOptIn.ensureSubscribed();
	assertEquals(h.subscribeCalls, []);
});

test("does nothing without granted Notification permission", async () => {
	const h = harness({ permission: "default" });
	await h.pushOptIn.ensureSubscribed();
	assertEquals(h.subscribeCalls, []);
});

test("reuses an existing subscription instead of subscribing again", async () => {
	const h = harness({
		existingSubscription: fakeSubscription("https://push.example/existing"),
	});
	await h.pushOptIn.ensureSubscribed();
	assertEquals(h.subscribeCalls, []);
	assertEquals(h.posts, [
		{
			url: "/push/subscribe",
			body: {
				endpoint: "https://push.example/existing",
				keys: { p256dh: "p256dh-key", auth: "auth-secret" },
			},
		},
	]);
});

test("does nothing when there is no service worker registration", async () => {
	const h = harness({ registration: undefined });
	await h.pushOptIn.ensureSubscribed();
	assertEquals(h.posts, []);
});

test("unsubscribes and posts the removal when there is an existing subscription", async () => {
	const h = harness({
		existingSubscription: fakeSubscription("https://push.example/gone"),
	});
	await h.pushOptIn.ensureUnsubscribed();
	assertEquals(h.posts, [
		{ url: "/push/unsubscribe", body: { endpoint: "https://push.example/gone" } },
	]);
});

test("unsubscribing with no existing subscription posts nothing", async () => {
	const h = harness({ existingSubscription: undefined });
	await h.pushOptIn.ensureUnsubscribed();
	assertEquals(h.posts, []);
});

test("base64UrlToUint8Array decodes a padded, URL-safe key to raw bytes", () => {
	// "hello" -> base64 "aGVsbG8=" -> base64url "aGVsbG8" (no padding, no -/_ chars
	// exercised here, but the function must still handle them if present).
	const bytes = base64UrlToUint8Array("aGVsbG8");
	assertEquals(Buffer.from(bytes).toString("utf8"), "hello");
});

test("covers() is true only once this browser's subscription reached the server, until it unsubscribes", async () => {
	// A hidden tab of a subscribed browser skips its own in-page "finished" notice:
	// the server pushes whenever no tab is visible, and the SW shows that one.
	const h = harness();
	assertEquals(h.pushOptIn.covers(), false);
	await h.pushOptIn.ensureSubscribed();
	assertEquals(h.pushOptIn.covers(), true);
	await h.pushOptIn.ensureUnsubscribed();
	assertEquals(h.pushOptIn.covers(), false);
});

test("covers() stays false when the subscription can't be made or posted", async () => {
	const local = harness({ isRemoteMode: () => false });
	await local.pushOptIn.ensureSubscribed();
	assertEquals(local.pushOptIn.covers(), false);

	const failing = createPushOptIn({
		isRemoteMode: () => true,
		applicationServerKey: "abc123",
		getPermission: () => "granted",
		getRegistration: async () => ({
			pushManager: {
				getSubscription: async () => undefined,
				subscribe: async () => {
					throw new Error("push service unreachable");
				},
			},
		}),
		toApplicationServerKey: (key: string) => key,
		post: async () => {},
	});
	await failing.ensureSubscribed();
	assertEquals(failing.covers(), false);
});

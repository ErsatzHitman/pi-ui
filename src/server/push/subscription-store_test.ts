import { test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { assertEquals } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { PushSubscriptionStore } from "./subscription-store.ts";

function record(endpoint: string) {
	return { endpoint, p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` };
}

test("starts empty and persists an added subscription", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-subscriptions.json");
	try {
		const store = new PushSubscriptionStore(path);
		assertEquals(await store.list(), []);
		await store.add(record("https://push.example/a"));
		assertEquals((await store.list()).length, 1);

		const reopened = new PushSubscriptionStore(path);
		assertEquals(await reopened.list(), [record("https://push.example/a")]);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("adding the same endpoint again replaces it rather than duplicating it", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-subscriptions.json");
	try {
		const store = new PushSubscriptionStore(path);
		await store.add(record("https://push.example/a"));
		await store.add({ ...record("https://push.example/a"), auth: "rotated" });
		const list = await store.list();
		assertEquals(list.length, 1);
		assertEquals(list[0]?.auth, "rotated");
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("removes a subscription by endpoint", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-subscriptions.json");
	try {
		const store = new PushSubscriptionStore(path);
		await store.add(record("https://push.example/a"));
		await store.add(record("https://push.example/b"));
		await store.remove("https://push.example/a");
		const list = await store.list();
		assertEquals(list.length, 1);
		assertEquals(list[0]?.endpoint, "https://push.example/b");
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("removing an endpoint that was never added is a no-op", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-subscriptions.json");
	try {
		const store = new PushSubscriptionStore(path);
		await store.remove("https://push.example/missing");
		assertEquals(await store.list(), []);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("bounds the number of stored subscriptions, evicting the oldest", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-subscriptions.json");
	try {
		const store = new PushSubscriptionStore(path);
		for (let i = 0; i < 25; i += 1) {
			await store.add(record(`https://push.example/${i}`));
		}
		const list = await store.list();
		assertEquals(list.length, 20);
		assertEquals(
			list.some((entry) => entry.endpoint === "https://push.example/0"),
			false,
		);
		assertEquals(
			list.some((entry) => entry.endpoint === "https://push.example/24"),
			true,
		);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("ignores a corrupt subscriptions file instead of throwing", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-subscriptions.json");
	try {
		await Bun.write(path, "not json");
		const store = new PushSubscriptionStore(path);
		assertEquals(await store.list(), []);
	} finally {
		await rm(directory, { recursive: true });
	}
});

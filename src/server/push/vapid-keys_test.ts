import { test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";

import { assertEquals } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { loadOrCreateVapidKeys } from "./vapid-keys.ts";

test("generates and persists a fresh P-256 keypair on first use", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-vapid-keys.json");
	try {
		const keys = await loadOrCreateVapidKeys(path);
		assertEquals(keys.publicKeyRaw.length, 65);
		assertEquals(keys.publicKeyRaw[0], 4);
		assertEquals(keys.privateKeyD.length, 32);
		assertEquals(await Bun.file(path).exists(), true);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("reuses the persisted keypair across calls instead of generating a new one", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-vapid-keys.json");
	try {
		const first = await loadOrCreateVapidKeys(path);
		const second = await loadOrCreateVapidKeys(path);
		assertEquals(second.publicKeyRaw, first.publicKeyRaw);
		assertEquals(second.privateKeyD, first.privateKeyD);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("persists the key file as owner-only-readable on POSIX", async () => {
	if (platform === "win32") return;
	const directory = await makeTempDir();
	const path = join(directory, "push-vapid-keys.json");
	try {
		await loadOrCreateVapidKeys(path);
		const mode = (await stat(path)).mode & 0o777;
		assertEquals(mode, 0o600);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("ignores a corrupt key file and regenerates", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "push-vapid-keys.json");
	try {
		await Bun.write(path, "not json");
		const keys = await loadOrCreateVapidKeys(path);
		assertEquals(keys.publicKeyRaw.length, 65);
	} finally {
		await rm(directory, { recursive: true });
	}
});

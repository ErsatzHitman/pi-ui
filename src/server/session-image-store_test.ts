import { test } from "bun:test";
import { readdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";

import { assert, assertEquals } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { isNotFound } from "../utils/fs-errors.ts";
import {
	DEFAULT_MAX_AGE_MS,
	DEFAULT_MAX_TOTAL_BYTES,
	decodeBase64Image,
	sessionImageId,
	SessionImageStore,
	sweepSessionImages,
} from "./session-image-store.ts";

const png = { data: "aW1hZ2U=", mimeType: "image/png" };

async function withTempDir(
	callback: (directory: string) => Promise<void>,
): Promise<void> {
	const directory = await makeTempDir({ prefix: "pi-ui-session-images-test-" });
	try {
		await callback(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("register returns a content-addressed URL and dedups the same image", () => {
	const store = new SessionImageStore();
	const first = store.register(png);
	const second = store.register({ ...png });
	assertEquals(first, second);
	assertEquals(first, `/sessions/image?id=${sessionImageId(png)}`);
	// A different mime type over the same bytes is a different id — mime type is
	// part of what gets served (content-type), so it must be part of the identity.
	assertEquals(
		store.register({ data: png.data, mimeType: "image/jpeg" }) === first,
		false,
	);
});

test("get resolves a just-registered image from memory without needing disk to have settled", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		const url = store.register(png);
		const id = new URL(url, "http://x").searchParams.get("id") ?? "";
		assertEquals(await store.get(id), png);
	});
});

test("an unknown, well-formed id resolves to undefined", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		assertEquals(await store.get("0".repeat(64)), undefined);
	});
});

test("get rejects ids that aren't a bare 64-hex content hash, without touching the filesystem", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		for (const id of [
			"",
			"not-a-hash",
			"../../etc/passwd",
			`${"a".repeat(64)}/../evil`,
			"AAAA0000".repeat(8), // uppercase hex isn't the canonical lowercase form
			`${"a".repeat(63)}`, // one short
			`${"a".repeat(65)}`, // one long
			crypto.randomUUID(), // the old, pre-persistence id shape
		]) {
			assertEquals(await store.get(id), undefined);
		}
		// None of the rejected ids should have caused any file to be created or read
		// (the temp dir itself already exists — `makeTempDir` created it).
		assertEquals(await readdir(directory), []);
	});
});

test("an image survives a simulated restart: a fresh store over the same directory serves it from disk", async () => {
	await withTempDir(async (directory) => {
		const first = new SessionImageStore({ directory });
		const url = first.register(png);
		await first.flush();
		const id = new URL(url, "http://x").searchParams.get("id") ?? "";

		// A brand-new store, as if the process had restarted: no in-memory state at all.
		const restarted = new SessionImageStore({ directory });
		assertEquals(await restarted.get(id), png);
	});
});

test("clear drops the in-memory cache but leaves persisted files (and other sessions' images) alone", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		const url = store.register(png);
		await store.flush();
		const id = new URL(url, "http://x").searchParams.get("id") ?? "";

		store.clear();
		assertEquals(await store.get(id), png);
	});
});

test("register persists distinct mime types for the same bytes as separate files", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		const pngUrl = store.register(png);
		const jpegUrl = store.register({ data: png.data, mimeType: "image/jpeg" });
		await store.flush();
		assert(pngUrl !== jpegUrl, "Expected distinct URLs for distinct mime types");

		const restarted = new SessionImageStore({ directory });
		const pngId = new URL(pngUrl, "http://x").searchParams.get("id") ?? "";
		const jpegId = new URL(jpegUrl, "http://x").searchParams.get("id") ?? "";
		assertEquals(await restarted.get(pngId), png);
		assertEquals(await restarted.get(jpegId), {
			data: png.data,
			mimeType: "image/jpeg",
		});
	});
});

test("persisted bytes on disk decode back to the exact original image bytes", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		const url = store.register(png);
		await store.flush();
		const id = new URL(url, "http://x").searchParams.get("id") ?? "";
		const bytes = await Bun.file(join(directory, `${id}.bin`)).bytes();
		assertEquals(bytes, decodeBase64Image(png.data));
	});
});

test("registering the same image again after it is already on disk does not rewrite it", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		store.register(png);
		await store.flush();
		const binPath = join(directory, `${sessionImageId(png)}.bin`);
		const before = (await Bun.file(binPath).stat()).mtime.getTime();
		await utimes(binPath, new Date(before - 10_000), new Date(before - 10_000));
		const backdated = (await Bun.file(binPath).stat()).mtime.getTime();

		store.register(png);
		await store.flush();

		// A no-op register must not have touched (rewritten) the file's mtime.
		assertEquals((await Bun.file(binPath).stat()).mtime.getTime(), backdated);
	});
});

test("get touches an image's mtime, refreshing it against LRU eviction", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		const url = store.register(png);
		await store.flush();
		const id = new URL(url, "http://x").searchParams.get("id") ?? "";
		const binPath = join(directory, `${id}.bin`);
		const old = new Date(Date.now() - 10_000);
		await utimes(binPath, old, old);

		await store.get(id);

		const after = (await Bun.file(binPath).stat()).mtime.getTime();
		assert(after > old.getTime(), "Expected get() to refresh the file's mtime");
	});
});

test("default bounds are generous (200 MiB, 30 days)", () => {
	assertEquals(DEFAULT_MAX_TOTAL_BYTES, 200 * 1024 * 1024);
	assertEquals(DEFAULT_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
});

test("registering past the size budget evicts the least-recently-touched image, not the newest", async () => {
	await withTempDir(async (directory) => {
		// Each payload decodes to 4 bytes; a 9-byte budget fits two but not three.
		const a = { data: Buffer.from("aaaa").toString("base64"), mimeType: "image/png" };
		const b = { data: Buffer.from("bbbb").toString("base64"), mimeType: "image/png" };
		const c = { data: Buffer.from("cccc").toString("base64"), mimeType: "image/png" };
		const store = new SessionImageStore({
			directory,
			maxTotalBytes: 9,
			maxAgeMs: DEFAULT_MAX_AGE_MS,
		});

		const urlA = store.register(a);
		await store.flush();
		// Back-date A so it's unambiguously the oldest by mtime, whatever this
		// filesystem's mtime resolution is (some report whole seconds).
		const idA = new URL(urlA, "http://x").searchParams.get("id") ?? "";
		const old = new Date(Date.now() - 60_000);
		await utimes(join(directory, `${idA}.bin`), old, old);

		const urlB = store.register(b);
		await store.flush();
		const urlC = store.register(c);
		await store.flush();

		const idB = new URL(urlB, "http://x").searchParams.get("id") ?? "";
		const idC = new URL(urlC, "http://x").searchParams.get("id") ?? "";

		const restarted = new SessionImageStore({ directory });
		assertEquals(await restarted.get(idA), undefined, "Expected the oldest evicted");
		assertEquals(await restarted.get(idB), b);
		assertEquals(await restarted.get(idC), c);
	});
});

test("sweepSessionImages removes images older than maxAgeMs regardless of total size", async () => {
	await withTempDir(async (directory) => {
		await Bun.write(join(directory, "aa".repeat(32) + ".bin"), "old");
		await Bun.write(
			join(directory, "aa".repeat(32) + ".json"),
			JSON.stringify({ mimeType: "image/png" }),
		);
		await Bun.write(join(directory, "bb".repeat(32) + ".bin"), "new");
		await Bun.write(
			join(directory, "bb".repeat(32) + ".json"),
			JSON.stringify({ mimeType: "image/png" }),
		);
		const old = new Date(Date.now() - 1_000_000);
		await utimes(join(directory, "aa".repeat(32) + ".bin"), old, old);

		await sweepSessionImages(directory, {
			maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
			maxAgeMs: 500_000,
		});

		const remaining = new Set(await readdir(directory));
		assert(!remaining.has(`${"aa".repeat(32)}.bin`), "Expected the old pair removed");
		assert(
			!remaining.has(`${"aa".repeat(32)}.json`),
			"Expected the old pair's meta removed",
		);
		assert(remaining.has(`${"bb".repeat(32)}.bin`), "Expected the fresh pair kept");
	});
});

test("sweepSessionImages tolerates a directory that does not exist yet", async () => {
	await withTempDir(async (directory) => {
		const missing = join(directory, "does-not-exist");
		await sweepSessionImages(missing, {
			maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
			maxAgeMs: DEFAULT_MAX_AGE_MS,
		});
	});
});

test("sweepSessionImages evicts oldest-mtime pairs first until under the total budget", async () => {
	await withTempDir(async (directory) => {
		const ids = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
		for (const [index, id] of ids.entries()) {
			await Bun.write(join(directory, `${id}.bin`), "xxxx");
			await Bun.write(
				join(directory, `${id}.json`),
				JSON.stringify({ mimeType: "image/png" }),
			);
			const mtime = new Date(Date.now() - (ids.length - index) * 10_000);
			await utimes(join(directory, `${id}.bin`), mtime, mtime);
		}

		// 3 files * 4 bytes = 12 total; budget 8 keeps only the two newest.
		await sweepSessionImages(directory, {
			maxTotalBytes: 8,
			maxAgeMs: DEFAULT_MAX_AGE_MS,
		});

		const remaining = new Set(await readdir(directory));
		assert(!remaining.has(`${ids[0]}.bin`), "Expected the oldest evicted");
		assert(remaining.has(`${ids[1]}.bin`), "Expected the middle kept");
		assert(remaining.has(`${ids[2]}.bin`), "Expected the newest kept");
	});
});

test("a route-shaped 404 path: get() on a deleted-from-disk id after clear() resolves to undefined", async () => {
	await withTempDir(async (directory) => {
		const store = new SessionImageStore({ directory });
		const url = store.register(png);
		await store.flush();
		const id = new URL(url, "http://x").searchParams.get("id") ?? "";
		store.clear();

		await rm(join(directory, `${id}.bin`));
		await rm(join(directory, `${id}.json`));

		assertEquals(await store.get(id), undefined);
	});
});

test("isNotFound recognizes a missing directory the way sweepSessionImages relies on", async () => {
	await withTempDir(async (directory) => {
		try {
			await readdir(join(directory, "missing"));
			assert(false, "Expected readdir of a missing directory to throw");
		} catch (error) {
			assert(isNotFound(error), "Expected an ENOENT-shaped error");
		}
	});
});

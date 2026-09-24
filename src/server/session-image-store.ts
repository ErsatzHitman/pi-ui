import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

import { appDataPath } from "../utils/app-dirs.ts";
import { isBusy, isNotFound, isPermissionDenied } from "../utils/fs-errors.ts";
import { isRecord, isString } from "../utils/type-guards.ts";

/**
 * RM2 persistence item 1: pasted/attached images used to live only in an in-memory
 * `Map`, so every one vanished on restart and `GET /sessions/image?id=` 404'd for a
 * resumed session that referenced one. `register()` now also persists the decoded
 * bytes to disk (best-effort, fire-and-forget so it stays synchronous — it is called
 * from `MessageRenderService.project()` mid-render) under the id it returns, and
 * `get()` falls back to disk when an id isn't in this process's in-memory cache
 * (either a cold start, or after `clear()`).
 *
 * Ids are a SHA-256 of `mimeType\0data`, not `crypto.randomUUID()`: the same pasted
 * image reused across sessions/messages content-addresses to the same file instead
 * of being written again, and — since `MessageRenderService.transcriptReplacing()`
 * calls `clear()` on every session switch/`/new` — the very same image resolves to
 * the same URL again after a switch instead of needing a fresh disk write. An id is
 * exactly 64 lowercase hex characters; `get()` rejects anything else before it ever
 * reaches a file path, since the id arrives as an untrusted URL query parameter.
 *
 * On-disk layout, under `directory` (default: the platform data dir, see
 * `sessionImagesDirectory()`): `<id>.bin` (raw decoded bytes) and `<id>.json`
 * (`{"mimeType": "..."}`) written together, atomically (temp file + rename, mirroring
 * `session-summary-cache.ts`'s `writeSessionSummaryCache`). A read or write touches
 * `<id>.bin`'s mtime (`#touch`), which doubles as the "last accessed" clock the
 * bounded-size sweep (`sweepSessionImages`) uses for LRU eviction — no separate index
 * file to keep in sync, so a crash mid-write can never leave the store's own
 * bookkeeping inconsistent with what's actually on disk.
 */
export type StoredSessionImage = {
	data: string;
	mimeType: string;
};

export type SessionImageStoreOptions = {
	/** Overridden in tests; defaults to `sessionImagesDirectory()`. */
	directory?: string;
	/** Total on-disk bytes (across `.bin` files) the store keeps before evicting the
	 * least-recently-touched images. */
	maxTotalBytes?: number;
	/** An image untouched for longer than this is evicted regardless of total size. */
	maxAgeMs?: number;
};

const BIN_SUFFIX = ".bin";
const META_SUFFIX = ".json";
const ID_PATTERN = /^[0-9a-f]{64}$/;

/** 200 MiB: generous for pasted screenshots (a handful of MB each) without letting a
 * long-lived server's data dir grow unbounded. */
export const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** 30 days: long enough that a resumed old session's images are still there, short
 * enough that a stale image doesn't sit forever. */
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionImagesDirectory(): string {
	return appDataPath("session-images");
}

/** Content-addressed id for `image`: the same bytes + mime type always produce the
 * same id, so re-registering an already-known image is a no-op disk write. */
export function sessionImageId(image: StoredSessionImage): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(image.mimeType);
	hasher.update("\0");
	hasher.update(image.data);
	return hasher.digest("hex");
}

export class SessionImageStore {
	readonly #images = new Map<string, StoredSessionImage>();
	readonly #directory: string;
	readonly #maxTotalBytes: number;
	readonly #maxAgeMs: number;
	readonly #onDisk = new Set<string>();
	// Serializes every disk write and sweep in registration order, one queue for the
	// whole store — a sweep must never run concurrently with (and possibly race) a
	// write it hasn't seen yet.
	#queue: Promise<void> = Promise.resolve();

	constructor(options: SessionImageStoreOptions = {}) {
		this.#directory = options.directory ?? sessionImagesDirectory();
		this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
		this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	}

	register(image: StoredSessionImage): string {
		const id = sessionImageId(image);
		if (!this.#images.has(id)) this.#images.set(id, image);
		this.#enqueue(() => this.#persist(id, image));
		return `/sessions/image?id=${encodeURIComponent(id)}`;
	}

	async get(id: string): Promise<StoredSessionImage | undefined> {
		const cached = this.#images.get(id);
		if (cached) {
			await this.#touch(id);
			return cached;
		}
		if (!ID_PATTERN.test(id)) return undefined;
		const loaded = await this.#load(id);
		if (loaded) {
			this.#images.set(id, loaded);
			this.#onDisk.add(id);
			await this.#touch(id);
		}
		return loaded;
	}

	/** Drops the in-memory cache only — persisted files (and other sessions' images
	 * still referenced from disk) are untouched. Called on every session switch/`/new`
	 * (`MessageRenderService.transcriptReplacing()`); `register()`/`get()` reload from
	 * disk as needed afterward. */
	clear(): void {
		this.#images.clear();
		this.#onDisk.clear();
	}

	/** Test-only: resolves once every disk write/sweep queued so far has settled. */
	flush(): Promise<void> {
		return this.#queue;
	}

	#binPath(id: string): string {
		return join(this.#directory, `${id}${BIN_SUFFIX}`);
	}

	#metaPath(id: string): string {
		return join(this.#directory, `${id}${META_SUFFIX}`);
	}

	#enqueue(task: () => Promise<void>): void {
		this.#queue = this.#queue.catch(() => undefined).then(task);
	}

	async #persist(id: string, image: StoredSessionImage): Promise<void> {
		if (this.#onDisk.has(id)) return;
		let wroteNewFile = false;
		try {
			const binPath = this.#binPath(id);
			if (await Bun.file(binPath).exists()) {
				this.#onDisk.add(id);
				return;
			}
			await mkdir(this.#directory, { recursive: true });
			const bytes = decodeBase64Image(image.data);
			await writeAtomic(binPath, bytes);
			await writeAtomic(
				this.#metaPath(id),
				new TextEncoder().encode(JSON.stringify({ mimeType: image.mimeType })),
			);
			this.#onDisk.add(id);
			wroteNewFile = true;
		} catch {
			// Best-effort: an unwritable data dir must not break in-memory serving
			// for the rest of this process's run — only cross-restart persistence
			// (and the bounded-size sweep) is lost.
		}
		// Only a fresh write can have pushed the directory over budget — an
		// already-on-disk image (the common case for a re-rendered message) skips
		// the readdir + stat-per-file cost of a sweep entirely.
		if (wroteNewFile) {
			await sweepSessionImages(this.#directory, {
				maxTotalBytes: this.#maxTotalBytes,
				maxAgeMs: this.#maxAgeMs,
			}).catch(() => undefined);
		}
	}

	async #load(id: string): Promise<StoredSessionImage | undefined> {
		try {
			const meta: unknown = JSON.parse(await Bun.file(this.#metaPath(id)).text());
			if (!isRecord(meta) || !isString(meta.mimeType)) return undefined;
			const bytes = await Bun.file(this.#binPath(id)).bytes();
			return { data: bytes.toBase64(), mimeType: meta.mimeType };
		} catch {
			// Missing, corrupt JSON, or a mid-write partial pair: treat as absent.
			return undefined;
		}
	}

	async #touch(id: string): Promise<void> {
		const now = new Date();
		await utimes(this.#binPath(id), now, now).catch(() => undefined);
	}
}

export function decodeBase64Image(data: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.fromBase64(data);
}

/**
 * Bounded-size + age cleanup for a `SessionImageStore`'s on-disk `directory`, exported
 * standalone so it's directly testable against a scratch directory of `.bin`/`.json`
 * pairs with controlled sizes and mtimes. Age cleanup runs first (anything untouched
 * longer than `maxAgeMs` is removed regardless of total size); if the remainder still
 * exceeds `maxTotalBytes`, the least-recently-touched (`.bin` mtime — see `#touch`)
 * pairs are removed next until it fits. Best-effort throughout: a file that vanishes
 * mid-sweep (another sweep, or a fresh write racing in) is skipped, not an error.
 */
export async function sweepSessionImages(
	directory: string,
	options: { maxTotalBytes: number; maxAgeMs: number; now?: number },
): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}
	const now = options.now ?? Date.now();
	const ids = new Set(
		entries
			.filter((name) => name.endsWith(BIN_SUFFIX))
			.map((name) => name.slice(0, -BIN_SUFFIX.length)),
	);
	const records: { id: string; size: number; mtimeMs: number }[] = [];
	for (const id of ids) {
		try {
			const info = await stat(join(directory, `${id}${BIN_SUFFIX}`));
			records.push({ id, size: info.size, mtimeMs: info.mtimeMs });
		} catch {
			// Vanished between the readdir and this stat: nothing to sweep.
		}
	}
	let totalBytes = records.reduce((sum, record) => sum + record.size, 0);
	const kept: typeof records = [];
	for (const record of records) {
		if (now - record.mtimeMs > options.maxAgeMs) {
			await removePair(directory, record.id);
			totalBytes -= record.size;
		} else {
			kept.push(record);
		}
	}
	if (totalBytes <= options.maxTotalBytes) return;
	kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const record of kept) {
		if (totalBytes <= options.maxTotalBytes) break;
		await removePair(directory, record.id);
		totalBytes -= record.size;
	}
}

async function removePair(directory: string, id: string): Promise<void> {
	await Promise.all([
		rm(join(directory, `${id}${BIN_SUFFIX}`), { force: true }),
		rm(join(directory, `${id}${META_SUFFIX}`), { force: true }),
	]);
}

/**
 * Atomic write mirroring `session-summary-cache.ts`'s `writeSessionSummaryCache`:
 * write to a unique temp file, then rename over the target. Windows refuses to rename
 * over a file another handle has briefly open (EPERM/EACCES/EBUSY) — retried a few
 * times, same policy as that module's `renameReplacing`.
 */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
	const temp = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temp, bytes);
		await renameReplacing(temp, path);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function renameReplacing(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const retryable = isPermissionDenied(error) || isBusy(error);
			if (!retryable || attempt >= 5) throw error;
			await Bun.sleep(10 * 2 ** attempt);
		}
	}
}

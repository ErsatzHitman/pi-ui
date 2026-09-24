import { test } from "bun:test";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { assert, assertEquals, assertRejects } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import {
	cleanupStaleTransferDirs,
	MAX_TRANSFER_FILES,
	MAX_TRANSFER_FILE_BYTES,
	MAX_TRANSFER_REQUEST_BYTES,
	MAX_TRANSFER_TOTAL_BYTES,
	getTransferredFiles,
	sanitizeFileName,
	TransferredFileStore,
	validateTransferContentLength,
	validateTransferredFiles,
} from "./transferred-files.ts";

test("transfer extraction ignores empty and non-File fields", () => {
	const formData = new FormData();
	assertEquals(getTransferredFiles(formData), []);
	formData.append("file", "not a file");
	formData.append("other", new File(["ignored"], "ignored.txt"));
	assertEquals(getTransferredFiles(formData), []);
	formData.append("file", new File(["included"], "included.txt"));
	assertEquals(
		getTransferredFiles(formData).map((file) => file.name),
		["included.txt"],
	);
});

test("transfer limits accept exact boundaries and empty input", () => {
	assertEquals(validateTransferredFiles([]), undefined);
	assertEquals(
		validateTransferredFiles(
			Array.from({ length: MAX_TRANSFER_FILES }, (_, index) => ({
				name: `${index}.txt`,
				size: index === 0 ? MAX_TRANSFER_FILE_BYTES : 0,
			})),
		),
		undefined,
	);
	assertEquals(
		validateTransferredFiles([
			{ name: "one", size: MAX_TRANSFER_FILE_BYTES },
			{ name: "two", size: MAX_TRANSFER_FILE_BYTES },
			{ name: "three", size: MAX_TRANSFER_FILE_BYTES / 2 },
		]),
		undefined,
	);
});

test("transfer limits reject one over each boundary", () => {
	assertEquals(
		validateTransferredFiles(
			Array.from({ length: MAX_TRANSFER_FILES + 1 }, (_, index) => ({
				name: `${index}.txt`,
				size: 0,
			})),
		)?.code,
		"too-many-files",
	);
	assertEquals(
		validateTransferredFiles([{ name: "large", size: MAX_TRANSFER_FILE_BYTES + 1 }])
			?.code,
		"file-too-large",
	);
	assertEquals(
		validateTransferredFiles([
			{ name: "one", size: MAX_TRANSFER_FILE_BYTES },
			{ name: "two", size: MAX_TRANSFER_FILE_BYTES },
			{
				name: "three",
				size: MAX_TRANSFER_TOTAL_BYTES - 2 * MAX_TRANSFER_FILE_BYTES + 1,
			},
		])?.code,
		"total-too-large",
	);
});

test("content length uses a looser multipart request boundary", () => {
	assertEquals(
		validateTransferContentLength(String(MAX_TRANSFER_REQUEST_BYTES)),
		undefined,
	);
	assertEquals(
		validateTransferContentLength(String(MAX_TRANSFER_REQUEST_BYTES + 1))?.code,
		"request-too-large",
	);
	assertEquals(validateTransferContentLength(null), undefined);
});

test("store validates sizes before reading any file body", async () => {
	await withTempRoot(async (tempRoot) => {
		const store = await TransferredFileStore.create({ tempRoot });
		let bodyRead = false;
		try {
			await assertRejects(() =>
				store.importFiles([
					{
						name: "too-large.txt",
						size: MAX_TRANSFER_FILE_BYTES + 1,
						arrayBuffer: () => {
							bodyRead = true;
							return Promise.resolve(new ArrayBuffer(0));
						},
					},
				]),
			);
			assert(!bodyRead, "Expected validation before reading a file body");
		} finally {
			await store.dispose();
		}
	});
});

test("store sanitizes names and generates collision-safe paths", async () => {
	await withTempRoot(async (tempRoot) => {
		const store = await TransferredFileStore.create({ tempRoot });
		try {
			const paths = await store.importFiles([
				memoryFile("../same name?.txt", "first"),
				memoryFile("../same name?.txt", "second"),
			]);
			assert(paths[0] !== paths[1], "Expected unique imported paths");
			for (const path of paths) {
				// The store joins with `node:path`'s native separator, not `/`.
				assert(
					path.startsWith(`${store.rootPath}${sep}`),
					"Expected imports inside the owned root",
				);
				assert(
					path.endsWith(`-${sanitizeFileName("../same name?.txt")}`),
					"Expected a sanitized basename",
				);
			}
			assertEquals(await Bun.file(paths[0]).text(), "first");
			assertEquals(await Bun.file(paths[1]).text(), "second");
		} finally {
			await store.dispose();
		}
	});
});

test("store removes all files from a failed import", async () => {
	await withTempRoot(async (tempRoot) => {
		const store = await TransferredFileStore.create({ tempRoot });
		try {
			await assertRejects(() =>
				store.importFiles([
					memoryFile("written.txt", "written"),
					{
						name: "failed.txt",
						size: 1,
						arrayBuffer: () => Promise.reject(new Error("read failed")),
					},
				]),
			);
			assertEquals(await readdir(store.rootPath), []);
		} finally {
			await store.dispose();
		}
	});
});

test("store disposal is idempotent and scoped to its owned root", async () => {
	await withTempRoot(async (tempRoot) => {
		const sibling = `${tempRoot}/keep.txt`;
		await Bun.write(sibling, "keep");
		const store = await TransferredFileStore.create({ tempRoot });
		await store.importFiles([memoryFile("remove.txt", "remove")]);

		await store.dispose();
		await store.dispose();

		await stat(sibling);
		await assertRejects(() => stat(store.rootPath));
	});
});

test("stale transfer dirs from a crashed process are removed, fresh and unrelated entries are kept", async () => {
	await withTempRoot(async (tempRoot) => {
		const stalePath = join(tempRoot, "pi-ui-transfers-stale");
		const freshPath = join(tempRoot, "pi-ui-transfers-fresh");
		const unrelatedDir = join(tempRoot, "some-other-dir");
		const nonDirEntry = join(tempRoot, "pi-ui-transfers-not-a-dir");
		await mkdir(stalePath);
		await Bun.write(join(stalePath, "leftover.txt"), "leftover");
		await mkdir(freshPath);
		await mkdir(unrelatedDir);
		await writeFile(nonDirEntry, "not a directory");

		// Back-date the stale directory well before this process started.
		const longAgo = new Date(Date.now() - 1_000_000_000);
		await utimes(stalePath, longAgo, longAgo);

		await cleanupStaleTransferDirs(tempRoot);

		const remaining = new Set(await readdir(tempRoot));
		assert(!remaining.has("pi-ui-transfers-stale"), "Expected the stale dir removed");
		assert(remaining.has("pi-ui-transfers-fresh"), "Expected the fresh dir kept");
		assert(remaining.has("some-other-dir"), "Expected the unrelated dir kept");
		assert(
			remaining.has("pi-ui-transfers-not-a-dir"),
			"Expected the non-directory kept",
		);
	});
});

test("cleanup tolerates a missing temp root", async () => {
	await withTempRoot(async (tempRoot) => {
		await rm(tempRoot, { recursive: true, force: true });
		await cleanupStaleTransferDirs(tempRoot);
	});
});

test("a directory whose owning process is still running is never removed, even if its mtime looks stale", async () => {
	await withTempRoot(async (tempRoot) => {
		const owner = await spawnLiveOwner(tempRoot);
		try {
			// An ordinary gap between pasted files, not a sign the owner crashed — this is
			// exactly what made the previous mtime-only heuristic unsafe.
			const longAgo = new Date(Date.now() - 1_000_000_000);
			await utimes(owner.rootPath, longAgo, longAgo);

			await cleanupStaleTransferDirs(tempRoot);

			await stat(owner.rootPath); // still there: does not throw
		} finally {
			await owner.kill();
		}
	});
});

test("a directory whose owning process has exited is removed even though its mtime is fresh", async () => {
	await withTempRoot(async (tempRoot) => {
		const owner = await spawnLiveOwner(tempRoot);
		const rootPath = owner.rootPath;
		await owner.kill();

		await cleanupStaleTransferDirs(tempRoot);

		await assertRejects(() => stat(rootPath));
	});
});

test("a fresh store's directory name embeds this process's own pid", async () => {
	await withTempRoot(async (tempRoot) => {
		const store = await TransferredFileStore.create({ tempRoot });
		try {
			const name = store.rootPath.split(sep).at(-1) ?? "";
			assertEquals(name.startsWith(`pi-ui-transfers-${process.pid}-`), true);
		} finally {
			await store.dispose();
		}
	});
});

test("creating a store cleans up stale sibling transfer dirs first", async () => {
	await withTempRoot(async (tempRoot) => {
		const stalePath = join(tempRoot, "pi-ui-transfers-stale");
		await mkdir(stalePath);
		const longAgo = new Date(Date.now() - 1_000_000_000);
		await utimes(stalePath, longAgo, longAgo);

		const store = await TransferredFileStore.create({ tempRoot });
		try {
			const remaining = await readdir(tempRoot);
			assert(
				!remaining.includes("pi-ui-transfers-stale"),
				"Expected the stale dir removed on startup",
			);
		} finally {
			await store.dispose();
		}
	});
});

function memoryFile(name: string, contents: string) {
	const bytes = new TextEncoder().encode(contents);
	return {
		name,
		size: bytes.byteLength,
		arrayBuffer: async () => bytes.slice().buffer,
	};
}

async function withTempRoot(callback: (path: string) => Promise<void>): Promise<void> {
	const path = await makeTempDir({ prefix: "pi-ui-transfer-test-" });
	try {
		await callback(path);
	} finally {
		await rm(path, { recursive: true, force: true });
	}
}

/**
 * Spawns a genuinely separate OS process that creates its own
 * `TransferredFileStore` under `tempRoot` and then blocks forever — a
 * faithful reproduction of "two pi-ui instances against the same temp root",
 * which a single process backdating a directory's mtime with `utimes` cannot
 * exercise (there is no second, still-live owner to race against).
 */
async function spawnLiveOwner(
	tempRoot: string,
): Promise<{ rootPath: string; kill: () => Promise<void> }> {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
			import { TransferredFileStore } from "./src/server/transferred-files.ts";
			const store = await TransferredFileStore.create({ tempRoot: process.argv[1] });
			process.stdout.write(store.rootPath + "\\n");
			await new Promise(() => {});
			`,
			tempRoot,
		],
		{ cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
	);
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	await reader.cancel();
	const rootPath = new TextDecoder().decode(value).trim();
	assert(rootPath.length > 0, "Expected the live-owner child to report its store path");
	return {
		rootPath,
		async kill() {
			child.kill();
			await child.exited;
		},
	};
}

import { test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";

import { assertEquals } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { writeSecretFile } from "./secret-file.ts";

test("writes the file, creating parent directories", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "nested", "secret.json");
	try {
		await writeSecretFile(path, "hello");
		assertEquals(await Bun.file(path).text(), "hello");
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("the written file is owner-only-readable on POSIX", async () => {
	if (platform === "win32") return;
	const directory = await makeTempDir();
	const path = join(directory, "secret.json");
	try {
		await writeSecretFile(path, "hello");
		const mode = (await stat(path)).mode & 0o777;
		assertEquals(mode, 0o600);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("replaces an existing (possibly world-readable) file", async () => {
	const directory = await makeTempDir();
	const path = join(directory, "secret.json");
	try {
		await Bun.write(path, "old");
		await writeSecretFile(path, "new");
		assertEquals(await Bun.file(path).text(), "new");
	} finally {
		await rm(directory, { recursive: true });
	}
});

import { test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assert, assertEquals } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { materializePiCliThemes, piCliPackageDir } from "./pi-cli-passthrough.ts";

const packageThemeDir = join(
	import.meta.dir,
	"..",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
	"modes",
	"interactive",
	"theme",
);

test("materializePiCliThemes writes pi's own dark/light themes and is idempotent", async () => {
	const dir = await makeTempDir({ prefix: "pi-cli-themes-" });
	await materializePiCliThemes(dir);
	for (const name of ["dark.json", "light.json"]) {
		const written = JSON.parse(await readFile(join(dir, "theme", name), "utf8"));
		const original = JSON.parse(await readFile(join(packageThemeDir, name), "utf8"));
		assertEquals(written, original);
	}
	const before = await readFile(join(dir, "theme", "dark.json"), "utf8");
	await materializePiCliThemes(dir);
	assertEquals(await readFile(join(dir, "theme", "dark.json"), "utf8"), before);
});

test("materializePiCliThemes repairs a truncated theme file", async () => {
	const dir = await makeTempDir({ prefix: "pi-cli-themes-" });
	await mkdir(join(dir, "theme"), { recursive: true });
	await writeFile(join(dir, "theme", "dark.json"), "{");
	await materializePiCliThemes(dir);
	JSON.parse(await readFile(join(dir, "theme", "dark.json"), "utf8"));
});

test("piCliPackageDir only redirects a compiled binary without its own themes", async () => {
	const cacheDir = await makeTempDir({ prefix: "pi-cli-cache-" });
	const bareBinDir = await makeTempDir({ prefix: "pi-cli-bin-" });
	const base = {
		compiled: true,
		execPath: join(bareBinDir, "pi-ui"),
		envPackageDir: undefined,
		cacheDir,
	};

	const dir = piCliPackageDir(base);
	assert(
		dir !== undefined && dir.startsWith(cacheDir),
		`expected a cache dir, got ${dir}`,
	);
	assertEquals(piCliPackageDir({ ...base, compiled: false }), undefined);
	assertEquals(piCliPackageDir({ ...base, envPackageDir: "/opt/pi" }), undefined);

	await mkdir(join(bareBinDir, "theme"), { recursive: true });
	await writeFile(join(bareBinDir, "theme", "dark.json"), "{}");
	assertEquals(piCliPackageDir(base), undefined);
});

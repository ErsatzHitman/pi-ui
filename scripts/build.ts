import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `--target=<bun compile target>` (e.g. `bun-linux-x64`, `bun-linux-arm64`) cross-compiles
 * a standalone executable for another OS/architecture than the one running this script,
 * so a Linux deploy binary can be built from Windows or macOS. Omitted, the build targets
 * the current platform, same as before this flag existed.
 */
export function parseBuildTarget(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--target") {
			const value = args[index + 1];
			if (!value) throw new Error("--target requires a value, e.g. bun-linux-x64");
			return value;
		}
		if (argument.startsWith("--target=")) {
			const value = argument.slice("--target=".length);
			if (!value) throw new Error("--target requires a value, e.g. bun-linux-x64");
			return value;
		}
	}
	return undefined;
}

export function buildOutfile(target: string | undefined): string {
	return target ? `./dist/pi-ui-${target}` : "./dist/pi-ui";
}

/**
 * `@earendil-works/pi-coding-agent`'s own npm package root (resolved through its "."
 * export, `dist/index.js`, rather than a direct subpath — the package's `exports` map
 * does not list its theme files, so resolving them by hand would break under Node/Bun's
 * exports enforcement).
 */
function piCliPackageDir(): string {
	const indexJs = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return dirname(dirname(indexJs));
}

/**
 * `@earendil-works/pi-coding-agent`'s built-in theme JSON files (`dark.json`/`light.json`)
 * this repo's own compiled binary now needs a sibling copy of. `runPiCli` (server-main.ts)
 * runs the bundled pi CLI's `main()` in-process so a sub-agent's re-invocation of "the
 * running pi" works under pi-ui — see PLAN-ux.md "subagents". Its startup unconditionally
 * calls `getThemesDir()`, and for a `bun build --compile` executable (`isBunBinary`, see
 * config.js) that resolves to a `theme/` directory next to `process.execPath`, not
 * anything `compile.assets` embeds (that only rewrites *relative-import* file reads at
 * compile time; `getThemesDir()` builds an absolute OS path from `process.execPath`
 * instead) and not anywhere under node_modules, which does not ship with the compiled
 * binary. Without this, every sub-agent under a compiled pi-ui failed at startup with
 * `ENOENT: no such file or directory, open '.../theme/dark.json'` even after the
 * `isPiCliPassthrough` argv fix — caught by testing the actual compiled Linux binary, not
 * only `bun src/server-main.ts` from source, where `isBunBinary` is false and
 * `getThemesDir()` finds the same files under node_modules instead.
 */
export function piCliThemeFiles(): string[] {
	const themeDir = join(piCliPackageDir(), "dist", "modes", "interactive", "theme");
	return ["dark.json", "light.json"].map((name) => join(themeDir, name));
}

if (import.meta.main) {
	const target = parseBuildTarget(process.argv.slice(2));
	const outfile = buildOutfile(target);

	await mkdir("dist", { recursive: true });
	const compile: Bun.BuildConfig["compile"] = { assets: ["./static"], outfile };
	if (target) {
		// SAFETY: Bun.Build.CompileTarget is a closed string union (bun-<os>-<arch>[-…]);
		// an invalid --target fails the build itself with Bun's own error message.
		compile.target = target as Bun.Build.CompileTarget;
	}

	const result = await Bun.build({
		entrypoints: ["src/server-main.ts"],
		compile,
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		minify: true,
		sourcemap: "linked",
		bytecode: true,
	});

	for (const log of result.logs) console.warn(log);
	if (!result.success) process.exitCode = 1;
	else {
		const themeDir = join(dirname(outfile), "theme");
		await mkdir(themeDir, { recursive: true });
		for (const source of piCliThemeFiles()) {
			// SAFETY: `source` comes from piCliThemeFiles(), which joins a non-empty
			// basename ("dark.json"/"light.json") onto a directory — splitting on a path
			// separator always leaves at least that one non-empty final segment.
			const basename = source.split(/[\\/]/).at(-1) as string;
			await Bun.write(join(themeDir, basename), Bun.file(source));
		}
	}
}

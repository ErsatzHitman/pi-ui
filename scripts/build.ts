import { mkdir } from "node:fs/promises";

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
}

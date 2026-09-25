import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import darkTheme from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json" with { type: "json" };
import lightTheme from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json" with { type: "json" };
import { extensionsHostMarkerEnvVar } from "./agent/extensions-config.ts";
import { appCachePath } from "./utils/app-dirs.ts";
import { isVersionRequest } from "./version.ts";

/**
 * The bundled pi CLI's built-in themes, embedded in pi-ui itself. Its startup calls
 * `getThemesDir()`, which for a `bun build --compile` executable resolves to a `theme/`
 * directory next to `process.execPath` (or under `PI_PACKAGE_DIR`) on the real
 * filesystem — node_modules does not ship with the binary. Package managers install the
 * bare binary (Homebrew, AUR's /usr/bin, install.sh), so a sibling directory is not
 * reliable; see `piCliPackageDir`.
 */
const piCliThemes = { "dark.json": darkTheme, "light.json": lightTheme } as const;

/** True inside a `bun build --compile` executable (same test pi's own config.js uses). */
function isCompiledBinary(): boolean {
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

/**
 * Writes the embedded pi CLI themes into `<dir>/theme/`, atomically per file (temp +
 * rename) so concurrent sub-agent children never read a half-written theme. Files that
 * already hold the right content are left alone.
 */
export async function materializePiCliThemes(dir: string): Promise<void> {
	const themeDir = join(dir, "theme");
	await mkdir(themeDir, { recursive: true });
	for (const [name, theme] of Object.entries(piCliThemes)) {
		const target = join(themeDir, name);
		const content = `${JSON.stringify(theme, null, "\t")}\n`;
		const current = await readFile(target, "utf8").catch(() => undefined);
		if (current === content) continue;
		const temp = `${target}.${process.pid}.tmp`;
		await writeFile(temp, content);
		await rename(temp, target);
	}
}

/**
 * The directory the bundled pi CLI should treat as its package dir, or undefined to keep
 * pi's own default. Only a compiled binary needs one, and only when neither the user
 * (`PI_PACKAGE_DIR`) nor a sibling `theme/` next to the executable already provides it.
 */
export function piCliPackageDir(options: {
	compiled: boolean;
	execPath: string;
	envPackageDir: string | undefined;
	cacheDir: string;
}): string | undefined {
	if (!options.compiled || options.envPackageDir) return undefined;
	if (existsSync(join(dirname(options.execPath), "theme", "dark.json")))
		return undefined;
	const key = Bun.hash(JSON.stringify(piCliThemes)).toString(16);
	return join(options.cacheDir, `pi-cli-${key}`);
}

/**
 * pi-ui's own closed set of top-level flags (see `serverUsage`), recognized regardless of
 * where they appear relative to `isPiCliPassthrough`'s check of `args[0]` only.
 */
const piUiOwnFlags = new Set([
	"--host",
	"--port",
	"--auth-token",
	"--remote",
	"--insecure-no-auth",
	"--workspace",
	"--help",
	"-h",
	"--version",
]);

function isPiUiOwnFlag(token: string): boolean {
	if (piUiOwnFlags.has(token)) return true;
	return (
		token.startsWith("--host=") ||
		token.startsWith("--port=") ||
		token.startsWith("--auth-token=") ||
		token.startsWith("--workspace=")
	);
}

/**
 * True when `args` are plain pi CLI arguments rather than a pi-ui invocation, so
 * `server-main.ts` should run the bundled pi CLI and exit instead of parsing `args` as
 * server options.
 *
 * Extensions that spawn a child pi process re-invoke "the running pi" (see
 * `~/.pi/agent/extensions/subagents.ts` `piInvocation()`): `process.execPath` +
 * `process.argv[1]` when argv[1] is a real script, else `process.execPath` alone when it
 * isn't node/bun, else `pi` on PATH. Under pi-ui the running program is pi-ui — the
 * compiled binary or `bun src/server-main.ts` from source — so a sub-agent (or any other
 * such extension: workflows, delegate, jev, loop, advisor, btw, handoff, herdr-*) handed
 * pi-ui plain pi CLI arguments like `--mode json -p --no-session ...`. Before this, those
 * never matched anything `parseServerOptions` recognized, so every such child died
 * immediately with "unknown option: --mode" instead of running a turn.
 *
 * pi-ui recognizes only its own small, closed set of top-level forms: `service`/
 * `autostart`/`login` (subcommands), `--version`/`--help`/`-h`, and the handful of server flags in
 * `serverUsage`. Everything else — including a bare positional prompt, any pi CLI flag
 * pi-ui itself has never heard of, or a genuinely mistyped pi-ui flag — is pi CLI
 * passthrough; the bundled pi CLI has its own clean "unknown option" handling for the
 * arguments it doesn't recognize either, so pi-ui does not need to special-case every pi
 * CLI flag to keep its own recognized forms' behaviour unchanged.
 *
 * Only the process's own argv reaches this: no HTTP route or browser input can choose
 * the arguments pi-ui was started with.
 */
export function isPiCliPassthrough(args: readonly string[]): boolean {
	const [first] = args;
	if (first === undefined) return false;
	if (first === "service" || first === "autostart" || first === "login") return false;
	if (isVersionRequest(args)) return false;
	return !isPiUiOwnFlag(first);
}

/**
 * Runs the bundled pi CLI (the same `@earendil-works/pi-coding-agent` SDK version pi-ui
 * embeds for its own in-process runtime) in this process with `args`, in place of starting
 * a pi-ui server. This is what makes an extension's unmodified re-invocation of "the
 * running pi" work under pi-ui: same executable, same argv, now handled by the CLI it was
 * actually written for instead of pi-ui's own server option parser.
 */
export async function runPiCli(args: readonly string[]): Promise<void> {
	// A sub-agent child inherits the parent server's environment, including pi-ui's
	// `PI_UI_BRIDGE` host marker (extensions-config.ts). But this process is a plain pi CLI
	// run (`--mode json`/`-p`) whose stdout the parent extension reads, not a pi-ui-hosted
	// runtime, so a bridge-aware extension loaded here must take its normal non-pi-ui
	// path instead of publishing a native sheet nobody can answer.
	delete process.env[extensionsHostMarkerEnvVar];
	const packageDir = piCliPackageDir({
		compiled: isCompiledBinary(),
		execPath: process.execPath,
		envPackageDir: process.env.PI_PACKAGE_DIR,
		cacheDir: appCachePath(""),
	});
	if (packageDir) {
		await materializePiCliThemes(packageDir);
		process.env.PI_PACKAGE_DIR = packageDir;
	}
	const { main: piCliMain } = await import("@earendil-works/pi-coding-agent");
	await piCliMain([...args]);
}

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { importLoginShellEnvironment } from "./login-shell-environment.ts";
import { isRemoteMode, resolveRemoteMode, setRemoteMode } from "./remote-mode.ts";
import {
	disableServerAutostart,
	enableServerAutostart,
	serverAutostartConfig,
	type ServerAutostartOverrides,
	type ServerAutostartServiceEnvironment,
} from "./server-autostart.ts";
import {
	explicitServerOptions,
	parseServerOptions,
	serverUsage,
} from "./server-options.ts";
import { AuthRateLimiter } from "./server/auth-rate-limit.ts";
import { withAuthToken, type AuthCheckDeps } from "./server/request-auth.ts";
import { endpoints } from "./server/routes/endpoints.ts";
import { createSessionLoginRoute } from "./server/session-login-route.ts";
import { expandHomePath, setDefaultWorkspacePath } from "./utils/workspace.ts";
import { isVersionRequest, version } from "./version.ts";

// Bun decides "jsx"/"jsxImportSource" from a tsconfig.json in process.cwd() once, at
// process startup — not from this file's own directory, not by walking up parent
// directories, and not retroactively via process.chdir() once the process is already
// running (all verified empirically; a chdir() here has no effect on it). Running
// `bun src/server-main.ts` directly (bypassing the "dev" package.json script, which `bun
// run` always executes with cwd already at the repo root — also verified) from any other
// directory silently drops the JSX transform: every page.tsx element becomes a plain
// object, and the whole app renders as the literal string "<!doctype html>[object Object]"
// instead of failing loudly. The published npm package and the `bun build --compile`
// executable are pre-bundled ahead of time, so their JSX is already plain JS by the time
// this runs and neither can hit this. Detected by this file living directly in a "src"
// directory next to a tsconfig.json, true only for the raw-source entry point, never the
// built outputs — so re-exec with the right --cwd only in that one narrow, unsupported case.
if (basename(import.meta.dir) === "src") {
	const projectRoot = join(import.meta.dir, "..");
	if (existsSync(join(projectRoot, "tsconfig.json")) && process.cwd() !== projectRoot) {
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				`--cwd=${projectRoot}`,
				import.meta.path,
				...process.argv.slice(2),
			],
			stdio: ["inherit", "inherit", "inherit"],
			env: process.env,
		});
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => child.kill(signal));
		}
		process.exit(await child.exited);
	}
}

type LazyAppRoutes = (typeof import("./server/lazy-app.ts"))["routes"];

function gateRoutes(
	routes: LazyAppRoutes,
	token: string,
	deps: AuthCheckDeps,
): LazyAppRoutes {
	// SAFETY: Object.fromEntries widens back to a plain string-keyed record; this rebuilds
	// `routes` with the exact same pathname/method keys and one handler wrapped per entry,
	// so the shape is still LazyAppRoutes.
	return Object.fromEntries(
		Object.entries(routes).map(([pathname, methods]) => [
			pathname,
			Object.fromEntries(
				Object.entries(methods).map(([method, handler]) => [
					method,
					withAuthToken(handler, token, deps),
				]),
			),
		]),
	) as LazyAppRoutes;
}

const insecureNoAuthWarning =
	"\n" +
	"!".repeat(72) +
	"\n! INSECURE: pi-ui is running in remote mode with --insecure-no-auth. Anyone who\n" +
	"! can reach this server can run arbitrary commands as you — no login at all.\n" +
	"! This is almost certainly wrong outside a network you fully trust already.\n" +
	"! Remove --insecure-no-auth and pass --auth-token as soon as you can.\n" +
	"!".repeat(72);

function remoteAuthRefusalMessage(): string {
	return (
		"pi-ui refuses to start in remote mode without an auth token: that would expose " +
		"a full shell as you to the network. Pass --auth-token <token> (or set " +
		"PI_UI_AUTH_TOKEN), or explicitly accept the risk with --insecure-no-auth (or " +
		"PI_UI_INSECURE_NO_AUTH=1)."
	);
}

/**
 * Options a headless `pi-ui service install <flags>` (or `PI_UI_*` environment) resolves
 * to for the systemd `EnvironmentFile` and unit. `--headless` is consumed here, not passed
 * on to `parseServerOptions`. Only `hostname`/`port` that were explicitly requested (a
 * flag or a non-empty `PI_UI_HOST`/`PI_UI_PORT`) are persisted — `parseServerOptions`
 * always fills in the loopback defaults, and persisting those on a bare `pi-ui service
 * install` would write a new `EnvironmentFile` (and reference it from the unit) on every
 * desktop install where none existed before, changing desktop behaviour that must stay
 * exactly as today. `remote`/`authToken` are already opt-in with no default value, so no
 * such tracking is needed for them.
 *
 * A remote service (`--remote` or a non-loopback `--host`) with neither `--auth-token` nor
 * `--insecure-no-auth` is rejected here, at install time: the server itself refuses to
 * start that way, so installing it would only leave a unit that fails on every restart.
 */
export function buildServiceInstallAutostartConfig(
	rest: readonly string[],
	environment: {
		host?: string;
		port?: string;
		authToken?: string;
		remote?: string;
		insecureNoAuth?: string;
		workspace?: string;
	} = {
		host: process.env.PI_UI_HOST,
		port: process.env.PI_UI_PORT,
		authToken: process.env.PI_UI_AUTH_TOKEN,
		remote: process.env.PI_UI_REMOTE,
		insecureNoAuth: process.env.PI_UI_INSECURE_NO_AUTH,
		workspace: process.env.PI_UI_WORKSPACE,
	},
): ServerAutostartOverrides {
	const headlessIndex = rest.indexOf("--headless");
	const headless = headlessIndex !== -1;
	const filteredRest =
		headlessIndex === -1
			? rest
			: [...rest.slice(0, headlessIndex), ...rest.slice(headlessIndex + 1)];
	const options = parseServerOptions(filteredRest, environment);
	const explicit = explicitServerOptions(filteredRest, environment);
	if (resolveRemoteMode(options) && !options.authToken && !options.insecureNoAuth) {
		throw new Error(
			"pi-ui service install refuses a remote-mode service without an auth token, " +
				"since the server would refuse to start. Pass --auth-token <token> (or set " +
				"PI_UI_AUTH_TOKEN), or explicitly accept the risk with --insecure-no-auth.",
		);
	}
	const serviceEnvironment: ServerAutostartServiceEnvironment = {
		hostname: explicit.hostname ? options.hostname : undefined,
		port: explicit.port ? options.port : undefined,
		remote: options.remote,
		authToken: options.authToken,
	};
	if (options.insecureNoAuth) serviceEnvironment.insecureNoAuth = true;
	if (options.workspace) serviceEnvironment.workspace = options.workspace;
	return { headless, serviceEnvironment };
}

/**
 * SIGINT/SIGTERM handler: stop accepting connections, then dispose the app (runtimes,
 * watchers, transfer dirs). Bun's default `server.stop()` waits for in-flight requests,
 * and a connected client's `/stream` SSE never finishes on its own — so `systemctl
 * stop/restart` with a phone still connected, or a local Ctrl+C with a tab left open,
 * hung for systemd's 90 s stop timeout / indefinitely and ended in SIGKILL without
 * disposing anything. Unconditional (RM1 audit open issue 4): a real local bug too, not
 * only a remote one; connected clients simply reconnect on their own either way. Runs
 * once however many signals arrive.
 */
export function createShutdown(
	server: { stop(closeActiveConnections?: boolean): Promise<void> },
	disposeApp: () => Promise<void>,
	closeActiveConnections: boolean = true,
): () => Promise<void> {
	let stopping: Promise<void> | undefined;
	return () => {
		stopping ??= (async () => {
			await server.stop(closeActiveConnections);
			await disposeApp();
		})();
		return stopping;
	};
}

/** Reduces a thrown value to a clean one-line message for the top-level CLI catch: no Bun
 * stack trace or source frame (RM1 audit open issue 5) — `service install`/startup errors
 * (a missing --auth-token, a bad "service install|uninstall" invocation, a systemd failure)
 * are user mistakes or environment problems, not bugs to debug from a stack. */
export function formatCliError(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
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
 * True when `args` are plain pi CLI arguments rather than a pi-ui invocation, so `main()`
 * should run the bundled pi CLI and exit instead of parsing `args` as server options.
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
 * `autostart` (subcommands), `--version`/`--help`/`-h`, and the handful of server flags in
 * `serverUsage`. Everything else — including a bare positional prompt, any pi CLI flag
 * pi-ui itself has never heard of, or a genuinely mistyped pi-ui flag — is pi CLI
 * passthrough; the bundled pi CLI has its own clean "unknown option" handling for the
 * arguments it doesn't recognize either, so pi-ui does not need to special-case every pi
 * CLI flag to keep its own recognized forms' behaviour unchanged.
 */
export function isPiCliPassthrough(args: readonly string[]): boolean {
	const [first] = args;
	if (first === undefined) return false;
	if (first === "service" || first === "autostart") return false;
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
async function runPiCli(args: readonly string[]): Promise<void> {
	const { main: piCliMain } = await import("@earendil-works/pi-coding-agent");
	await piCliMain([...args]);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (isVersionRequest(args)) {
		console.log(version);
	} else if (isPiCliPassthrough(args)) {
		await runPiCli(args);
	} else if (args[0] === "service" || args[0] === "autostart") {
		const installAction = args[0] === "service" ? "install" : "enable";
		const uninstallAction = args[0] === "service" ? "uninstall" : "disable";
		const rest = args.slice(2);
		if (args[1] === installAction) {
			// On a headless Linux host (a VPS or a laptop reached over SSH, no desktop
			// session), `service install` also accepts the usual --host/--port/--remote/
			// --auth-token flags to persist for the service, plus --headless to force
			// headless detection when the installing shell happens to have a $DISPLAY.
			await enableServerAutostart(
				serverAutostartConfig(
					undefined,
					undefined,
					buildServiceInstallAutostartConfig(rest),
				),
			);
			console.log("pi-ui service installed and started");
		} else if (args[1] === uninstallAction && rest.length === 0) {
			await disableServerAutostart();
			console.log("pi-ui service stopped and uninstalled");
		} else {
			throw new Error("usage: pi-ui service install|uninstall");
		}
	} else {
		await importLoginShellEnvironment();
		const options = parseServerOptions(args, {
			host: process.env.PI_UI_HOST,
			port: process.env.PI_UI_PORT,
			authToken: process.env.PI_UI_AUTH_TOKEN,
			remote: process.env.PI_UI_REMOTE,
			insecureNoAuth: process.env.PI_UI_INSECURE_NO_AUTH,
			workspace: process.env.PI_UI_WORKSPACE,
		});
		if (options.help) {
			console.log(serverUsage);
		} else {
			setRemoteMode(resolveRemoteMode(options));
			// Before the app's first request creates its RuntimeController/AppStore (which
			// resolve the workspace lazily, on demand — see lazy-app.ts). RM1 audit open
			// issue 8.
			if (options.workspace) {
				setDefaultWorkspacePath(expandHomePath(options.workspace));
			}
			if (isRemoteMode() && !options.authToken) {
				if (options.insecureNoAuth) {
					console.warn(insecureNoAuthWarning);
				} else {
					console.error(remoteAuthRefusalMessage());
					process.exitCode = 1;
					return;
				}
			}
			const { disposeApp, fallback, routes } = await import("./server/lazy-app.ts");
			const rateLimiter = new AuthRateLimiter();
			const server = Bun.serve({
				hostname: options.hostname,
				port: options.port,
				idleTimeout: 0,
				routes: options.authToken
					? {
							...gateRoutes(routes, options.authToken, { rateLimiter }),
							[endpoints.sessionLogin]: createSessionLoginRoute(
								options.authToken,
								rateLimiter,
							),
						}
					: routes,
				fetch: options.authToken
					? withAuthToken(fallback, options.authToken, { rateLimiter })
					: fallback,
			});
			const stop = createShutdown(server, disposeApp);
			process.once("SIGINT", () => void stop());
			process.once("SIGTERM", () => void stop());
			console.log(`pi-ui listening on ${server.url}`);
		}
	}
}

// Guarded so importing this module (e.g. from server-main_test.ts, to exercise
// `buildServiceInstallAutostartConfig` through the same entry point `bun src/server-main.ts`
// uses) never starts a server or touches the real CLI argv/environment — only running it
// directly (`bun run`, `bun test` on this file itself, the compiled executable) does.
if (import.meta.main) {
	process.on("unhandledRejection", (error) => {
		console.error("Unhandled rejection", error);
	});
	process.on("uncaughtException", (error) => {
		console.error("Unhandled error", error);
	});

	main().catch((cause) => {
		console.error(formatCliError(cause));
		process.exitCode = 1;
	});
}

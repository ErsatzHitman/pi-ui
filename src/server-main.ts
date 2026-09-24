import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { importLoginShellEnvironment } from "./login-shell-environment.ts";
import { resolveRemoteMode, setRemoteMode } from "./remote-mode.ts";
import {
	disableServerAutostart,
	enableServerAutostart,
	serverAutostartConfig,
	type ServerAutostartOverrides,
} from "./server-autostart.ts";
import {
	explicitServerOptions,
	isLoopbackHostname,
	parseServerOptions,
	serverUsage,
} from "./server-options.ts";
import { withAuthToken } from "./server/request-auth.ts";
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

function gateRoutes(routes: LazyAppRoutes, token: string): LazyAppRoutes {
	// SAFETY: Object.fromEntries widens back to a plain string-keyed record; this rebuilds
	// `routes` with the exact same pathname/method keys and one handler wrapped per entry,
	// so the shape is still LazyAppRoutes.
	return Object.fromEntries(
		Object.entries(routes).map(([pathname, methods]) => [
			pathname,
			Object.fromEntries(
				Object.entries(methods).map(([method, handler]) => [
					method,
					withAuthToken(handler, token),
				]),
			),
		]),
	) as LazyAppRoutes;
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
 */
export function buildServiceInstallAutostartConfig(
	rest: readonly string[],
	environment: {
		host?: string;
		port?: string;
		authToken?: string;
		remote?: string;
	} = {
		host: process.env.PI_UI_HOST,
		port: process.env.PI_UI_PORT,
		authToken: process.env.PI_UI_AUTH_TOKEN,
		remote: process.env.PI_UI_REMOTE,
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
	return {
		headless,
		serviceEnvironment: {
			hostname: explicit.hostname ? options.hostname : undefined,
			port: explicit.port ? options.port : undefined,
			remote: options.remote,
			authToken: options.authToken,
		},
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (isVersionRequest(args)) {
		console.log(version);
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
		});
		if (options.help) {
			console.log(serverUsage);
		} else {
			setRemoteMode(resolveRemoteMode(options));
			const { disposeApp, fallback, routes } = await import("./server/lazy-app.ts");
			if (!options.authToken && !isLoopbackHostname(options.hostname)) {
				console.warn(
					`pi-ui is listening on ${options.hostname}, which is reachable from ` +
						"other devices on this network, without an auth token. Anyone who " +
						"can reach it can use it as you. Pass --auth-token <token> (or set " +
						"PI_UI_AUTH_TOKEN) to require one.",
				);
			}
			const server = Bun.serve({
				hostname: options.hostname,
				port: options.port,
				idleTimeout: 0,
				routes: options.authToken
					? gateRoutes(routes, options.authToken)
					: routes,
				fetch: options.authToken
					? withAuthToken(fallback, options.authToken)
					: fallback,
			});
			let stopping = false;
			const stop = async () => {
				if (stopping) return;
				stopping = true;
				await server.stop();
				await disposeApp();
			};
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
		console.error(cause);
		process.exitCode = 1;
	});
}

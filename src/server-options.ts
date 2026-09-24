export const defaultServerHostname = "127.0.0.1";
export const defaultServerPort = 31415;
const loopbackHostnames = new Set(["127.0.0.1", "::1", "localhost"]);

export type ServerOptions = {
	hostname: string;
	port: number;
	help: boolean;
	/**
	 * Bearer token gating every request (see request-auth.ts), opt-in via `--auth-token`
	 * / `PI_UI_AUTH_TOKEN`. Absent by default, including on loopback, so a bare `pi-ui`
	 * keeps working exactly as before.
	 */
	authToken?: string;
	/**
	 * Serve clients on other machines (see remote-mode.ts), opt-in via `--remote` /
	 * `PI_UI_REMOTE=1`. Present only when enabled.
	 */
	remote?: true;
	/**
	 * Escape hatch that lets remote mode start without `authToken` (server-main.ts
	 * otherwise refuses to start), opt-in via `--insecure-no-auth` /
	 * `PI_UI_INSECURE_NO_AUTH=1`. Present only when enabled.
	 */
	insecureNoAuth?: true;
};

export type ServerEnvironment = {
	host?: string;
	port?: string;
	authToken?: string;
	remote?: string;
	insecureNoAuth?: string;
};

/**
 * Which of `hostname`/`port` on a parsed {@link ServerOptions} came from an explicit
 * `--host`/`--port` flag or a non-empty `PI_UI_HOST`/`PI_UI_PORT` environment variable, as
 * opposed to `parseServerOptions`'s built-in loopback defaults. A caller that persists
 * options (e.g. `pi-ui service install`'s systemd `EnvironmentFile`) needs this to avoid
 * writing out defaults nobody asked to persist — see `explicitServerOptions`.
 */
export type ServerOptionsExplicit = {
	hostname: boolean;
	port: boolean;
};

type ParsedServerOptions = {
	options: ServerOptions;
	explicit: ServerOptionsExplicit;
};

/** A non-loopback hostname reaches every device on the LAN — see request-auth.ts. */
export function isLoopbackHostname(hostname: string): boolean {
	return loopbackHostnames.has(hostname.toLowerCase());
}

export function parseServerOptions(
	args: readonly string[],
	environment: ServerEnvironment = {},
): ServerOptions {
	return parseServerOptionsCore(args, environment).options;
}

/**
 * Reports whether `hostname`/`port` in the result of `parseServerOptions(args,
 * environment)` were explicitly requested (flag or environment variable) rather than
 * filled in from the default. Always parses the same `args`/`environment` a caller passes
 * to `parseServerOptions` so the two stay in agreement.
 */
export function explicitServerOptions(
	args: readonly string[],
	environment: ServerEnvironment = {},
): ServerOptionsExplicit {
	return parseServerOptionsCore(args, environment).explicit;
}

function parseServerOptionsCore(
	args: readonly string[],
	environment: ServerEnvironment,
): ParsedServerOptions {
	let hostname = defaultServerHostname;
	let explicitHostname = false;
	if (environment.host !== undefined) {
		hostname = parseHostname(environment.host, "PI_UI_HOST");
		explicitHostname = true;
	}
	let port = defaultServerPort;
	let explicitPort = false;
	if (environment.port !== undefined) {
		port = parsePort(environment.port, "PI_UI_PORT");
		explicitPort = true;
	}
	let help = false;
	let authToken = nonEmpty(environment.authToken);
	let remote = parseBooleanEnvironment(environment.remote);
	let insecureNoAuth = parseBooleanEnvironment(environment.insecureNoAuth);

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (argument === "--host") {
			hostname = parseHostname(args[++index], argument);
			explicitHostname = true;
			continue;
		}
		if (argument.startsWith("--host=")) {
			hostname = parseHostname(argument.slice("--host=".length), "--host");
			explicitHostname = true;
			continue;
		}
		if (argument === "--port") {
			port = parsePort(args[++index], argument);
			explicitPort = true;
			continue;
		}
		if (argument.startsWith("--port=")) {
			port = parsePort(argument.slice("--port=".length), "--port");
			explicitPort = true;
			continue;
		}
		if (argument === "--remote") {
			remote = true;
			continue;
		}
		if (argument === "--insecure-no-auth") {
			insecureNoAuth = true;
			continue;
		}
		if (argument === "--auth-token") {
			authToken = parseAuthToken(args[++index], argument);
			continue;
		}
		if (argument.startsWith("--auth-token=")) {
			authToken = parseAuthToken(
				argument.slice("--auth-token=".length),
				"--auth-token",
			);
			continue;
		}
		throw new Error(`unknown option: ${argument}`);
	}

	const options: ServerOptions = { hostname, port, help };
	if (authToken) options.authToken = authToken;
	if (remote) options.remote = true;
	if (insecureNoAuth) options.insecureNoAuth = true;
	return {
		options,
		explicit: { hostname: explicitHostname, port: explicitPort },
	};
}

export const serverUsage = `usage: pi-ui [options]
       pi-ui service install|uninstall

options:
      --host <hostname>     listen hostname (default: ${defaultServerHostname}; env: PI_UI_HOST)
      --port <port>         listen port (default: ${defaultServerPort}; env: PI_UI_PORT)
      --auth-token <token>  require this bearer token on every request (env: PI_UI_AUTH_TOKEN).
                            Strongly recommended with --host set to anything other than
                            127.0.0.1/::1/localhost, since that exposes pi-ui to your whole
                            LAN. Open http://<host>:<port>/?token=<token> once per browser;
                            pi-ui remembers it in a cookie after that.
      --remote              serve clients on other machines, e.g. behind a TLS reverse
                            proxy on this host (env: PI_UI_REMOTE=1). Implied by any
                            --host other than 127.0.0.1/::1/localhost.
      --insecure-no-auth    let remote mode start without --auth-token (env:
                            PI_UI_INSECURE_NO_AUTH=1). Anyone who can reach the server gets
                            a full shell as you, with no login. Only for a network you
                            already fully trust.
      --version             show the version
  -h, --help                show this help`;

function parseHostname(value: string | undefined, source: string): string {
	const hostname = value?.trim();
	if (!hostname) throw new Error(`${source} requires a non-empty hostname`);
	return hostname;
}

function parseAuthToken(value: string | undefined, source: string): string {
	const token = value?.trim();
	if (!token) throw new Error(`${source} requires a non-empty token`);
	return token;
}

function parseBooleanEnvironment(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parsePort(value: string | undefined, source: string): number {
	if (!value || !/^\d+$/.test(value)) {
		throw new Error(`${source} must be an integer from 1 to 65535`);
	}
	const port = Number(value);
	if (port < 1 || port > 65535) {
		throw new Error(`${source} must be an integer from 1 to 65535`);
	}
	return port;
}

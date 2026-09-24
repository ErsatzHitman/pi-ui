import { isLoopbackHostname, type ServerOptions } from "./server-options.ts";

let remoteMode = false;

/**
 * Remote mode means the browsers and apps using pi-ui run on other machines than the
 * server (a VPS, a home server, another laptop). Host-desktop side effects — opening a
 * browser or a file on the server, OS notifications — reach nobody there, so features
 * that rely on them check `isRemoteMode()` and hand the action to the client instead.
 * Enabled by `--remote` / `PI_UI_REMOTE=1`, or implied by any non-loopback `--host`.
 */
export function resolveRemoteMode(
	options: Pick<ServerOptions, "hostname" | "remote">,
): boolean {
	return options.remote === true || !isLoopbackHostname(options.hostname);
}

export function setRemoteMode(enabled: boolean): void {
	remoteMode = enabled;
}

export function isRemoteMode(): boolean {
	return remoteMode;
}

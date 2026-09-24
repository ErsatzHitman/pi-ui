import os from "node:os";

let configuredDefaultWorkspacePath: string | undefined;

/**
 * Overrides `defaultWorkspacePath()`'s fallback, from `--workspace` / `PI_UI_WORKSPACE`
 * (`server-main.ts`) — set once, before the app creates its first `RuntimeController`/
 * `AppStore`. `undefined` restores the normal home-directory default. Without this, a
 * headless service's workspace is always the service user's home directory (systemd
 * ignores the unit's `WorkingDirectory` here), which can browse more than intended — see
 * `docs/remote.md` and RM1 audit open issue 8.
 */
export function setDefaultWorkspacePath(path: string | undefined): void {
	configuredDefaultWorkspacePath = path;
}

export function defaultWorkspacePath(): string {
	return configuredDefaultWorkspacePath || os.homedir() || process.cwd();
}

export function expandHomePath(path: string): string {
	const home = os.homedir();
	if (!home || (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\"))) {
		return path;
	}
	if (path === "~") return home;
	return `${home}${path.slice(1)}`;
}

export function formatHomePath(path: string): string {
	const home = os.homedir();
	if (!home) return path;
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
	if (path.startsWith(`${home}\\`)) return `~\\${path.slice(home.length + 1)}`;
	return path;
}

export function workspaceDisplayName(path: string): string {
	const display = formatHomePath(path).replaceAll("\\", "/");
	if (display === "~") return display;
	return display.split("/").filter(Boolean).at(-1) ?? display;
}

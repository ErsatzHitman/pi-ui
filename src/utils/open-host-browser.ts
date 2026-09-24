import { openBrowser } from "../../node_modules/@earendil-works/pi-coding-agent/dist/utils/open-browser.js";
import { isRemoteMode } from "../remote-mode.ts";

/**
 * Opens a URL or path in the server host's default browser/file handler.
 *
 * In remote mode the server runs on a machine nobody is looking at, so this
 * is a no-op: opening something there would affect the operator's desktop
 * (or nothing at all, headless), never the connected client. Callers that
 * rely on this for user-visible behaviour (auth links, file previews) must
 * already show the same information in the UI so remote clients aren't left
 * without a way to act on it.
 */
export function openHostBrowser(target: string): void {
	if (isRemoteMode()) return;
	openBrowser(target);
}

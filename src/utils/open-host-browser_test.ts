import { afterEach, mock, test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { setRemoteMode } from "../remote-mode.ts";

const openBrowserSpecifier =
	"../../node_modules/@earendil-works/pi-coding-agent/dist/utils/open-browser.js";

afterEach(() => setRemoteMode(false));

test("opens the target on the host when not in remote mode", async () => {
	const opened: string[] = [];
	mock.module(openBrowserSpecifier, () => ({
		openBrowser: (target: string) => {
			opened.push(target);
		},
	}));
	const { openHostBrowser } = await import("./open-host-browser.ts");
	openHostBrowser("https://example.com/login");
	assertEquals(opened, ["https://example.com/login"]);
});

test("does not open anything on the host in remote mode", async () => {
	const opened: string[] = [];
	mock.module(openBrowserSpecifier, () => ({
		openBrowser: (target: string) => {
			opened.push(target);
		},
	}));
	setRemoteMode(true);
	const { openHostBrowser } = await import("./open-host-browser.ts");
	openHostBrowser("https://example.com/login");
	assertEquals(opened, []);
});

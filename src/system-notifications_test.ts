import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { setRemoteMode } from "./remote-mode.ts";
import { shouldSendSystemNotification } from "./system-notifications.ts";

test("system notify-send only runs on Linux in local mode", () => {
	setRemoteMode(false);
	try {
		assertEquals(shouldSendSystemNotification("linux"), true);
		assertEquals(shouldSendSystemNotification("darwin"), false);
		assertEquals(shouldSendSystemNotification("win32"), false);
	} finally {
		setRemoteMode(false);
	}
});

test("system notify-send is skipped in remote mode even on Linux", () => {
	setRemoteMode(true);
	try {
		assertEquals(shouldSendSystemNotification("linux"), false);
	} finally {
		setRemoteMode(false);
	}
});

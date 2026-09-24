import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { createSessionNotifier } from "./notifications.js";

type NotificationInit = { body?: string; tag?: string; icon?: string };
type NotificationHandle = { onclick?: () => void; close: () => void };
type CreatedNotification = { title: string; options: NotificationInit };

type NotifierOptions = {
	isOptedIn: () => boolean;
	getPermission: () => string;
	isHidden: () => boolean;
	hasFocus: () => boolean;
	createNotification: (
		title: string,
		options: NotificationInit,
	) => NotificationHandle | undefined;
	focusWindow: () => void;
};

function harness(overrides: Partial<NotifierOptions> = {}) {
	const created: CreatedNotification[] = [];
	const focusCalls: number[] = [];
	let optedIn = false;
	let permission = "default";
	const base: NotifierOptions = {
		isOptedIn: () => optedIn,
		getPermission: () => permission,
		isHidden: () => true,
		hasFocus: () => false,
		createNotification: (title, notificationOptions) => {
			created.push({ title, options: notificationOptions });
			return { close: () => {} };
		},
		focusWindow: () => {
			focusCalls.push(1);
		},
	};
	const notifier = createSessionNotifier({ ...base, ...overrides });
	return {
		notifier,
		created,
		focusCalls,
		setOptedIn: (value: boolean) => (optedIn = value),
		setPermission: (value: string) => (permission = value),
	};
}

test("shows a notification when opted in, permitted, and the tab is hidden", () => {
	const h = harness();
	h.setOptedIn(true);
	h.setPermission("granted");

	const shown = h.notifier.sessionFinished({
		id: 1,
		workspace: "/workspace",
		sessionPath: "/sessions/a.jsonl",
	});

	assertEquals(shown, true);
	assertEquals(h.created.length, 1);
	assertEquals(h.created[0]?.title, "Background session finished");
	assertEquals(h.created[0]?.options.body, "/workspace");
	assertEquals(h.created[0]?.options.tag, "/sessions/a.jsonl");
	assertEquals(h.created[0]?.options.icon, "/notification-icon.png");
});

test("does not notify a tab that is visible and focused (the user is already watching it)", () => {
	const h = harness({ isHidden: () => false, hasFocus: () => true });
	h.setOptedIn(true);
	h.setPermission("granted");

	const shown = h.notifier.sessionFinished({ id: 1, workspace: "/workspace" });

	assertEquals(shown, false);
	assertEquals(h.created.length, 0);
});

test("notifies a visible but unfocused tab (window lost focus, e.g. another app is active)", () => {
	const h = harness({ isHidden: () => false, hasFocus: () => false });
	h.setOptedIn(true);
	h.setPermission("granted");

	assertEquals(h.notifier.sessionFinished({ id: 1, workspace: "/workspace" }), true);
});

test("does not notify when the viewer never opted in via the Live Workspace toggle", () => {
	const h = harness();
	h.setPermission("granted");

	assertEquals(h.notifier.sessionFinished({ id: 1, workspace: "/workspace" }), false);
	assertEquals(h.created.length, 0);
});

test("does not notify without granted browser permission", () => {
	const h = harness();
	h.setOptedIn(true);
	h.setPermission("default");

	assertEquals(h.notifier.sessionFinished({ id: 1, workspace: "/workspace" }), false);
	assertEquals(h.created.length, 0);
});

test("ignores a repeated or out-of-order id so the same event isn't shown twice", () => {
	const h = harness();
	h.setOptedIn(true);
	h.setPermission("granted");

	assertEquals(h.notifier.sessionFinished({ id: 5, workspace: "/workspace" }), true);
	assertEquals(h.notifier.sessionFinished({ id: 5, workspace: "/workspace" }), false);
	assertEquals(h.notifier.sessionFinished({ id: 3, workspace: "/workspace" }), false);
	assertEquals(h.created.length, 1);
});

test("clicking the notification focuses the tab and closes it", () => {
	let closed = false;
	const handle: NotificationHandle = {
		close: () => {
			closed = true;
		},
	};
	const h = harness({ createNotification: () => handle });
	h.setOptedIn(true);
	h.setPermission("granted");

	h.notifier.sessionFinished({ id: 1, workspace: "/workspace" });
	handle.onclick?.();

	assertEquals(h.focusCalls.length, 1);
	assertEquals(closed, true);
});

test("falls back to the workspace path as the notification tag when no session path is known", () => {
	const h = harness();
	h.setOptedIn(true);
	h.setPermission("granted");

	h.notifier.sessionFinished({ id: 1, workspace: "/workspace" });

	assertEquals(h.created[0]?.options.tag, "/workspace");
});

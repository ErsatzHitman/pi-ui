import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	needsNotificationPermission,
	requestNotificationPermission,
} from "./notification-permission.ts";

/** Patches a global via `Object.defineProperty` (see live-workspace-open_test.ts). */
function patchGlobal(name: string, value: unknown): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
	return () => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	};
}

test("resolves immediately without calling requestPermission when Notification doesn't exist", async () => {
	const restore = patchGlobal("Notification", undefined);
	try {
		await requestNotificationPermission();
	} finally {
		restore();
	}
});

test("resolves immediately without prompting again when permission is already granted", async () => {
	let calls = 0;
	const restore = patchGlobal("Notification", {
		permission: "granted",
		requestPermission: async () => {
			calls += 1;
			return "granted";
		},
	});
	try {
		await requestNotificationPermission();
		assertEquals(calls, 0);
	} finally {
		restore();
	}
});

test("resolves immediately without prompting again when permission is already denied", async () => {
	let calls = 0;
	const restore = patchGlobal("Notification", {
		permission: "denied",
		requestPermission: async () => {
			calls += 1;
			return "denied";
		},
	});
	try {
		await requestNotificationPermission();
		assertEquals(calls, 0);
	} finally {
		restore();
	}
});

test("awaits the real prompt when permission is still default, then resolves (the RM2 fix)", async () => {
	// This is the exact primary-path regression: the returned promise must not resolve until
	// Notification.requestPermission()'s user-gesture-gated prompt actually settles, so a caller
	// that awaits it (the notifications toggle's click handler) sees the decision before it acts.
	let resolvePrompt!: (value: NotificationPermission) => void;
	const prompt = new Promise<NotificationPermission>((resolve) => {
		resolvePrompt = resolve;
	});
	let calls = 0;
	const restore = patchGlobal("Notification", {
		permission: "default",
		requestPermission: () => {
			calls += 1;
			return prompt;
		},
	});
	try {
		let settled = false;
		const result = requestNotificationPermission().then(() => {
			settled = true;
		});
		// Still pending: the prompt hasn't resolved yet.
		await Promise.resolve();
		await Promise.resolve();
		assertEquals(settled, false);
		assertEquals(calls, 1);

		resolvePrompt("granted");
		await result;
		assertEquals(settled, true);
	} finally {
		restore();
	}
});

test("needsNotificationPermission is true only while this browser hasn't answered yet", () => {
	for (const [permission, expected] of [
		["default", true],
		["granted", false],
		["denied", false],
	] as const) {
		const restore = patchGlobal("Notification", { permission });
		try {
			assertEquals(needsNotificationPermission(), expected);
		} finally {
			restore();
		}
	}
	const restore = patchGlobal("Notification", undefined);
	try {
		assertEquals(needsNotificationPermission(), false);
	} finally {
		restore();
	}
});

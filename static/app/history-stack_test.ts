import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	createDismissibleHistoryGuard,
	registerDismissibleSurface,
} from "./history-stack.js";

test("opening a dismissible surface pushes one history entry", () => {
	const pushed: unknown[] = [];
	const guard = createDismissibleHistoryGuard({
		pushState: (state: unknown) => pushed.push(state),
		back: () => {
			throw new Error("must not be called");
		},
	});
	guard.notifyOpen();
	assertEquals(pushed.length, 1);
});

test("closing a surface normally (Cancel/Escape/backdrop) pops its history entry", () => {
	let backCalls = 0;
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		back: () => (backCalls += 1),
	});
	guard.notifyOpen();
	guard.notifyClose();
	assertEquals(backCalls, 1);
});

test("a real back-button press closes the top-most surface without a double pop", () => {
	let backCalls = 0;
	let closed = 0;
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		back: () => (backCalls += 1),
	});
	guard.notifyOpen();

	// The back button already consumed the history entry natively; our handler
	// only needs to close the DOM surface, not pop history again.
	guard.handlePopstate(
		() => true,
		() => (closed += 1),
	);
	assertEquals(closed, 1);
	assertEquals(backCalls, 0);

	// The `toggle` "closed" event that `dialog.close()` fires synchronously
	// during that same handlePopstate call must be suppressed too.
	guard.notifyClose();
	assertEquals(backCalls, 0);
});

test("popstate with nothing open is a no-op", () => {
	let closed = 0;
	const guard = createDismissibleHistoryGuard({ pushState: () => {}, back: () => {} });
	guard.handlePopstate(
		() => false,
		() => (closed += 1),
	);
	assertEquals(closed, 0);
});

test("registering and unregistering a non-dialog dismissible surface never throws (A#17)", () => {
	const unregister = registerDismissibleSurface({
		isOpen: () => false,
		close: () => {},
	});
	unregister();
	// Unregistering twice must stay a no-op, not throw.
	unregister();
});

test("a later independent close is handled normally again after the popstate settles", async () => {
	let backCalls = 0;
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		back: () => (backCalls += 1),
	});
	guard.notifyOpen();
	guard.handlePopstate(
		() => true,
		() => {},
	);
	guard.notifyClose();
	assertEquals(backCalls, 0);

	// pendingPop is released on the next microtask, matching the synchronous
	// `toggle` event a real `dialog.close()` call fires within handlePopstate.
	await Promise.resolve();
	guard.notifyOpen();
	guard.notifyClose();
	assertEquals(backCalls, 1);
});

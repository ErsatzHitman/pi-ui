import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	bindDismissibleHistory,
	createDismissibleHistoryGuard,
	notifyExternalSurfaceClose,
	notifyExternalSurfaceOpen,
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

	// A close reported after that (e.g. the dialog's asynchronous `toggle` event) has no
	// pushed entry left to pop, so it must not navigate back past pi-ui's own history.
	guard.notifyClose();
	assertEquals(backCalls, 0);
});

test("the popstate caused by the guard's own back() does not close another surface", () => {
	let closed = 0;
	const guard = createDismissibleHistoryGuard({ pushState: () => {}, back: () => {} });
	guard.notifyOpen();
	guard.notifyOpen();
	guard.notifyClose();
	guard.handlePopstate(
		() => true,
		() => (closed += 1),
	);
	assertEquals(closed, 0);
	// A genuine back press afterwards still closes the remaining surface.
	guard.handlePopstate(
		() => true,
		() => (closed += 1),
	);
	assertEquals(closed, 1);
});

test("a close with no pushed entry never navigates back", () => {
	let backCalls = 0;
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		back: () => (backCalls += 1),
	});
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

test("a later independent close is handled normally again after a back press", () => {
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
	assertEquals(backCalls, 0);

	guard.notifyOpen();
	guard.notifyClose();
	assertEquals(backCalls, 1);
});

test("non-dialog surfaces report open/close through the bound guard (A#17)", () => {
	let pushes = 0;
	let backs = 0;
	const guard = createDismissibleHistoryGuard({
		pushState: () => (pushes += 1),
		back: () => (backs += 1),
	});
	const target = { addEventListener: () => {} };
	bindDismissibleHistory(guard, target, target);
	notifyExternalSurfaceOpen();
	assertEquals(pushes, 1);
	notifyExternalSurfaceClose();
	assertEquals(backs, 1);
});

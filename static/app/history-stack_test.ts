import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	bindDismissibleHistory,
	createDismissibleHistoryGuard,
	notifyExternalSurfaceClose,
	notifyExternalSurfaceOpen,
	registerDismissibleSurface,
} from "./history-stack.js";

/** A close pops its entry one task later (so a same-handoff open can reuse it). */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test("closing a surface normally (Cancel/Escape/backdrop) pops its history entry", async () => {
	let backCalls = 0;
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		back: () => (backCalls += 1),
	});
	guard.notifyOpen();
	guard.notifyClose();
	await nextTask();
	assertEquals(backCalls, 1);
});

test("a real back-button press closes the top-most surface without a double pop", async () => {
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
	await nextTask();
	assertEquals(backCalls, 0);
});

test("the popstate caused by the guard's own back() does not close another surface", async () => {
	let closed = 0;
	const guard = createDismissibleHistoryGuard({ pushState: () => {}, back: () => {} });
	guard.notifyOpen();
	guard.notifyOpen();
	guard.notifyClose();
	await nextTask();
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

test("a close with no pushed entry never navigates back", async () => {
	let backCalls = 0;
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		back: () => (backCalls += 1),
	});
	guard.notifyClose();
	await nextTask();
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

test("a later independent close is handled normally again after a back press", async () => {
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
	await nextTask();
	assertEquals(backCalls, 1);
});

test("non-dialog surfaces report open/close through the bound guard (A#17)", async () => {
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
	await nextTask();
	assertEquals(backs, 1);
});

/** A minimal `HTMLDialogElement`-shaped stub for the toggle/MutationObserver bind layer (m14). */
class FakeDialog {
	open = false;
	isConnected = true;
	close: () => void = () => {
		this.open = false;
	};
	#modal: boolean;
	constructor(modal = true) {
		this.#modal = modal;
	}
	matches(selector: string): boolean {
		return selector === ":modal" && this.#modal;
	}
}

/** A capturing `addEventListener` fake that records handlers by event type. */
function fakeTarget() {
	const handlers = new Map<string, Array<(event: unknown) => void>>();
	return {
		body: undefined as { isConnected: boolean } | undefined,
		addEventListener(type: string, handler: (event: unknown) => void) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		dispatch(type: string, event: unknown) {
			for (const handler of handlers.get(type) ?? []) handler(event);
		},
	};
}

test("bindDismissibleHistory pushes an entry when a modal dialog opens and pops it on close (m14)", async () => {
	const originalDialog = (globalThis as { HTMLDialogElement?: unknown })
		.HTMLDialogElement;
	(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement = FakeDialog;
	try {
		let pushes = 0;
		let backs = 0;
		const guard = createDismissibleHistoryGuard({
			pushState: () => (pushes += 1),
			back: () => (backs += 1),
		});
		const documentTarget = fakeTarget();
		const windowTarget = fakeTarget();
		bindDismissibleHistory(guard, documentTarget, windowTarget);

		const dialog = new FakeDialog(true);
		documentTarget.dispatch("toggle", { target: dialog, newState: "open" });
		assertEquals(pushes, 1);

		documentTarget.dispatch("toggle", { target: dialog, newState: "closed" });
		await nextTask();
		assertEquals(backs, 1);
	} finally {
		(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement =
			originalDialog;
	}
});

test("bindDismissibleHistory ignores a non-modal dialog's toggle (the docked session sidebar; m14)", () => {
	const originalDialog = (globalThis as { HTMLDialogElement?: unknown })
		.HTMLDialogElement;
	(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement = FakeDialog;
	try {
		let pushes = 0;
		const guard = createDismissibleHistoryGuard({
			pushState: () => (pushes += 1),
			back: () => {},
		});
		const documentTarget = fakeTarget();
		const windowTarget = fakeTarget();
		bindDismissibleHistory(guard, documentTarget, windowTarget);

		documentTarget.dispatch("toggle", {
			target: new FakeDialog(false),
			newState: "open",
		});
		assertEquals(pushes, 0);
	} finally {
		(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement =
			originalDialog;
	}
});

test("bindDismissibleHistory closes the top-most tracked dialog on a real popstate (m14)", async () => {
	const originalDialog = (globalThis as { HTMLDialogElement?: unknown })
		.HTMLDialogElement;
	(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement = FakeDialog;
	try {
		let backs = 0;
		let closed = 0;
		const guard = createDismissibleHistoryGuard({
			pushState: () => {},
			back: () => (backs += 1),
		});
		const documentTarget = fakeTarget();
		const windowTarget = fakeTarget();
		bindDismissibleHistory(guard, documentTarget, windowTarget);

		const dialog = new FakeDialog(true);
		dialog.open = true;
		dialog.close = () => {
			closed += 1;
			dialog.open = false;
			documentTarget.dispatch("toggle", { target: dialog, newState: "closed" });
		};
		documentTarget.dispatch("toggle", { target: dialog, newState: "open" });

		windowTarget.dispatch("popstate", {});
		assertEquals(closed, 1);
		// The dialog's own close() re-dispatched `toggle`, but the bind layer had already
		// untracked it before calling close(), so that toggle must not pop a second entry.
		await nextTask();
		assertEquals(backs, 0);
	} finally {
		(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement =
			originalDialog;
	}
});

test("bindDismissibleHistory pops an orphaned dialog's entry once it leaves the DOM (m14)", async () => {
	const originalDialog = (globalThis as { HTMLDialogElement?: unknown })
		.HTMLDialogElement;
	const originalObserver = (globalThis as { MutationObserver?: unknown })
		.MutationObserver;
	(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement = FakeDialog;
	let observerCallback: (() => void) | undefined;
	(globalThis as { MutationObserver?: unknown }).MutationObserver = class {
		constructor(callback: () => void) {
			observerCallback = callback;
		}
		observe() {}
		disconnect() {}
	};
	try {
		let backs = 0;
		const guard = createDismissibleHistoryGuard({
			pushState: () => {},
			back: () => (backs += 1),
		});
		const documentTarget = fakeTarget();
		documentTarget.body = { isConnected: true };
		const windowTarget = fakeTarget();
		bindDismissibleHistory(guard, documentTarget, windowTarget);

		const dialog = new FakeDialog(true);
		documentTarget.dispatch("toggle", { target: dialog, newState: "open" });
		assertEquals(backs, 0);

		// The element was removed from the DOM (a PIUI sheet the extension retired) without
		// ever firing `toggle`; the MutationObserver layer must still pop its entry.
		dialog.isConnected = false;
		observerCallback?.();
		await nextTask();
		assertEquals(backs, 1);
	} finally {
		(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement =
			originalDialog;
		(globalThis as { MutationObserver?: unknown }).MutationObserver =
			originalObserver;
	}
});

test("a close and an open in one handoff reuse the entry instead of back + push (F1)", async () => {
	let pushes = 0;
	let replaces = 0;
	const steps: number[] = [];
	const guard = createDismissibleHistoryGuard({
		pushState: () => (pushes += 1),
		replaceState: () => (replaces += 1),
		back: (n = 1) => steps.push(n),
	});
	guard.notifyOpen(); // the command palette
	guard.notifyClose(); // closes...
	guard.notifyOpen(); // ...and the font picker opens in the same turn
	await nextTask();
	assertEquals(pushes, 1);
	assertEquals(replaces, 1);
	assertEquals(steps, []);
	// Depth is unchanged: closing the picker pops exactly the one entry left.
	guard.notifyClose();
	await nextTask();
	assertEquals(steps, [1]);
});

test("an older surface closing under a newer one never navigates back (F1/F2 handoff)", async () => {
	const steps: number[] = [];
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		replaceState: () => {},
		back: (n = 1) => steps.push(n),
	});
	guard.notifyOpen(); // the command palette
	guard.notifyOpen(); // the server-opened auth dialog
	guard.notifyClose({ topmost: false }); // the palette closes underneath it
	await nextTask();
	assertEquals(steps, []);
	// Closing the auth dialog drops its entry and the palette's surplus one together.
	guard.notifyClose();
	await nextTask();
	assertEquals(steps, [2]);
});

test("a back press after an older surface closed underneath also drops its surplus entry", async () => {
	const steps: number[] = [];
	let closed = 0;
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		replaceState: () => {},
		back: (n = 1) => steps.push(n),
	});
	guard.notifyOpen();
	guard.notifyOpen();
	guard.notifyClose({ topmost: false });
	guard.handlePopstate(
		() => true,
		() => (closed += 1),
	);
	await nextTask();
	assertEquals(closed, 1);
	assertEquals(steps, [1]);
	// The guard's own pop is not mistaken for another back press.
	guard.handlePopstate(
		() => true,
		() => (closed += 1),
	);
	assertEquals(closed, 1);
});

test("a normal close still pops exactly one entry", async () => {
	const steps: number[] = [];
	const guard = createDismissibleHistoryGuard({
		pushState: () => {},
		replaceState: () => {
			throw new Error("must not be called");
		},
		back: (n = 1) => steps.push(n),
	});
	guard.notifyOpen();
	guard.notifyClose();
	await nextTask();
	assertEquals(steps, [1]);
});

test("bindDismissibleHistory reports a dialog closing under a newer one as not top-most", async () => {
	const originalDialog = (globalThis as { HTMLDialogElement?: unknown })
		.HTMLDialogElement;
	(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement = FakeDialog;
	try {
		const steps: number[] = [];
		const guard = createDismissibleHistoryGuard({
			pushState: () => {},
			replaceState: () => {},
			back: (n = 1) => steps.push(n),
		});
		const documentTarget = fakeTarget();
		bindDismissibleHistory(guard, documentTarget, fakeTarget());

		const palette = new FakeDialog(true);
		const auth = new FakeDialog(true);
		palette.open = true;
		documentTarget.dispatch("toggle", { target: palette, newState: "open" });
		auth.open = true;
		documentTarget.dispatch("toggle", { target: auth, newState: "open" });
		palette.open = false;
		documentTarget.dispatch("toggle", { target: palette, newState: "closed" });
		await nextTask();
		assertEquals(steps, []);

		auth.open = false;
		documentTarget.dispatch("toggle", { target: auth, newState: "closed" });
		await nextTask();
		assertEquals(steps, [2]);
	} finally {
		(globalThis as { HTMLDialogElement?: unknown }).HTMLDialogElement =
			originalDialog;
	}
});

test("a surface opening while the guard's own back() is in flight pushes after its popstate (F1)", async () => {
	const log: string[] = [];
	const guard = createDismissibleHistoryGuard({
		pushState: () => log.push("push"),
		replaceState: () => log.push("replace"),
		back: (n = 1) => log.push(`back ${n}`),
	});
	guard.notifyOpen(); // the command palette
	guard.notifyClose(); // closes; its back() runs one task later...
	await nextTask();
	guard.notifyOpen(); // ...and the auth dialog opens before that traversal's popstate
	assertEquals(log, ["push", "back 1"]);
	guard.handlePopstate(
		() => true,
		() => log.push("closed"),
	);
	// The guard's own popstate: nothing closes, and the deferred entry is pushed only now.
	assertEquals(log, ["push", "back 1", "push"]);
	guard.notifyClose();
	await nextTask();
	assertEquals(log, ["push", "back 1", "push", "back 1"]);
});

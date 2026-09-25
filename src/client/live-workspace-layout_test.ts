import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { dockedLiveQuery, isDockedLayout } from "./live-workspace-layout.ts";

/**
 * Patches a global via `Object.defineProperty` (not plain assignment): another test file
 * (`file-transfer_test.ts`) leaves a `configurable: true, writable: false` global on
 * `globalThis` for the rest of the process, which a plain assignment would throw against.
 * Restores whatever was there before, the same pattern `file-transfer_test.ts`'s own
 * `restoreGlobal` uses.
 */
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

/** A `matchMedia` that answers the docked query for a viewport of `viewportRem` rem. */
function withViewport<T>(
	viewportRem: number | undefined,
	run: (queries: string[]) => T,
): T {
	const queries: string[] = [];
	const restore = patchGlobal(
		"matchMedia",
		viewportRem === undefined
			? undefined
			: (query: string) => {
					queries.push(query);
					return { matches: query === dockedLiveQuery && viewportRem >= 64 };
				},
	);
	try {
		return run(queries);
	} finally {
		restore();
	}
}

test("isDockedLayout asks the same media query the CSS docks under (flow-critique #12a)", () => {
	assertEquals(dockedLiveQuery, "(width >= 64rem)");
	withViewport(64, (queries) => {
		assertEquals(isDockedLayout(), true);
		assertEquals(queries, [dockedLiveQuery]);
	});
});

test("isDockedLayout reports the overlay layout (drawer/sheet) below the breakpoint", () => {
	withViewport(63.9, () => assertEquals(isDockedLayout(), false));
});

test("isDockedLayout defaults to the overlay layout without matchMedia", () => {
	withViewport(undefined, () => assertEquals(isDockedLayout(), false));
});

import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { resolveActivePane } from "./model-picker.js";

test("resolveActivePane lands on the models pane with a single provider and no current model", () => {
	// Bug (fix pass 1, item 6): `renderModelPicker` skips the whole providers pane when
	// there's only one provider, so it renders no `[role="menuitem"][data-provider]` rows.
	// The old `hasCurrent ? "models" : "providers"` still chose "providers" whenever nothing
	// was selected yet, landing `reset()` on a pane with no rows to activate — a bare Enter
	// did nothing.
	assertEquals(resolveActivePane(false, false), "models");
});

test("resolveActivePane still opens on providers when nothing is current and a providers pane exists", () => {
	assertEquals(resolveActivePane(false, true), "providers");
});

test("resolveActivePane opens on models whenever something is already current, single or multi-provider", () => {
	assertEquals(resolveActivePane(true, true), "models");
	assertEquals(resolveActivePane(true, false), "models");
});

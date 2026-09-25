import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { drillIn, resolveActivePane } from "./model-picker.js";

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

/** A `.model-command` stub with one pane that records its WAAPI calls, plus `matchMedia`. */
function installDrill(options: { phone: boolean; searching?: boolean }) {
	class FakeHTMLElement {}
	const calls: Keyframe[][] = [];
	const pane = Object.assign(new FakeHTMLElement(), {
		animate: (keyframes: Keyframe[]) => {
			calls.push(keyframes);
			return {};
		},
	});
	const command = {
		dataset: {
			multiPane: "true",
			searching: options.searching ? "true" : "false",
		},
		querySelector: () => pane,
	};
	const originals = {
		HTMLElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"),
		matchMedia: Object.getOwnPropertyDescriptor(globalThis, "matchMedia"),
	};
	Object.defineProperty(globalThis, "HTMLElement", {
		configurable: true,
		writable: true,
		value: FakeHTMLElement,
	});
	Object.defineProperty(globalThis, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: query === "(width <= 30rem)" && options.phone,
		}),
	});
	return {
		calls,
		command,
		restore() {
			for (const [name, descriptor] of Object.entries(originals)) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			}
		},
	};
}

test("on a phone, drilling into a provider slides the models pane in from the right", () => {
	const drill = installDrill({ phone: true });
	try {
		drillIn(drill.command, ".model-model-pane", "8%");
		assertEquals(drill.calls.length, 1);
		assertEquals(drill.calls[0]?.[0], { opacity: 0, translate: "8% 0" });
	} finally {
		drill.restore();
	}
});

test("no drill animation while searching or at desktop width", () => {
	const searching = installDrill({ phone: true, searching: true });
	try {
		drillIn(searching.command, ".model-model-pane", "8%");
		assertEquals(searching.calls.length, 0);
	} finally {
		searching.restore();
	}
	const desktop = installDrill({ phone: false });
	try {
		drillIn(desktop.command, ".model-provider-pane", "-8%");
		assertEquals(desktop.calls.length, 0);
	} finally {
		desktop.restore();
	}
});

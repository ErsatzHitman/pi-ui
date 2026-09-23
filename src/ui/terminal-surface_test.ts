import { test } from "bun:test";

import {
	assertEquals,
	assertStringExcludes,
	assertStringIncludes,
} from "#testing/assertions";

import type { TerminalSurface } from "../agent/terminal-surface/types.ts";
import {
	renderTerminalSurfaceOverlays,
	renderTerminalSurfacePersistent,
	terminalSurfaceOverlayIds,
} from "./terminal-surface.tsx";

function surface(overrides: Partial<TerminalSurface>): TerminalSurface {
	return {
		id: "s1",
		kind: "overlay",
		title: undefined,
		overlayOptions: undefined,
		lines: ['<span style="color:var(--status-error)">red</span>'],
		cursor: undefined,
		cols: 80,
		rows: 24,
		revision: 1,
		...overrides,
	};
}

test("overlay surfaces render as focusable dialogs that forward keys, pastes and wheel", () => {
	const html = renderTerminalSurfaceOverlays({
		terminalSurfaces: [surface({ title: "<b>Pick</b>" })],
	});
	assertStringIncludes(html, 'id="terminal-surface-overlays"');
	assertStringIncludes(html, '<dialog id="terminal-surface-s1"');
	assertStringIncludes(html, "&lt;b&gt;Pick&lt;/b&gt;");
	assertStringIncludes(html, "window.piUi.terminal.encodeKey(evt)");
	assertStringIncludes(html, "window.piUi.terminal.encodePaste(");
	assertStringIncludes(html, "data-on:wheel__throttle.100ms");
	assertStringIncludes(html, "/extensions/terminal/input");
	// Line HTML is already escaped/styled by ansi-to-html and embedded verbatim.
	assertStringIncludes(html, '<span style="color:var(--status-error)">red</span>');
	assertEquals(terminalSurfaceOverlayIds({ terminalSurfaces: [surface({})] }), [
		"terminal-surface-s1",
	]);
});

test("inline custom() surfaces and component widgets render in the persistent host", () => {
	const html = renderTerminalSurfacePersistent({
		terminalSurfaces: [
			surface({ id: "inline-1", kind: "inline" }),
			surface({ id: "widget:w", kind: "widget" }),
			surface({ id: "o", kind: "overlay" }),
		],
	});
	assertStringIncludes(html, 'data-terminal-surface="inline-1"');
	assertStringIncludes(html, 'data-terminal-surface="widget:w"');
	assertStringExcludes(html, 'data-terminal-surface="o"');
});

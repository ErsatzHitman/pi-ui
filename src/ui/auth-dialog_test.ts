import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import type { AppAuthDialog } from "../state/app-store.ts";
import { renderAuthDialog, renderAuthDialogContent } from "./auth-dialog.tsx";

function dialog(overrides: Partial<AppAuthDialog>): AppAuthDialog {
	return {
		mode: "login",
		phase: "providers",
		providers: [{ id: "fake", name: "Fake", authType: "api_key" }],
		progress: [],
		...overrides,
	};
}

test("each auth phase keys its header, so a phase change settles in once inside an open dialog", () => {
	for (const phase of ["providers", "api-key", "oauth", "result"] as const) {
		const html = renderAuthDialogContent(
			dialog({ phase, providerName: "Fake", prompt: { message: "Key" } }),
		);
		assertStringIncludes(html, `<header id="auth-phase-${phase}"`);
		// Only inside an open dialog that is not running its own entry/exit transition
		// (no double entry on first open), and once per header however often data-init runs.
		assertStringIncludes(
			html,
			"if (d?.open && !d.getAnimations().length && !el.getAnimations().length)",
		);
		// The header and the block after it move; the panel surface never does.
		assertStringIncludes(html, "m?.enter(el, {");
		assertStringIncludes(html, "m?.enter(el.nextElementSibling, {");
		assertEquals(html.includes("el.parentElement"), false);
	}
	const flow = renderAuthDialogContent(
		dialog({ phase: "api-key", providerName: "Fake" }),
	);
	assertStringIncludes(flow, "from: 'rise'");
	const result = renderAuthDialogContent(dialog({ phase: "result", status: "Done" }));
	assertStringIncludes(result, "from: 'fade'");
	assertEquals(result.includes("from: 'pop'"), false);
});

test("a closed auth dialog keeps its content while it fades out", () => {
	const shell = renderAuthDialog(undefined);
	// The live content is marked ignore-morph once the dialog closes, and unmarked on open...
	assertStringIncludes(
		shell,
		`data-on:toggle="document.getElementById('auth-dialog-content')?.toggleAttribute('data-ignore-morph', evt.newState === 'closed')"`,
	);
	// ...and the /auth/close patch carries the marker too, so Datastar skips that morph.
	assertStringIncludes(
		renderAuthDialogContent(undefined),
		'<div id="auth-dialog-content" class="dialog-wide" data-ignore-morph data-init=',
	);
	// A real phase has no marker, so the next open's patch replaces the stale content.
	assertEquals(
		renderAuthDialogContent(dialog({})).includes("data-ignore-morph"),
		false,
	);
});

test("an auth error fades in, and Continue dims while its request is in flight", () => {
	const html = renderAuthDialogContent(
		dialog({
			phase: "api-key",
			providerName: "Fake",
			prompt: { message: "API key", secret: true },
			error: "Invalid key",
		}),
	);
	const error = html.slice(html.indexOf("error-foreground dialog-message"));
	assertStringIncludes(
		error,
		"el.getAnimations().length || window.piUi?.motion?.enter(el, { from: 'fade' })",
	);
	assertStringIncludes(html, "data-indicator:_auth-submitting");
	assertStringIncludes(html, 'data-attr:disabled="$_authSubmitting"');
	assertEquals(html.includes("Continue"), true);
});

test("the auth panel eases between phase heights instead of snapping", () => {
	for (const html of [
		renderAuthDialogContent(undefined),
		renderAuthDialogContent(dialog({})),
		renderAuthDialogContent(dialog({ phase: "result", status: "Done" })),
	]) {
		// Installed once on the panel itself, whatever phase it renders.
		assertStringIncludes(html, "if (el.piUiPanelResize) return;");
		// Each patch tweens from the settled (or in-flight) height to the new one...
		assertStringIncludes(
			html,
			"const from = tweening() ? el.offsetHeight : settled;",
		);
		assertStringIncludes(
			html,
			"[{ height: from + 'px', overflow: 'clip' }, { height: to + 'px', overflow: 'clip' }]",
		);
		assertStringIncludes(
			html,
			"{ duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }",
		);
		// ...only inside an open dialog that is not running its own entry/exit, and never
		// under reduced motion.
		assertStringIncludes(
			html,
			"if (!d?.open || d.getAnimations().length || Math.abs(to - from) < 1) return;",
		);
		assertStringIncludes(html, "prefers-reduced-motion: reduce");
	}
});

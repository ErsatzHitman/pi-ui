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
		'<div id="auth-dialog-content" class="dialog-wide" data-ignore-morph>',
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

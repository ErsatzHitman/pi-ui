import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import type { AppAuthDialog } from "../state/app-store.ts";
import { renderAuthDialogContent } from "./auth-dialog.tsx";

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
		assertStringIncludes(html, "el.closest('dialog')?.open");
		assertStringIncludes(html, "window.piUi?.motion?.enter(el.parentElement");
	}
	const result = renderAuthDialogContent(dialog({ phase: "result", status: "Done" }));
	assertStringIncludes(result, "from: 'pop'");
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
	assertStringIncludes(error, "window.piUi?.motion?.enter(el, { from: 'fade' })");
	assertStringIncludes(html, "data-indicator:_auth-submitting");
	assertStringIncludes(html, 'data-attr:disabled="$_authSubmitting"');
	assertEquals(html.includes("Continue"), true);
});

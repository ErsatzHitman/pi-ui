import { test } from "bun:test";

import { assertStringIncludes } from "#testing/assertions";

import { assertStringExcludes } from "../testing/assertions.ts";
import {
	renderExtensionDialog,
	renderExtensionDialogContent,
} from "./extension-dialog.tsx";

test("extension dialog escapes labels and posts attributed selections", () => {
	const html = renderExtensionDialogContent({
		id: "request-1",
		kind: "select",
		title: "<script>title</script>",
		options: ["<strong>option</strong>"],
	});

	assertStringExcludes(html, "<script>title</script>");
	assertStringExcludes(html, "<strong>option</strong>");
	assertStringIncludes(html, "&lt;script&gt;title&lt;/script&gt;");
	assertStringIncludes(html, "&lt;strong&gt;option&lt;/strong&gt;");
	assertStringIncludes(html, "/extensions/ui/respond");
	assertStringIncludes(html, "request-1");
});

test("closing the dialog only auto-cancels when a request is still live (RM2 multi-client)", () => {
	// Live-verified (two-CDP-client check): when client A answers, the server
	// broadcast that closes the dialog on every OTHER client patches signals
	// (clearing `extensionRequestId`) before it runs the `dialog.close()`
	// script (`ui-renderer.ts`'s `pickerEffectScripts`). Native `<dialog>`
	// fires its own "close" event for a script-driven `.close()` exactly like
	// a user pressing Escape, so an unguarded `data-on:close` posted a
	// `extensionRequestId: ""` cancellation from the LOSING client and got a
	// visible 400 (`extensions/ui/respond` requires it). Guard the auto-post
	// on the signal so a close with nothing left to cancel sends nothing.
	const html = renderExtensionDialog(undefined);

	assertStringIncludes(html, "data-on:close");
	assertStringIncludes(html, "/extensions/ui/respond");
	// The post is conditioned on the signal, not fired unconditionally: an
	// empty/missing `extensionRequestId` means there is nothing left to
	// cancel, so no request goes out at all.
	assertStringIncludes(html, "if ($extensionRequestId)");
});

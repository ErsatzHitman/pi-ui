import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

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

/**
 * Runs the dialog's real `data-on:close` expression the way Datastar would:
 * `$signal` reads from `signals`, `@post(...)` calls `post`, `el` is the
 * `<dialog>`. Returns every payload it posted.
 */
function runCloseHandler(
	signals: { extensionRequestId: string },
	dialogOpenAtCloseEvent: boolean,
): unknown[] {
	const html = renderExtensionDialog(undefined);
	const expression = /data-on:close="([^"]*)"/.exec(html)?.[1];
	if (!expression) throw new Error("data-on:close missing");
	const posts: unknown[] = [];
	const code = expression
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&")
		.replaceAll("$extensionRequestId", "signals.extensionRequestId")
		.replaceAll("@post(", "post(");
	new Function("el", "signals", "post", "document", code)(
		{ open: dialogOpenAtCloseEvent },
		signals,
		(_url: string, options: { payload: unknown }) => posts.push(options.payload),
		{ body: { dataset: { displayClientId: "client-b" } } },
	);
	return posts;
}

test("a user closing the dialog cancels the request it is showing", () => {
	const posts = runCloseHandler({ extensionRequestId: "request-1" }, false);
	assertEquals(posts, [
		{
			extensionRequestId: "request-1",
			extensionResponse: "",
			extensionCancelled: true,
			clientId: "client-b",
		},
	]);
});

test("a server close-and-reopen for the next queued dialog never cancels it (RM2 multi-client)", () => {
	// When another client answers dialog 1 while dialog 2 is queued, one commit
	// patches `extensionRequestId` to dialog 2 and runs `dialog.close()` then
	// `showModal()` (`ui-renderer.ts`'s `pickerEffectScripts`). The native
	// "close" event is queued, so it fires after the reopen: the signal already
	// names dialog 2, which nobody has touched. The dialog being open again is
	// what tells this close apart from a user's.
	assertEquals(runCloseHandler({ extensionRequestId: "request-2" }, true), []);
});

test("a server close with nothing queued posts nothing", () => {
	// `AppStore.setExtensionDialog(undefined)` clears the id before the close script.
	assertEquals(runCloseHandler({ extensionRequestId: "" }, false), []);
});

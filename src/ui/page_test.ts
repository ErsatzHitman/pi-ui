import { test } from "bun:test";
import { runInNewContext } from "node:vm";

import { assertEquals, assertFalse, assertStringIncludes } from "#testing/assertions";

import { setRemoteMode } from "../remote-mode.ts";
import { renderPage } from "./page.tsx";
import { appRenderSnapshot } from "./test-fixtures.ts";

function renderSidebarPage(options: { sessionSidebarOpen?: boolean } = {}): string {
	return renderPage({ ...appRenderSnapshot({}), messages: [] }, options);
}

function sidebarScriptFrom(page: string): string {
	return (
		[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((match) =>
			match[1]?.includes("getElementById('session-sidebar')"),
		)?.[1] ?? ""
	);
}

const html = renderSidebarPage();
const sidebarScript = sidebarScriptFrom(html);

test("one native sidebar dialog initializes before the workspace is parsed", () => {
	assertStringIncludes(html, '<dialog id="session-sidebar"');
	assertStringIncludes(html, 'closedby="any"');
	assertFalse(html.includes('aria-label="Close sessions"'));
	assertStringIncludes(html, 'commandfor="session-sidebar" command="--toggle"');
	assertEquals(html.match(/id="session-sidebar-content"/g)?.length, 1);
	assertEquals(sidebarScript.length > 0, true);
	assertEquals(
		html.indexOf(sidebarScript) < html.indexOf('id="workspace-shell"'),
		true,
	);
});

test("sidebar restores responsive preferences before datastar", () => {
	for (const [desktopOpen, mobile, expected] of [
		[true, false, "nonmodal"],
		[true, true, "closed"],
		[false, false, "closed"],
		[false, true, "closed"],
	] as const) {
		let shownAs = "closed";
		const reset: string[] = [];
		const dialog = {
			closedBy: "any",
			style: { removeProperty: (name: string) => reset.push(name) },
			removeAttribute: (name: string) => reset.push(name),
			close() {
				shownAs = "closed";
			},
			show() {
				shownAs = "nonmodal";
			},
			showModal() {
				shownAs = "modal";
			},
			querySelector() {
				return { scrollLeft: 0 };
			},
		};
		runInNewContext(
			sidebarScriptFrom(renderSidebarPage({ sessionSidebarOpen: desktopOpen })),
			{
				document: { getElementById: () => dialog },
				matchMedia: () => ({ matches: mobile }),
			},
		);
		assertEquals(shownAs, expected);
		assertEquals(dialog.closedBy, mobile ? "any" : "none");
		// Load and breakpoint restores stay instant and drop any half-finished swipe.
		assertEquals(reset, ["data-animate-open", "--drawer-drag", "data-dragging"]);
	}
});

test("Sessions and Live share one segmented switch instead of two separate toggle buttons", () => {
	// PLAN-ux.md "sidebar-exclusive": a single segmented header replaces the two standalone
	// toolbar buttons so the mutually-exclusive pair reads as one control, not two.
	assertStringIncludes(html, 'class="segmented-control right-pane-switch"');
	assertStringIncludes(html, 'role="group"');
	assertStringIncludes(html, 'id="session-sidebar-toggle"');
	assertStringIncludes(html, 'id="live-workspace-toggle"');
	assertStringIncludes(html, ">Sessions<");
	assertStringIncludes(html, ">Live<");
	// Both segments still carry their own pressed state and the toolbar button's toggle wiring.
	assertStringIncludes(html, "$_sessionSidebarOpen ? 'true' : 'false'");
	assertStringIncludes(html, "$_liveWorkspaceOpen ? 'true' : 'false'");
	assertStringIncludes(html, 'commandfor="session-sidebar" command="--toggle"');
});

test("workspace files expose native preview and source controls", () => {
	assertStringIncludes(html, 'id="workspace-file-mode"');
	assertStringIncludes(html, 'id="workspace-file-preview-mode"');
	assertStringIncludes(html, 'id="workspace-file-source-mode"');
	assertStringIncludes(html, 'id="workspace-file-preview"');
	assertStringIncludes(html, 'aria-label="File preview"');
});

test("the command menu and hotkeys dialogs keep their open state across morphs", () => {
	for (const id of ["command-dialog", "hotkeys-dialog"]) {
		const openTag = new RegExp(`<dialog id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
		assertStringIncludes(openTag, 'data-preserve-attr="open"');
	}
});

test("the llama progress bar and update copy button carry their motion hooks", () => {
	const page = renderPage({
		...appRenderSnapshot({
			llamaDialog: {
				models: [],
				progress: { label: "Loading model", ratio: 0.25 },
			},
			updateAvailable: {
				currentVersion: "1.0.0",
				latestVersion: "1.1.0",
				releaseUrl: "https://example.com/release",
				upgradeCommand: "bun add -g pi-ui",
			},
		}),
		messages: [],
	});
	// Progress fills scale from a --progress custom property, not an inline width.
	assertStringIncludes(
		page,
		'<div class="dialog-progress-value" style="--progress: 25">',
	);
	assertFalse(page.includes('style="width:'));

	const updateCopy =
		/<button[^>]*aria-label="Copy upgrade command"[^>]*>/.exec(page)?.[0] ?? "";
	assertStringIncludes(updateCopy, 'data-preserve-attr="data-copy-state"');
});

test("configured sidebar width is applied before styles", () => {
	assertStringIncludes(html, "--session-sidebar-preferred-width: 288px");
	const custom = renderPage(
		{ ...appRenderSnapshot({}), messages: [] },
		{ sessionSidebarWidth: 354 },
	);
	assertStringIncludes(custom, "--session-sidebar-preferred-width: 354px");
	assertEquals(
		custom.indexOf("--session-sidebar-preferred-width: 354px") <
			custom.indexOf('rel="stylesheet"'),
		true,
	);
});

test("the SSE stream stays open while the tab is hidden, in local mode too", () => {
	// Datastar's @get closes its stream on visibilitychange -> hidden by default, so a
	// background tab would never receive the "session finished" effect its Web
	// Notification depends on. RM1 audit open issue 4: this is a real local bug too (a
	// hidden local tab never got its "Turn finished" notification either), so it's
	// unconditional now, not gated on remote mode.
	const streamAction = (page: string) =>
		/data-init="(@get\('\/stream\?[^"]*)"/.exec(page)?.[1] ?? "";
	const local = streamAction(renderSidebarPage());
	assertStringIncludes(local, "retry: 'always'");
	assertStringIncludes(local, "openWhenHidden: true");
	// A forced reconnect (visibility/online) resumes from the last event it applied.
	assertStringIncludes(local, "headers: window.piUi.streamResumeHeaders()");

	setRemoteMode(true);
	try {
		assertStringIncludes(streamAction(renderSidebarPage()), "openWhenHidden: true");
	} finally {
		setRemoteMode(false);
	}
});

test("exposes remote mode and the VAPID public key to static/app/push.js as body data attributes", () => {
	const withKey = renderPage(
		{ ...appRenderSnapshot({}), messages: [] },
		{ pushPublicKey: "abc123" },
	);
	assertStringIncludes(withKey, 'data-push-public-key="abc123"');
	assertFalse(withKey.includes("data-remote-mode"));

	setRemoteMode(true);
	try {
		assertStringIncludes(renderSidebarPage(), "data-remote-mode");
	} finally {
		setRemoteMode(false);
	}
});

test("in remote mode a tab reports its page visibility on load and on every change (Web Push presence)", () => {
	const report = "@post('/stream/visibility'";
	const local = renderSidebarPage();
	assertFalse(local.includes(report));

	setRemoteMode(true);
	try {
		const page = renderSidebarPage();
		const init = /data-init="([^"]*)"/.exec(page)?.[1] ?? "";
		assertStringIncludes(init, "@get('/stream?");
		assertStringIncludes(init, report);
		assertStringIncludes(page, `data-on:visibilitychange__window="${report}`);
		assertStringIncludes(page, "visible: document.visibilityState === 'visible'");
	} finally {
		setRemoteMode(false);
	}
});

test("confirming a delete marks the row pending before the POST (B-X3)", () => {
	const signals = html.split("data-signals__ifmissing=")[1]?.slice(0, 600) ?? "";
	assertStringIncludes(signals, "_sessionDeletingPath");
	const confirm =
		html.split("Delete session</button>")[0]?.split("<button").at(-1) ?? "";
	const pending = confirm.indexOf("$_sessionDeletingPath = deleting");
	const post = confirm.indexOf("@post(");
	if (pending === -1 || post === -1 || pending > post) {
		throw new Error("expected the pending mark before the delete POST");
	}
});

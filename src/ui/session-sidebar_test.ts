import { test } from "bun:test";

import {
	assertFalse,
	assertStringExcludes,
	assertStringIncludes,
} from "#testing/assertions";

import { renderSessionPickerContent } from "./pickers.tsx";
import { renderSessionSidebar } from "./session-sidebar.tsx";
import { appRenderSnapshot } from "./test-fixtures.ts";

test("opening Sessions closes Live Workspace too (sidebar-exclusive)", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({ sessions: [], currentSessionPath: undefined }),
	);
	const commandHandler = html.split('data-on:command="')[1]?.split('"')[0];
	if (!commandHandler) throw new Error("command handler not found");
	assertStringIncludes(commandHandler, "if ($_liveWorkspaceOpen)");
	assertStringIncludes(commandHandler, "$_liveWorkspaceOpen = false");
	assertStringIncludes(commandHandler, "detail: { open: $_liveWorkspaceOpen }");
});

test("a closing Sessions pane goes inert through its exit; opening clears it first (C6)", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({ sessions: [], currentSessionPath: undefined }),
	);
	const commandHandler = html.split('data-on:command="')[1]?.split('"')[0];
	if (!commandHandler) throw new Error("command handler not found");
	assertStringIncludes(
		commandHandler,
		"if (evt.command === '--toggle' && el.open) { el.close(); el.inert = true; }",
	);
	const clearIndex = commandHandler.indexOf("el.inert = false;");
	const showIndex = commandHandler.indexOf("el.showModal()");
	if (clearIndex === -1 || clearIndex > showIndex) {
		throw new Error("expected inert cleared before show()/showModal()");
	}
	// Every other close path (light dismiss, Esc, a row tap, a swipe) settles through toggle.
	assertStringIncludes(
		html,
		'data-on:toggle="$_sessionSidebarOpen = el.open; el.inert = !el.open"',
	);
	assertStringIncludes(html, "dialog.close();\n\t\tdialog.inert = true;");
	assertStringIncludes(html, "el.closest('dialog').inert = true;");
	// The inline restore leaves a closed drawer inert and a restored-open sidebar focusable.
	assertStringIncludes(html, "el.inert = mobile || !true;");
});

test("a backdrop tap that light-dismisses the drawer never clicks the page underneath", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({ sessions: [], currentSessionPath: undefined }),
	);
	const dialogTag = html.slice(
		html.indexOf("<dialog"),
		html.indexOf(">", html.indexOf("<dialog")),
	);
	const handler = dialogTag.split('data-on:touchend="')[1]?.split('"')[0];
	if (!handler) throw new Error("dialog touchend handler not found");
	// Datastar listeners are non-passive unless `__passive`, so preventDefault() can cancel the tap.
	assertFalse(dialogTag.includes("data-on:touchend__passive"));
	const run = (target: "backdrop" | "nav", open: boolean, cancelable = true) => {
		const el = { open };
		let prevented = false;
		const evt = {
			target: target === "backdrop" ? el : {},
			cancelable,
			preventDefault: () => {
				prevented = true;
			},
		};
		new Function("el", "evt", handler)(el, evt);
		return prevented;
	};
	// Light dismiss closed the drawer on pointerup: cancel the tap's click.
	if (!run("backdrop", false)) throw new Error("expected the backdrop tap cancelled");
	// Taps inside the drawer (rows, swipe release) and a still-open dialog keep their click.
	assertFalse(run("nav", false));
	assertFalse(run("backdrop", true));
	assertFalse(run("backdrop", false, false));
});

test("session sidebar shows an empty state with no sessions and nothing loading", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({
			sessions: [],
			currentSessionPath: undefined,
			activityText: undefined,
			sessionCatalogLoading: false,
		}),
	);

	assertStringIncludes(html, "No sessions yet.");
});

test("session sidebar hides the empty state while the catalog is still loading", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({
			sessions: [],
			currentSessionPath: undefined,
			activityText: undefined,
			sessionCatalogLoading: true,
		}),
	);

	assertFalse(html.includes("No sessions yet."));
	assertStringIncludes(html, 'aria-label="Loading"');
});

test("session sidebar keeps loading visible beneath partial results", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({
			sessions: [
				{
					path: "/sessions/partial.jsonl",
					cwd: "/workspace",
					title: "Partial session",
					messageCount: 1,
					modified: "Now",
				},
			],
			currentSessionPath: undefined,
			activityText: undefined,
			sessionCatalogLoading: true,
		}),
	);

	assertStringIncludes(html, "Partial session");
	assertStringIncludes(html, 'aria-label="Loading"');
});

test("session sidebar groups sessions while preserving times and shortcuts", () => {
	const now = new Date();
	const today = new Date(now);
	today.setHours(12, 0, 0, 0);
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	yesterday.setHours(12, 0, 0, 0);
	const earlier = new Date(now);
	earlier.setDate(now.getDate() - 8);
	earlier.setHours(12, 0, 0, 0);
	const html = renderSessionSidebar(
		appRenderSnapshot({
			sessions: [
				{
					path: "/sessions/today.jsonl",
					cwd: "/workspace",
					title: "Today session",
					messageCount: 1,
					modified: "12:00",
					modifiedAt: today.toISOString(),
				},
				{
					path: "/sessions/yesterday.jsonl",
					cwd: "/workspace",
					title: "Yesterday session",
					messageCount: 1,
					modified: "yesterday",
					modifiedAt: yesterday.toISOString(),
				},
				{
					path: "/sessions/earlier.jsonl",
					cwd: "/workspace",
					title: "Earlier session",
					messageCount: 1,
					modified: "Aug 1",
					modifiedAt: earlier.toISOString(),
				},
			],
			currentSessionPath: undefined,
			activityText: undefined,
			sessionCatalogLoading: false,
		}),
	);

	assertFalse(html.includes(">Today</span>"));
	assertStringIncludes(html, ">Yesterday</span>");
	assertFalse(html.includes(">Earlier</span>"));
	assertStringIncludes(html, ">12:00</time>");
	assertFalse(html.includes(">yesterday</time>"));
	assertFalse(html.includes(">Aug 1</time>"));
	assertStringIncludes(html, "Earlier session");
	assertStringIncludes(html, "evt.code === 'Digit3'");
});

test("session sidebar initially renders 30 sessions and an infinite-scroll trigger", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({
			sessions: Array.from({ length: 30 }, (_, index) => ({
				path: `/sessions/${index + 1}.jsonl`,
				cwd: "/workspace",
				title: `Session ${index + 1}`,
				messageCount: 1,
				modified: "Today",
			})),
			currentSessionPath: undefined,
			activityText: undefined,
			sessionCatalogLoading: false,
			sessionsHasMore: true,
		}),
	);

	assertStringIncludes(html, "Session 30");
	assertStringIncludes(html, "@post('/sessions/more'");
});

test("session sidebar assigns shortcuts to only the first nine sessions", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({
			sessions: Array.from({ length: 10 }, (_, index) => ({
				path: `/sessions/${index + 1}.jsonl`,
				cwd: "/workspace",
				title: `Session ${index + 1}`,
				messageCount: 1,
				modified: "Today",
			})),
			currentSessionPath: undefined,
			activityText: undefined,
			sessionCatalogLoading: false,
		}),
	);

	assertStringIncludes(html, "evt.code === 'Digit1'");
	assertStringIncludes(html, "evt.code === 'Digit9'");
	// The sidebar only handles ctrl+number while no session picker is open.
	assertStringIncludes(html, "!(document.getElementById('session-dialog')?.open)");
	assertStringIncludes(html, ">1</kbd>");
	assertStringIncludes(html, ">9</kbd>");
	assertFalse(html.includes("Digit10"));
});

function commandHandlerOf(html: string): string {
	const handler = html.split('data-on:command="')[1]?.split('"')[0];
	if (!handler) throw new Error("command handler not found");
	return handler;
}

const oneSession = {
	path: "/sessions/one.jsonl",
	cwd: "/workspace",
	title: "One",
	messageCount: 1,
	modified: "Now",
};

test("every sidebar command arms the pane motion first and animates, whatever the trigger", () => {
	const handler = commandHandlerOf(
		renderSessionSidebar(
			appRenderSnapshot({ sessions: [], currentSessionPath: undefined }),
		),
	);
	assertStringIncludes(handler, "el.setAttribute('data-animate-open', '')");
	assertStringExcludes(handler, ":focus-visible");
	const arm = handler.indexOf("window.piUi.paneMotion?.arm('sessions'");
	if (
		arm === -1 ||
		arm > handler.indexOf("el.close()") ||
		arm > handler.indexOf("el.show()")
	) {
		throw new Error(
			"expected the synchronous arm before the dialog changes (flow-critique #1)",
		);
	}
});

test("breakpoint restores reset the swipe state; the scroller tracks the swipe", () => {
	const html = renderSessionSidebar(
		appRenderSnapshot({ sessions: [], currentSessionPath: undefined }),
	);
	assertStringIncludes(html, "removeProperty('--drawer-drag')");
	assertStringIncludes(html, "data-on:scroll__passive");
	assertStringIncludes(html, "data-on:touchend__passive");
	// Coalesced to one write per frame (flow-critique #20).
	assertStringIncludes(html, "requestAnimationFrame");
	// The scroll-snap settle after a swipe close must not re-arm `data-dragging` (it would cut
	// the scrim's exit fade), and every open starts from a clean scrim.
	assertStringIncludes(html, "if (!dialog.open) {");
	const handler = commandHandlerOf(html);
	assertStringIncludes(handler, "el.style.removeProperty('--drawer-drag')");
	assertStringIncludes(handler, "el.removeAttribute('data-dragging')");
});

test("sidebar and session-menu rows dim while their delete is pending (B-X3)", () => {
	const snapshot = appRenderSnapshot({
		sessions: [oneSession],
		currentSessionPath: undefined,
		activityText: undefined,
		sessionCatalogLoading: false,
	});
	const sidebar = renderSessionSidebar(snapshot);
	assertStringIncludes(sidebar, "data-attr:data-deleting");
	assertStringIncludes(sidebar, "_sessionDeletingPath");
	const menu = renderSessionPickerContent(snapshot);
	assertStringIncludes(menu, "data-attr:data-deleting");
	// A morph of the row mid-delete must not strip the client-set attribute (un-dim flash).
	assertStringIncludes(sidebar, 'data-preserve-attr="data-deleting"');
	assertStringIncludes(menu, 'data-preserve-attr="class data-deleting"');
});

test("a running session-menu row's abort dims at t0 (B-X5)", () => {
	const html = renderSessionPickerContent(
		appRenderSnapshot({
			sessions: [{ ...oneSession, backgroundStatus: "running" }],
			currentSessionPath: undefined,
			activityText: undefined,
		}),
	);
	const abort = html.split('class="btn session-menu-abort"')[1]?.split("</button>")[0];
	if (!abort) throw new Error("abort button not found");
	assertStringIncludes(abort, "el.setAttribute('data-aborting', '')");
});

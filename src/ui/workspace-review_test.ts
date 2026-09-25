import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import {
	commitWhenCurrent,
	revealFades,
	selectionFadeGapMs,
	selectionFades,
} from "../client/workspace-files.ts";
import { emptyWorkspaceGitGraphSnapshot } from "../workspace-git-graph-types.ts";
import {
	emptyWorkspaceReviewSnapshot,
	type WorkspaceReviewPreferences,
} from "../workspace-review-types.ts";
import { renderWorkspaceReview } from "./workspace-review.tsx";

function render(isGitRepository: boolean, preferences: WorkspaceReviewPreferences) {
	return renderWorkspaceReview(
		"/work",
		0,
		0,
		{ ...emptyWorkspaceReviewSnapshot, isGitRepository },
		preferences,
		{ ...emptyWorkspaceGitGraphSnapshot, isGitRepository },
	);
}

// The phone layout stacks the Git sidebar above the graph (workspace-review.css,
// `.review-body[data-review-tab="git"]`) so the graph gets the full pane width instead
// of the ~150px the side-by-side sidebar left it at 390px. That needs the active tab on
// the body, server-rendered and kept live as the tab switches.
test("the review body names its active tab for the phone layout", () => {
	assertStringIncludes(render(true, { tab: "git" }), 'data-review-tab="git"');
	assertStringIncludes(render(true, {}), 'data-review-tab="git"');
	assertStringIncludes(render(true, { tab: "files" }), 'data-review-tab="files"');
	assertStringIncludes(render(false, { tab: "git" }), 'data-review-tab="files"');
	assertStringIncludes(render(true, { tab: "git" }), "data-attr:data-review-tab=");
});

// Review file switch (flow-spec E3 + flow-critique #11): j/k stepping swaps instantly, a
// deliberate selection fades; the previous view stays painted until the new render commits.
test("a file selection fades only after a pause since the previous one", () => {
	assertEquals(selectionFades(1000, Number.NEGATIVE_INFINITY), true);
	assertEquals(selectionFades(1000, 1000 - selectionFadeGapMs + 50), false);
	assertEquals(selectionFades(1000, 1000 - selectionFadeGapMs), false);
	assertEquals(selectionFades(1000, 1000 - selectionFadeGapMs - 1), true);
});

test("a stale file render never replaces the painted content", async () => {
	let generation = 1;
	const commits: number[] = [];
	const { promise, resolve } = Promise.withResolvers<void>();
	const stale = commitWhenCurrent(
		promise,
		() => generation === 1,
		() => commits.push(1),
	);
	generation = 2;
	resolve();
	assertEquals(await stale, false);
	assertEquals(commits, []);

	const current = commitWhenCurrent(
		Promise.resolve(),
		() => generation === 2,
		() => commits.push(2),
	);
	assertEquals(await current, true);
	assertEquals(commits, [2]);
});

test("the Files main fades once across a first load, even one that outlasts its hold", () => {
	// A running hold always ends in a fade, whatever the reveal asked for.
	assertEquals(revealFades(true, false, false), true);
	assertEquals(revealFades(true, true, false), true);
	// No hold: a deliberate selection fades, a j/k step or tree refresh does not.
	assertEquals(revealFades(false, true, false), true);
	assertEquals(revealFades(false, false, false), false);
	// The hold expired and already faded the main in: the late first file swaps in place
	// instead of dipping back to 0 for a second fade.
	assertEquals(revealFades(false, true, true), false);
});

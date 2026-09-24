import { test } from "bun:test";

import { assertStringIncludes } from "#testing/assertions";

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

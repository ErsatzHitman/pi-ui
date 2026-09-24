import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";

/** Maximum number of graph rows fetched per page (bounds cost on huge repos). */
export const workspaceGitGraphPageSize = 200;

export type GitGraphRefKind = Static<typeof gitGraphRefKindSchema>;
export type GitGraphRef = Static<typeof gitGraphRefSchema>;
export type GitGraphSegment = Static<typeof gitGraphSegmentSchema>;
export type GitGraphRow = Static<typeof gitGraphRowSchema>;
export type GitGraphBranch = Static<typeof gitGraphBranchSchema>;
export type WorkspaceGitGraphSnapshot = Static<typeof workspaceGitGraphSnapshotSchema>;

export const emptyWorkspaceGitGraphSnapshot: WorkspaceGitGraphSnapshot = {
	branch: null,
	branches: [],
	changeCount: 0,
	hasMore: false,
	isGitRepository: false,
	laneCount: 0,
	mainBranch: null,
	revision: "non-git",
	rows: [],
};

export const unloadedWorkspaceGitGraphSnapshot: WorkspaceGitGraphSnapshot = {
	...emptyWorkspaceGitGraphSnapshot,
	revision: "git-graph-unloaded",
};

const gitGraphRefKindSchema = Type.Union([
	Type.Literal("head"),
	Type.Literal("local-branch"),
	Type.Literal("remote-branch"),
	Type.Literal("tag"),
]);

const gitGraphRefSchema = Type.ReadonlyObject(
	Type.Object({
		current: Type.Boolean(),
		kind: gitGraphRefKindSchema,
		main: Type.Boolean(),
		name: Type.String(),
	}),
);

const gitGraphSegmentSchema = Type.ReadonlyObject(
	Type.Object({
		fromLane: Type.Number(),
		toLane: Type.Number(),
	}),
);

const gitGraphRowSchema = Type.ReadonlyObject(
	Type.Object({
		author: Type.String(),
		authoredAt: Type.String(),
		hash: Type.String(),
		lane: Type.Number(),
		parents: Type.ReadonlyObject(Type.Array(Type.String())),
		refs: Type.ReadonlyObject(Type.Array(gitGraphRefSchema)),
		segments: Type.ReadonlyObject(Type.Array(gitGraphSegmentSchema)),
		shortHash: Type.String(),
		subject: Type.String(),
	}),
);

/**
 * A local branch for the Git sidebar's branch list. `ahead`/`behind` are the
 * commit counts between it and its upstream (from `git for-each-ref`'s own
 * `%(upstream:track)`, so no extra `rev-list` process is needed); both are 0
 * when there is no upstream. `hash` is its tip commit, used to scroll/select
 * that commit in the graph when the branch row is clicked — a no-op if the
 * tip isn't among the currently loaded graph rows (e.g. an old branch beyond
 * the loaded page).
 */
const gitGraphBranchSchema = Type.ReadonlyObject(
	Type.Object({
		ahead: Type.Number(),
		behind: Type.Number(),
		current: Type.Boolean(),
		hash: Type.String(),
		main: Type.Boolean(),
		name: Type.String(),
		upstream: Type.Union([Type.String(), Type.Null()]),
	}),
);

const workspaceGitGraphSnapshotSchema = Type.ReadonlyObject(
	Type.Object({
		branch: Type.Union([Type.String(), Type.Null()]),
		branches: Type.ReadonlyObject(Type.Array(gitGraphBranchSchema)),
		changeCount: Type.Number(),
		hasMore: Type.Boolean(),
		isGitRepository: Type.Boolean(),
		laneCount: Type.Number(),
		mainBranch: Type.Union([Type.String(), Type.Null()]),
		revision: Type.String(),
		rows: Type.ReadonlyObject(Type.Array(gitGraphRowSchema)),
	}),
);

const workspaceGitGraphCommitDetailSchema = Type.ReadonlyObject(
	Type.Object({
		author: Type.String(),
		authoredAt: Type.String(),
		/** The commit message after its subject line; empty for a one-line message. */
		body: Type.String(),
		changes: Type.ReadonlyObject(
			Type.Array(
				Type.ReadonlyObject(
					Type.Object({
						additions: Type.Number(),
						deletions: Type.Number(),
						path: Type.String(),
						status: Type.Union([
							Type.Literal("added"),
							Type.Literal("deleted"),
							Type.Literal("modified"),
							Type.Literal("renamed"),
						]),
					}),
				),
			),
		),
		hash: Type.String(),
		parents: Type.ReadonlyObject(Type.Array(Type.String())),
		shortHash: Type.String(),
		subject: Type.String(),
	}),
);

export type WorkspaceGitGraphCommitDetail = Static<
	typeof workspaceGitGraphCommitDetailSchema
>;

const workspaceGitGraphSnapshotValidator = Compile(workspaceGitGraphSnapshotSchema);
const workspaceGitGraphCommitDetailValidator = Compile(
	workspaceGitGraphCommitDetailSchema,
);

export function isWorkspaceGitGraphSnapshot<Value>(
	value: Value,
): value is Value & WorkspaceGitGraphSnapshot {
	return workspaceGitGraphSnapshotValidator.Check(value);
}

export function isWorkspaceGitGraphCommitDetail<Value>(
	value: Value,
): value is Value & WorkspaceGitGraphCommitDetail {
	return workspaceGitGraphCommitDetailValidator.Check(value);
}

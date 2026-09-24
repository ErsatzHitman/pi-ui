import type { GitGraphRef, GitGraphSegment } from "./workspace-git-graph-types.ts";

/**
 * Assigns each commit to a lane (graph column) and computes the connector
 * segments drawn in that commit's row, from a list of commits already in
 * Git's topological order (children before parents; `git log --topo-order`).
 *
 * The approach is adapted from the lane-tracking technique used by
 * vscode-git-graph (MIT License, Copyright (c) Michael Hutchison,
 * https://github.com/mhutchie/vscode-git-graph): walk the commits in
 * topological order while keeping one "lane" per branch still awaiting its
 * next commit. Each lane remembers the hash of the commit it expects next.
 * When that commit is reached, the lane is resolved (and, for a merge,
 * fans out into one lane per additional parent); when several lanes are
 * simultaneously waiting on the same hash, they visually converge onto it.
 * Freed lanes are reused for later branch tips, which keeps the total lane
 * count bounded to the graph's real concurrent width rather than its total
 * branch count.
 */
export type GitGraphLayoutCommit = Readonly<{
	hash: string;
	parents: readonly string[];
}>;

export type GitGraphLayoutRow = Readonly<{
	lane: number;
	segments: readonly GitGraphSegment[];
}>;

export type GitGraphLayoutResult = Readonly<{
	laneCount: number;
	rows: readonly GitGraphLayoutRow[];
}>;

export function layoutGitGraphLanes(
	commits: readonly GitGraphLayoutCommit[],
): GitGraphLayoutResult {
	const lanes: Array<string | null> = [];
	const rows: GitGraphLayoutRow[] = [];

	for (const commit of commits) {
		const originalLength = lanes.length;
		const incoming: number[] = [];
		for (let index = 0; index < originalLength; index++) {
			if (lanes[index] === commit.hash) incoming.push(index);
		}
		const lane = incoming.length > 0 ? Math.min(...incoming) : allocateLane(lanes);

		const segments = new Map<string, GitGraphSegment>();
		const addSegment = (fromLane: number, toLane: number) => {
			segments.set(`${fromLane}:${toLane}`, { fromLane, toLane });
		};
		for (const from of incoming) addSegment(from, lane);
		for (const from of incoming) if (from !== lane) lanes[from] = null;

		const [firstParent, ...otherParents] = commit.parents;
		if (firstParent) {
			lanes[lane] = firstParent;
			addSegment(lane, lane);
		} else {
			lanes[lane] = null;
		}
		for (const parent of otherParents) {
			const existingLane = lanes.indexOf(parent);
			const targetLane = existingLane !== -1 ? existingLane : allocateLane(lanes);
			lanes[targetLane] = parent;
			addSegment(lane, targetLane);
		}

		for (let index = 0; index < originalLength; index++) {
			if (index === lane || incoming.includes(index)) continue;
			if (lanes[index] !== null) addSegment(index, index);
		}

		rows.push({
			lane,
			segments: [...segments.values()].sort(
				(a, b) => a.fromLane - b.fromLane || a.toLane - b.toLane,
			),
		});
	}

	return { laneCount: lanes.length, rows };
}

function allocateLane(lanes: Array<string | null>): number {
	const free = lanes.indexOf(null);
	if (free !== -1) return free;
	lanes.push(null);
	return lanes.length - 1;
}

/**
 * Parses `git log --format=%D` ref decoration text (e.g.
 * `HEAD -> main, origin/main, origin/HEAD, tag: v1.0.0`) into structured refs.
 */
export function parseGitGraphRefs(
	decoration: string,
	mainBranchName: string | null,
	remotes: readonly string[] = ["origin"],
): GitGraphRef[] {
	const trimmed = decoration.trim();
	if (!trimmed) return [];
	const refs: GitGraphRef[] = [];
	for (const rawToken of trimmed.split(",")) {
		const token = rawToken.trim();
		if (!token) continue;
		if (token === "HEAD") {
			refs.push({ current: true, kind: "head", main: false, name: "HEAD" });
			continue;
		}
		if (token.startsWith("HEAD -> ")) {
			const name = token.slice("HEAD -> ".length).trim();
			refs.push({
				current: true,
				kind: "local-branch",
				main: name === mainBranchName,
				name,
			});
			continue;
		}
		if (token.startsWith("tag: ")) {
			const name = token.slice("tag: ".length).trim();
			refs.push({ current: false, kind: "tag", main: false, name });
			continue;
		}
		const remotePrefix = remotes.find(
			(remote) => token === remote || token.startsWith(`${remote}/`),
		);
		if (remotePrefix) {
			const branchName = token.slice(remotePrefix.length + 1);
			if (branchName === "HEAD") continue; // Symbolic pointer, not a real ref to show.
			refs.push({
				current: false,
				kind: "remote-branch",
				main: branchName === mainBranchName,
				name: token,
			});
			continue;
		}
		refs.push({
			current: false,
			kind: "local-branch",
			main: token === mainBranchName,
			name: token,
		});
	}
	return refs;
}

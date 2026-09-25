import { responseErrorMessage } from "../utils/errors.ts";
import {
	isWorkspaceGitGraphCommitDetail,
	isWorkspaceGitGraphSnapshot,
	type WorkspaceGitGraphCommitDetail,
	type WorkspaceGitGraphSnapshot,
} from "../workspace-git-graph-types.ts";

/** `endpoint` is the shared `/workspace/review` base (`data-workspace-review-endpoint`). */
export function createWorkspaceGitGraphApi(endpoint: string) {
	return {
		async loadCommit(
			hash: string,
		): Promise<WorkspaceGitGraphCommitDetail | undefined> {
			try {
				const response = await fetch(
					`${endpoint}/graph/commit?hash=${encodeURIComponent(hash)}`,
					{ headers: { accept: "application/json" } },
				);
				if (!response.ok) return undefined;
				const value = await response.json();
				return isWorkspaceGitGraphCommitDetail(value) ? value : undefined;
			} catch {
				return undefined;
			}
		},

		async loadMore(count: number): Promise<WorkspaceGitGraphSnapshot> {
			const response = await fetch(`${endpoint}/graph/more?count=${count}`, {
				headers: { accept: "application/json" },
			});
			if (!response.ok) {
				throw new Error(
					await responseErrorMessage(
						response,
						`Unable to load more history (${response.status})`,
					),
				);
			}
			const value = await response.json();
			if (!isWorkspaceGitGraphSnapshot(value)) {
				throw new Error("Unable to load more history (invalid response)");
			}
			return value;
		},
	};
}

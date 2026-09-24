import { workspaceGitGraphPageSize } from "../../workspace-git-graph-types.ts";
import { normalizeWorkspaceReviewPreferences } from "../../workspace-review-types.ts";
import { readActionSignals } from "../action-input.ts";
import { updateAppConfig } from "../app-config.ts";
import { datastarResponse } from "../datastar.ts";
import type { RouteMap } from "../route.ts";
import {
	readWorkspaceGitGraph,
	readWorkspaceGitGraphCommit,
} from "../workspace-git-graph.ts";
import type { RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

export const workspaceReviewRoutes = {
	[endpoints.workspaceReviewPreferences]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			const preferences = normalizeWorkspaceReviewPreferences(
				signals.workspaceReviewPreferences,
			);
			await updateAppConfig((config) => {
				config.gitView = preferences;
			});
			context.store.setWorkspaceReviewPreferences(preferences);
			return datastarResponse();
		},
	},
	[endpoints.workspaceGitGraphCommit]: {
		GET: async (_request, context, url) => {
			const hash = url.searchParams.get("hash") ?? "";
			const detail = await readWorkspaceGitGraphCommit(
				context.store.workspacePath,
				hash,
			);
			return detail
				? Response.json(detail, { headers: { "cache-control": "no-cache" } })
				: new Response("Commit not found", { status: 404 });
		},
	},
	[endpoints.workspaceGitGraphMore]: {
		// Lane layout depends on the whole visible window, so "Load more" asks
		// for a larger bounded window rather than an incremental page. This is a
		// per-viewer convenience (like paging commit history), not shared app
		// state, so it answers directly instead of publishing through the store.
		GET: async (_request, context, url) => {
			const value =
				url.searchParams.get("count") ?? String(workspaceGitGraphPageSize);
			const count = Number(value);
			if (!Number.isSafeInteger(count) || count <= 0 || count > 20_000) {
				return new Response("Invalid graph size", { status: 400 });
			}
			return Response.json(
				await readWorkspaceGitGraph(context.store.workspacePath, count),
				{ headers: { "cache-control": "no-cache" } },
			);
		},
	},
} satisfies RouteMap<RouteContext>;

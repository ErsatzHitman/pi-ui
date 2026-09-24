import { isRecord, isString } from "../../utils/type-guards.ts";
import { workspaceGitGraphPageSize } from "../../workspace-git-graph-types.ts";
import {
	formatWorkspaceReviewPrompt,
	parseWorkspaceReviewComments,
} from "../../workspace-review-comments.ts";
import { normalizeWorkspaceReviewPreferences } from "../../workspace-review-types.ts";
import { readActionSignals } from "../action-input.ts";
import { updateAppConfig } from "../app-config.ts";
import { datastarResponse } from "../datastar.ts";
import { RouteError, type RouteMap } from "../route.ts";
import {
	readWorkspaceGitGraph,
	readWorkspaceGitGraphCommit,
} from "../workspace-git-graph.ts";
import {
	discardWorkspaceChange,
	readWorkspaceCommit,
	readWorkspaceDiff,
	readWorkspaceHistory,
	WorkspaceReviewError,
} from "../workspace-review.ts";
import { requireHost, type RouteContext } from "./context.ts";
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
	[endpoints.workspaceReviewSubmit]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			let comments;
			try {
				comments = parseWorkspaceReviewComments(signals.workspaceReviewComments);
			} catch (error) {
				throw new RouteError(
					400,
					Error.isError(error) ? error.message : "Invalid review comments.",
				);
			}
			if (
				!(await requireHost(context).prompt(
					formatWorkspaceReviewPrompt(comments),
				))
			) {
				throw new RouteError(409, "Review comments were not accepted.");
			}
			return datastarResponse([
				{ type: "effect", effect: { type: "workspace-review-submitted" } },
			]);
		},
	},
	[endpoints.workspaceReviewDiscard]: {
		POST: async (request, context) => {
			const value: unknown = await request.json();
			if (!isRecord(value) || !isString(value.path)) {
				throw new RouteError(400, "Invalid changed file.");
			}
			try {
				await discardWorkspaceChange(context.store.workspacePath, value.path);
			} catch (error) {
				if (error instanceof WorkspaceReviewError) {
					throw new RouteError(error.status, error.message);
				}
				throw error;
			}
			return datastarResponse();
		},
	},
	[endpoints.workspaceReviewDiff]: {
		GET: async (request, context, url) => {
			const query = url.searchParams;
			const workspacePath = context.store.workspacePath;
			if (query.get("workspacePath") !== workspacePath)
				throw new RouteError(409, "Workspace changed. Reopen the diff.");
			try {
				const patch = await readWorkspaceDiff(
					workspacePath,
					query.get("path") ?? undefined,
					request.signal,
				);
				return new Response(patch, {
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"cache-control": "no-store",
					},
				});
			} catch (error) {
				if (error instanceof WorkspaceReviewError)
					throw new RouteError(error.status, error.message);
				throw error;
			}
		},
	},
	[endpoints.workspaceReviewCommit]: {
		GET: async (_request, context, url) => {
			const hash = url.searchParams.get("hash") ?? "";
			const detail = await readWorkspaceCommit(context.store.workspacePath, hash);
			return detail
				? Response.json(detail, { headers: { "cache-control": "no-cache" } })
				: new Response("Commit not found", { status: 404 });
		},
	},
	[endpoints.workspaceReviewHistory]: {
		GET: async (_request, context, url) => {
			const value = url.searchParams.get("offset") ?? "0";
			const offset = Number(value);
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
				return new Response("Invalid history offset", { status: 400 });
			}
			return Response.json(
				await readWorkspaceHistory(context.store.workspacePath, offset),
				{ headers: { "cache-control": "no-cache" } },
			);
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

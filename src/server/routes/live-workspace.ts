import { normalizeLiveWorkspacePreferences } from "../../live-workspace-types.ts";
import { readActionSignals } from "../action-input.ts";
import { updateAppConfig } from "../app-config.ts";
import { datastarResponse } from "../datastar.ts";
import type { RouteMap } from "../route.ts";
import { requireHost, type RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

export const liveWorkspaceRoutes = {
	[endpoints.liveWorkspacePreferences]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			const preferences = normalizeLiveWorkspacePreferences(
				signals.liveWorkspacePreferences,
			);
			await updateAppConfig((config) => {
				config.liveWorkspace = preferences;
			});
			context.store.setLiveWorkspacePreferences(preferences);
			return datastarResponse();
		},
	},
	[endpoints.liveWorkspaceClearActivity]: {
		POST: async (_request, context) => {
			requireHost(context).clearLiveWorkspaceActivity();
			return datastarResponse();
		},
	},
} satisfies RouteMap<RouteContext>;

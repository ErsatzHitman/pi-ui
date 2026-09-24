import { booleanField, readActionSignals, requiredString } from "../action-input.ts";
import { isDisplayClientId } from "../display-refresh.ts";
import { RouteError, type RouteMap } from "../route.ts";
import type { RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

export const streamRoutes = {
	[endpoints.stream]: {
		GET: (request, context, url) => {
			const parameters = url.searchParams;
			const clientId = parameters.get("clientId");
			if (!clientId || !isDisplayClientId(clientId)) {
				throw new RouteError(400, "Invalid display client ID.");
			}
			if (parameters.get("appVersion") !== context.appVersion) {
				return new Response("location.reload();", {
					headers: {
						"cache-control": "no-store",
						"content-type": "text/javascript; charset=utf-8",
					},
				});
			}
			return context.renderer.createStream(
				request.signal,
				clientId,
				() => {
					// The current host at disconnect time, whichever `RuntimeController` that
					// is — see `UiRenderer.createStream`'s doc comment on this parameter.
					context.resources.host?.forgetTerminalSurfaceClient(clientId);
				},
				// Datastar's own fetch-based `@get` reconnect logic tracks and resends this
				// automatically (see `DatastarClientHub`'s `lastEventId` doc comment) — round
				// RM2 sse-resume.
				request.headers.get("Last-Event-ID"),
			);
		},
	},
	// The page's visibility, on load and on every `visibilitychange` (`page.tsx`) —
	// see `DatastarClientHub.visibleClientCount` (Web Push presence).
	[endpoints.streamVisibility]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			const clientId = requiredString(signals, "clientId");
			if (!isDisplayClientId(clientId)) {
				throw new RouteError(400, "Invalid display client ID.");
			}
			context.renderer.setClientVisibility(
				clientId,
				booleanField(signals, "visible"),
			);
			return new Response(null, { status: 204 });
		},
	},
} satisfies RouteMap<RouteContext>;

import { renderServiceWorkerScript } from "../../ui/service-worker-script.ts";
import type { RouteMap } from "../route.ts";
import type { RouteContext } from "./context.ts";

/** `/sw.js` (not under `/static/<version>/`, so its scope stays "/" — the whole
 * app, matching the manifest's `scope`): rendered per request from
 * `context.appVersion` (see `service-worker-script.ts`) rather than served as a
 * static file, purely so its content — and so the browser's own byte-diff
 * update check — changes on every deploy. */
export const serviceWorkerRoutes = {
	"/sw.js": {
		GET: (_request, context) =>
			new Response(renderServiceWorkerScript(context.appVersion), {
				headers: {
					"content-type": "text/javascript; charset=utf-8",
					// Never let a proxy or the browser's HTTP cache serve a stale worker
					// script instead of revalidating — the versioned cache name above is
					// only useful if a genuinely new version is actually fetched.
					"cache-control": "no-cache",
				},
			}),
	},
} satisfies RouteMap<RouteContext>;

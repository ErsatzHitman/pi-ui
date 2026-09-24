// POST /session/logout clears the pi-ui session cookie set by /session/login
// (session-login-route.ts). Unlike that route, this one is a normal appRoutes entry, so
// gateRoutes/withAuthToken (server-main.ts, request-auth.ts) already require a valid
// token to reach it and already CSRF-check it when that token came from the cookie.
import { buildClearedAuthCookie, isHttpsRequest } from "../request-auth.ts";
import type { RouteMap } from "../route.ts";
import type { RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

export const sessionAuthRoutes = {
	[endpoints.sessionLogout]: {
		POST: (request: Request) => {
			const response = new Response(null, {
				status: 303,
				headers: { location: endpoints.root },
			});
			response.headers.append(
				"set-cookie",
				buildClearedAuthCookie(isHttpsRequest(request)),
			);
			return response;
		},
	},
} satisfies RouteMap<RouteContext>;

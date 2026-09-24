import {
	ActionInputError,
	enumField,
	optionalString,
	readActionSignals,
	requiredString,
} from "../action-input.ts";
import { datastarResponse, signalsResponse } from "../datastar.ts";
import { isDisplayClientId } from "../display-refresh.ts";
import { RouteError, type RouteMap } from "../route.ts";
import { requireHost, type RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

export const authRoutes = {
	[endpoints.authOpenLogin]: {
		POST: (_request, context) => {
			requireHost(context).openLogin();
			return datastarResponse();
		},
	},
	[endpoints.authOpenLogout]: {
		POST: (_request, context) => {
			requireHost(context).openLogout();
			return datastarResponse();
		},
	},
	[endpoints.authLoginStart]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			const provider = requiredString(signals, "authProvider");
			const type = enumField(signals, "authType", ["oauth", "api_key"] as const);
			if (!requireHost(context).startLogin(provider, type)) {
				throw new RouteError(409, "Login could not be started.");
			}
			return signalsResponse({ authInput: "" });
		},
	},
	[endpoints.authInput]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			const input = optionalString(signals, "authInput") ?? "";
			// The answering tab's id (`page.tsx`'s `displayClientId`), same shape as
			// `extension-ui.ts`'s `extensionUiResponse` route — lets other connected
			// clients tell "I answered this" from "someone else did" for the
			// auth_url/api-key/oauth prompt flow too (round RM1 multi-client #1).
			// Optional: an older client that doesn't send one just doesn't get
			// excluded from the broadcast toast.
			const clientId = optionalString(signals, "clientId");
			if (clientId !== undefined && !isDisplayClientId(clientId)) {
				throw new ActionInputError("Invalid clientId.");
			}
			// A `false` return means there was no active dialog to answer — most
			// often another client already submitted it a moment earlier. That is
			// not this client's error: like `extensions/ui/respond` above, the
			// losing POST gets a plain 204, not a visible failure (round RM2
			// multi-client #1). `AuthController.submitInput` has already told the
			// winning client(s) via `notifyOtherClients`.
			requireHost(context).submitAuthInput(input, clientId);
			return datastarResponse();
		},
	},
	[endpoints.authLogout]: {
		POST: async (request, context) => {
			const provider = requiredString(
				await readActionSignals(request),
				"authProvider",
			);
			if (!requireHost(context).logout(provider)) {
				throw new RouteError(409, "Logout could not be started.");
			}
			return datastarResponse();
		},
	},
	[endpoints.authClose]: {
		POST: (_request, context) => {
			requireHost(context).closeAuth();
			return datastarResponse();
		},
	},
} satisfies RouteMap<RouteContext>;

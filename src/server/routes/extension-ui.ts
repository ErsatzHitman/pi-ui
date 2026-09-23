import type { JsonValue } from "../../utils/json-types.ts";
import {
	booleanField,
	readActionSignals,
	requiredString,
	stringField,
} from "../action-input.ts";
import { datastarResponse } from "../datastar.ts";
import type { RouteMap } from "../route.ts";
import { requireHost, type RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

export const extensionUiRoutes = {
	[endpoints.extensionUiEditor]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			context.store.setPromptEditorText(stringField(signals, "prompt"), {
				broadcast: false,
			});
			return datastarResponse();
		},
	},
	[endpoints.extensionUiResponse]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			requireHost(context).respondExtensionUi(
				requiredString(signals, "extensionRequestId"),
				stringField(signals, "extensionResponse"),
				booleanField(signals, "extensionCancelled", { optional: true }),
			);
			return datastarResponse();
		},
	},
	[endpoints.extensionUiAction]: {
		POST: async (request, context) => {
			const signals = await readActionSignals(request);
			// SAFETY: `value` is an arbitrary extension-defined JSON payload (a
			// form's collected field values, a roster row id, or nothing).
			// Datastar has already parsed the request body into JSON values, so
			// this narrows the wire type (`Jsonifiable`, which also permits a
			// nested `undefined`) to the domain type this route forwards.
			const value = signals.value as JsonValue | undefined;
			await requireHost(context).dispatchExtensionUiAction({
				elementId: requiredString(signals, "elementId"),
				actionId: requiredString(signals, "actionId"),
				value,
			});
			return datastarResponse();
		},
	},
} satisfies RouteMap<RouteContext>;

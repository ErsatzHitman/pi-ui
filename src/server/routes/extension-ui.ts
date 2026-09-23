import type { JsonValue } from "../../utils/json-types.ts";
import {
	booleanField,
	jsonSizeField,
	readActionSignals,
	requiredString,
	stringField,
} from "../action-input.ts";
import { datastarResponse } from "../datastar.ts";
import type { RouteMap } from "../route.ts";
import { requireHost, type RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

/**
 * Defensive caps on an untrusted PIUI action request (a click from an
 * extension-rendered button, form submit, or roster row action). These bound
 * worst-case memory for a misbehaving or malicious extension the same way
 * `pi-ui-bridge.ts`'s decoder caps element/channel state; a well-behaved
 * bridge payload never approaches them.
 */
const maxElementIdLength = 512;
const maxActionIdLength = 256;
const maxActionValueBytes = 64 * 1024;

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
			// Datastar has already parsed the request body into JSON values, and
			// `jsonSizeField` has bounded its serialized size, so this narrows the
			// wire type (`Jsonifiable`, which also permits a nested `undefined`)
			// to the domain type this route forwards.
			const value = jsonSizeField(signals, "value", {
				maxBytes: maxActionValueBytes,
			}) as JsonValue | undefined;
			await requireHost(context).dispatchExtensionUiAction({
				elementId: requiredString(signals, "elementId", {
					maxLength: maxElementIdLength,
				}),
				actionId: requiredString(signals, "actionId", {
					maxLength: maxActionIdLength,
				}),
				value,
			});
			return datastarResponse();
		},
	},
} satisfies RouteMap<RouteContext>;

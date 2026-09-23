import type { JsonValue } from "../../utils/json-types.ts";
import {
	ActionInputError,
	boundedString,
	booleanField,
	readActionSignals,
	requiredString,
	stringField,
} from "../action-input.ts";
import { datastarResponse } from "../datastar.ts";
import type { RouteMap } from "../route.ts";
import { requireHost, type RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

// `elementId`/`actionId` are DOM- and slug-derived identifiers, never free
// text — real ones are well under this. `value` is an arbitrary
// extension-defined JSON payload forwarded to the extension's `pi_ui_event`
// command as a base64url-encoded argument; capping its serialized size keeps
// a misbehaving or malicious client from relaying an outsized argument to
// that child process.
const maxActionIdLength = 512;
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
			// Datastar has already parsed the request body into JSON values, so
			// this narrows the wire type (`Jsonifiable`, which also permits a
			// nested `undefined`) to the domain type this route forwards.
			const value = signals.value as JsonValue | undefined;
			if (
				value !== undefined &&
				JSON.stringify(value).length > maxActionValueBytes
			) {
				throw new ActionInputError(
					"value exceeds the maximum action payload size.",
				);
			}
			await requireHost(context).dispatchExtensionUiAction({
				elementId: boundedString(signals, "elementId", maxActionIdLength),
				actionId: boundedString(signals, "actionId", maxActionIdLength),
				value,
			});
			return datastarResponse();
		},
	},
} satisfies RouteMap<RouteContext>;

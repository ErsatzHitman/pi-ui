import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";

import { RouteError, type RouteMap } from "../route.ts";
import type { RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

const subscriptionSchema = Type.Object({
	endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
	keys: Type.Object({
		p256dh: Type.String({ minLength: 1, maxLength: 512 }),
		auth: Type.String({ minLength: 1, maxLength: 512 }),
	}),
});
const subscriptionValidator = Compile(subscriptionSchema);
type PushSubscriptionBody = Static<typeof subscriptionSchema>;

const unsubscribeSchema = Type.Object({
	endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
});
const unsubscribeValidator = Compile(unsubscribeSchema);
type PushUnsubscribeBody = Static<typeof unsubscribeSchema>;

/** Parses and validates a JSON request body against `validator` in one step,
 * so no caller ever handles the raw, unparsed `unknown` JSON value itself. */
async function readValidatedJsonBody<T>(
	request: Request,
	validator: { Check: (value: unknown) => value is T },
	invalidMessage: string,
): Promise<T> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new RouteError(400, "Malformed JSON body.");
	}
	if (!validator.Check(body)) throw new RouteError(400, invalidMessage);
	return body;
}

/**
 * Registers/removes a `PushSubscription` (`static/app/push.js`) for Web Push
 * "session finished" notices (`push-service.ts`). Plain JSON POSTs, not
 * Datastar `@post` actions: a `PushSubscription` isn't a UI signal.
 */
export const pushRoutes = {
	[endpoints.pushSubscribe]: {
		POST: async (request, context) => {
			const body = await readValidatedJsonBody<PushSubscriptionBody>(
				request,
				subscriptionValidator,
				"Invalid push subscription.",
			);
			await context.pushSubscriptions.add({
				endpoint: body.endpoint,
				p256dh: body.keys.p256dh,
				auth: body.keys.auth,
			});
			return new Response(null, { status: 204 });
		},
	},
	[endpoints.pushUnsubscribe]: {
		POST: async (request, context) => {
			const body = await readValidatedJsonBody<PushUnsubscribeBody>(
				request,
				unsubscribeValidator,
				"Invalid request.",
			);
			await context.pushSubscriptions.remove(body.endpoint);
			return new Response(null, { status: 204 });
		},
	},
} satisfies RouteMap<RouteContext>;

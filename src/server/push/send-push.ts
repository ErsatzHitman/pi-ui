/**
 * Sends one Web Push message to one subscription: encrypts the payload
 * (RFC 8291), signs a VAPID identity JWT (RFC 8292), and POSTs it to the
 * subscription's push-service endpoint. `push-service.ts` calls this once per
 * stored subscription when a background session finishes with no client
 * connected.
 */
import { randomBytes } from "node:crypto";

import { encryptAes128Gcm, generateEphemeralKeyPair } from "./aes128gcm.ts";
import type { PushSubscriptionRecord } from "./subscription-store.ts";
import { buildVapidAuthorizationHeader } from "./vapid-jwt.ts";
import type { VapidKeyPair } from "./vapid-keys.ts";

/** RFC 8030 §5's TTL header: how long the push service may hold the message
 * for an offline device before giving up. A finished-session notice is only
 * useful fairly soon, so this stays well short of the service's own maximum. */
const defaultTtlSeconds = 60 * 60 * 4;

export interface SendWebPushOptions {
	readonly subscription: PushSubscriptionRecord;
	readonly payload: unknown;
	readonly vapidKeys: VapidKeyPair;
	/** A contact URI for RFC 8292's `sub` claim, e.g. `mailto:you@example.com`. */
	readonly vapidSubject: string;
	readonly ttlSeconds?: number;
	/** Injected for tests; defaults to the global `fetch`. */
	readonly fetchImpl?: typeof fetch;
}

export type SendWebPushResult =
	| { readonly outcome: "sent" }
	/** The push service reports the subscription no longer exists (404/410) —
	 * the caller should remove it from the subscription store. */
	| { readonly outcome: "gone" }
	| { readonly outcome: "failed"; readonly statusCode: number }
	/** `fetchImpl` itself rejected instead of resolving to an HTTP response — DNS
	 * failure, connection refused, TLS error, timeout, or any other
	 * network-level error reaching the push service. This is the routine case
	 * the feature exists to tolerate (a stale or unreachable push endpoint), so
	 * it resolves like every other outcome instead of throwing; treated like
	 * `"failed"` by the caller (transient, the subscription is not removed). */
	| { readonly outcome: "network-error"; readonly error: unknown };

function endpointOrigin(endpoint: string): string {
	const url = new URL(endpoint);
	return `${url.protocol}//${url.host}`;
}

export async function sendWebPush(
	options: SendWebPushOptions,
): Promise<SendWebPushResult> {
	const salt = randomBytes(16);
	const ephemeral = generateEphemeralKeyPair();
	const body = encryptAes128Gcm({
		asPrivateKey: ephemeral.privateKey,
		asPublicKey: ephemeral.publicKey,
		uaPublicKey: Buffer.from(options.subscription.p256dh, "base64url"),
		authSecret: Buffer.from(options.subscription.auth, "base64url"),
		salt,
		plaintext: Buffer.from(JSON.stringify(options.payload)),
	});
	const authorization = buildVapidAuthorizationHeader({
		audience: endpointOrigin(options.subscription.endpoint),
		subject: options.vapidSubject,
		keys: options.vapidKeys,
	});
	const fetchImpl = options.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(options.subscription.endpoint, {
			method: "POST",
			headers: {
				authorization,
				"content-encoding": "aes128gcm",
				"content-type": "application/octet-stream",
				ttl: String(options.ttlSeconds ?? defaultTtlSeconds),
			},
			body: new Uint8Array(body),
		});
	} catch (error) {
		return { outcome: "network-error", error };
	}
	if (response.status === 404 || response.status === 410) return { outcome: "gone" };
	if (!response.ok) return { outcome: "failed", statusCode: response.status };
	return { outcome: "sent" };
}

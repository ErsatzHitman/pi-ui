/**
 * RFC 8292 "Voluntary Application Server Identification (VAPID) for Web Push":
 * a short-lived ES256 JWT that identifies this server to a push service,
 * carried as the `Authorization: vapid t=<jwt>, k=<publicKey>` header
 * `send-push.ts` sends with every push. `vapid-keys.ts` provides the
 * long-lived identity keypair this signs with.
 */
import { createPrivateKey, sign } from "node:crypto";

import type { VapidKeyPair } from "./vapid-keys.ts";

/** RFC 8292 §2: "the expiration (exp) claim... should not exceed 24 hours".
 * A fresh JWT is built per outgoing push (`send-push.ts` never reuses one), so
 * this only needs to comfortably outlive one push service round trip. */
const defaultExpirySeconds = 12 * 60 * 60;

export interface VapidJwtOptions {
	/** The push service's origin (scheme + host, no path) — RFC 8292 §2's `aud`. */
	readonly audience: string;
	/** A contact URI the push service may use to reach the sender of an abusive
	 * subscription, e.g. `mailto:ops@example.com` — RFC 8292 §2's `sub`. */
	readonly subject: string;
	readonly keys: VapidKeyPair;
	readonly expiresInSeconds?: number;
	readonly now?: number;
}

/** RFC 7515 §4.1's fixed JOSE header for this JWT (the same for every call). */
interface VapidJwtHeader {
	readonly typ: "JWT";
	readonly alg: "ES256";
}

/** RFC 8292 §2's three required claims. */
interface VapidJwtClaims {
	readonly aud: string;
	readonly exp: number;
	readonly sub: string;
}

function base64UrlJson(value: VapidJwtHeader | VapidJwtClaims): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function vapidPrivateKeyObject(keys: VapidKeyPair) {
	const x = keys.publicKeyRaw.subarray(1, 33).toString("base64url");
	const y = keys.publicKeyRaw.subarray(33, 65).toString("base64url");
	return createPrivateKey({
		key: { kty: "EC", crv: "P-256", x, y, d: keys.privateKeyD.toString("base64url") },
		format: "jwk",
	});
}

/** Builds the compact ES256 JWT itself (header.payload.signature, all base64url,
 * the signature in JOSE's fixed-width r‖s form — RFC 7518 §3.4 — not ASN.1 DER). */
export function buildVapidJwt(options: VapidJwtOptions): string {
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const expiresIn = options.expiresInSeconds ?? defaultExpirySeconds;
	const signingInput = `${base64UrlJson({ typ: "JWT", alg: "ES256" })}.${base64UrlJson({
		aud: options.audience,
		exp: now + expiresIn,
		sub: options.subject,
	})}`;
	const signature = sign("sha256", Buffer.from(signingInput), {
		key: vapidPrivateKeyObject(options.keys),
		dsaEncoding: "ieee-p1363",
	});
	return `${signingInput}.${signature.toString("base64url")}`;
}

/** The `Authorization` header value RFC 8292 §3 defines for a push request. */
export function buildVapidAuthorizationHeader(options: VapidJwtOptions): string {
	return `vapid t=${buildVapidJwt(options)}, k=${options.keys.publicKeyRaw.toString("base64url")}`;
}

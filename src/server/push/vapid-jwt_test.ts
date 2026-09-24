import { test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";

import { assertEquals } from "#testing/assertions";

import { buildVapidAuthorizationHeader, buildVapidJwt } from "./vapid-jwt.ts";
import type { VapidKeyPair } from "./vapid-keys.ts";

function decodeSegment(segment: string): unknown {
	return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function samplePublicKeyRaw(x: string, y: string): Buffer {
	return Buffer.concat([
		Uint8Array.of(4),
		Buffer.from(x, "base64url"),
		Buffer.from(y, "base64url"),
	]);
}

// A real, matching ES256 keypair generated once (`generateKeyPairSync`) for
// these tests only — not a production key, and not from RFC 8292 (whose own
// example publishes only a public key, not the private key needed to sign).
const testKeys: VapidKeyPair = {
	publicKeyRaw: samplePublicKeyRaw(
		"btD-zkKZDFQVsir3DcQZO89xl9z_FlEviWliXPrOWt4",
		"S4fpzplQvrrgALljIAt8BDI8Q5-E1771qkgN69D5xIA",
	),
	privateKeyD: Buffer.from("BAyi2ajSw7D6EevfVcZbYjBffqCuDag7Pq6jdjYyUrs", "base64url"),
};

test("builds a compact ES256 JWT with the requested claims", () => {
	const jwt = buildVapidJwt({
		audience: "https://push.example.net",
		subject: "mailto:push@example.com",
		keys: testKeys,
		now: 1453522768,
		expiresInSeconds: 1000,
	});
	const [header, payload, signature] = jwt.split(".");
	assertEquals(decodeSegment(header!), { typ: "JWT", alg: "ES256" });
	assertEquals(decodeSegment(payload!), {
		aud: "https://push.example.net",
		exp: 1453523768,
		sub: "mailto:push@example.com",
	});
	// ES256's r‖s signature is exactly 64 raw bytes once base64url-decoded — the
	// JOSE form (RFC 7518 §3.4), not the longer, variable-length ASN.1 DER form
	// `node:crypto`'s default signing would otherwise produce.
	assertEquals(Buffer.from(signature!, "base64url").length, 64);
});

test("the signature verifies against the matching public key", () => {
	const jwt = buildVapidJwt({
		audience: "https://push.example.net",
		subject: "mailto:push@example.com",
		keys: testKeys,
	});
	const [header, payload, signature] = jwt.split(".");
	const publicKey = createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: testKeys.publicKeyRaw.subarray(1, 33).toString("base64url"),
			y: testKeys.publicKeyRaw.subarray(33, 65).toString("base64url"),
		},
		format: "jwk",
	});
	const verified = verify(
		"sha256",
		Buffer.from(`${header}.${payload}`),
		{ key: publicKey, dsaEncoding: "ieee-p1363" },
		Buffer.from(signature!, "base64url"),
	);
	assertEquals(verified, true);
});

test("does not verify against a different key", () => {
	const jwt = buildVapidJwt({
		audience: "https://push.example.net",
		subject: "mailto:push@example.com",
		keys: testKeys,
	});
	const [header, payload, signature] = jwt.split(".");
	const otherPublicKey = createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			// A different, unrelated real P-256 point (not `testKeys`'s public key).
			x: "CvGxYf0xxmuf27yuSLR7c144D24eB6zVtrmXnJyuDLI",
			y: "yw0sHJ37kpW2lK2f9_Miqire8Hg4-b8r_Qq-ifIfVCo",
		},
		format: "jwk",
	});
	const verified = verify(
		"sha256",
		Buffer.from(`${header}.${payload}`),
		{ key: otherPublicKey, dsaEncoding: "ieee-p1363" },
		Buffer.from(signature!, "base64url"),
	);
	assertEquals(verified, false);
});

test("keeps the expiry within RFC 8292's 24-hour maximum by default", () => {
	const now = 1_700_000_000;
	const jwt = buildVapidJwt({
		audience: "https://push.example.net",
		subject: "mailto:push@example.com",
		keys: testKeys,
		now,
	});
	const payload = decodeSegment(jwt.split(".")[1]!) as { exp: number };
	assertEquals(payload.exp > now, true);
	assertEquals(payload.exp - now <= 24 * 60 * 60, true);
});

test("buildVapidAuthorizationHeader carries the JWT and the raw public key", () => {
	const header = buildVapidAuthorizationHeader({
		audience: "https://push.example.net",
		subject: "mailto:push@example.com",
		keys: testKeys,
	});
	assertEquals(header.startsWith("vapid t="), true);
	assertEquals(
		header.includes(`, k=${testKeys.publicKeyRaw.toString("base64url")}`),
		true,
	);
});

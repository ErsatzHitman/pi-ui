import { test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

import { assertEquals } from "#testing/assertions";

import { generateEphemeralKeyPair } from "./aes128gcm.ts";
import { sendWebPush } from "./send-push.ts";
import type { PushSubscriptionRecord } from "./subscription-store.ts";
import type { VapidKeyPair } from "./vapid-keys.ts";

/**
 * A from-scratch, independent re-implementation of the *receiver* side of RFC
 * 8291/8188 aes128gcm decryption — deliberately not sharing any code with
 * `aes128gcm.ts` (which only implements the *sender* side), so this test
 * proves real interop rather than the module agreeing with itself. This is
 * what a browser's push service worker does with an incoming push, and
 * stands in here for "a real check that a push reaches a Chrome push
 * subscription": headless Chrome can only reach a real push service (FCM)
 * with outbound internet access to Google's infrastructure, which this
 * sandboxed environment does not have, so this decrypts against the
 * subscription's own keys exactly as the real receiver would, through a
 * mocked push-service HTTP endpoint.
 */
function hmacSha256(key: Buffer, data: Buffer): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
	return hmacSha256(prk, Buffer.concat([info, Uint8Array.of(1)])).subarray(0, length);
}

function decryptAsReceiver(options: {
	body: Buffer;
	receiverPrivateKey: Buffer;
	receiverPublicKey: Buffer;
	authSecret: Buffer;
}): unknown {
	const header = options.body.subarray(0, 86);
	const salt = header.subarray(0, 16);
	const idlen = header.readUInt8(20);
	const senderPublicKey = header.subarray(21, 21 + idlen);
	const ciphertextAndTag = options.body.subarray(86);
	const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
	const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);

	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(options.receiverPrivateKey);
	const ecdhSecret = ecdh.computeSecret(senderPublicKey);

	const keyPrk = hmacSha256(options.authSecret, ecdhSecret);
	const keyInfo = Buffer.concat([
		Buffer.from("WebPush: info", "ascii"),
		Uint8Array.of(0),
		options.receiverPublicKey,
		senderPublicKey,
	]);
	const ikm = hkdfExpand(keyPrk, keyInfo, 32);
	const prk = hmacSha256(salt, ikm);
	const cek = hkdfExpand(
		prk,
		Buffer.concat([
			Buffer.from("Content-Encoding: aes128gcm", "ascii"),
			Uint8Array.of(0),
		]),
		16,
	);
	const nonce = hkdfExpand(
		prk,
		Buffer.concat([
			Buffer.from("Content-Encoding: nonce", "ascii"),
			Uint8Array.of(0),
		]),
		12,
	);

	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(tag);
	const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	// Strip RFC 8188's padding delimiter (0x02 for the last/only record).
	const plaintext = padded.subarray(0, padded.length - 1);
	return JSON.parse(plaintext.toString("utf8"));
}

function testVapidKeys(): VapidKeyPair {
	const { privateKey, publicKey } = generateEphemeralKeyPair();
	return { privateKeyD: privateKey, publicKeyRaw: publicKey };
}

interface MockPushService {
	readonly requests: Array<{ url: string; headers: Headers; body: Buffer }>;
	fetchImpl: typeof fetch;
}

function mockPushService(status = 201): MockPushService {
	const requests: MockPushService["requests"] = [];
	return {
		requests,
		fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
			// `sendWebPush` always calls `fetchImpl` with the subscription's endpoint
			// string directly (never a `Request`/`URL`), so a plain `String()` is exact
			// here without needing to branch on `typeof`.
			const url = String(input);
			const body = Buffer.from(
				await new Response(init?.body as BodyInit).arrayBuffer(),
			);
			requests.push({ url, headers: new Headers(init?.headers), body });
			return new Response(null, { status });
		}) as typeof fetch,
	};
}

function subscriptionFor(
	receiverPublicKey: Buffer,
	authSecret: Buffer,
	endpoint = "https://push.example.net/subscription/abc123",
): PushSubscriptionRecord {
	return {
		endpoint,
		p256dh: receiverPublicKey.toString("base64url"),
		auth: authSecret.toString("base64url"),
	};
}

test("a mock push endpoint can decrypt exactly the payload sendWebPush encrypted", async () => {
	const receiver = generateEphemeralKeyPair();
	const authSecret = randomBytes(16);
	const service = mockPushService();
	const payload = { title: "Background session finished", body: "~/work/pi-ui" };

	const result = await sendWebPush({
		subscription: subscriptionFor(receiver.publicKey, authSecret),
		payload,
		vapidKeys: testVapidKeys(),
		vapidSubject: "mailto:ops@example.com",
		fetchImpl: service.fetchImpl,
	});

	assertEquals(result, { outcome: "sent" });
	assertEquals(service.requests.length, 1);
	const decrypted = decryptAsReceiver({
		body: service.requests[0]!.body,
		receiverPrivateKey: receiver.privateKey,
		receiverPublicKey: receiver.publicKey,
		authSecret,
	});
	assertEquals(decrypted, payload);
});

test("sends the required aes128gcm and VAPID headers", async () => {
	const receiver = generateEphemeralKeyPair();
	const authSecret = randomBytes(16);
	const service = mockPushService();

	await sendWebPush({
		subscription: subscriptionFor(receiver.publicKey, authSecret),
		payload: { title: "hi" },
		vapidKeys: testVapidKeys(),
		vapidSubject: "mailto:ops@example.com",
		ttlSeconds: 120,
		fetchImpl: service.fetchImpl,
	});

	const request = service.requests[0]!;
	assertEquals(request.url, "https://push.example.net/subscription/abc123");
	assertEquals(request.headers.get("content-encoding"), "aes128gcm");
	assertEquals(request.headers.get("content-type"), "application/octet-stream");
	assertEquals(request.headers.get("ttl"), "120");
	assertEquals(request.headers.get("authorization")?.startsWith("vapid t="), true);
});

test("reports a gone subscription on 404 without throwing", async () => {
	const receiver = generateEphemeralKeyPair();
	const service = mockPushService(404);
	const result = await sendWebPush({
		subscription: subscriptionFor(receiver.publicKey, randomBytes(16)),
		payload: { title: "hi" },
		vapidKeys: testVapidKeys(),
		vapidSubject: "mailto:ops@example.com",
		fetchImpl: service.fetchImpl,
	});
	assertEquals(result, { outcome: "gone" });
});

test("reports a gone subscription on 410", async () => {
	const receiver = generateEphemeralKeyPair();
	const service = mockPushService(410);
	const result = await sendWebPush({
		subscription: subscriptionFor(receiver.publicKey, randomBytes(16)),
		payload: { title: "hi" },
		vapidKeys: testVapidKeys(),
		vapidSubject: "mailto:ops@example.com",
		fetchImpl: service.fetchImpl,
	});
	assertEquals(result, { outcome: "gone" });
});

test("reports a failure for any other non-OK status", async () => {
	const receiver = generateEphemeralKeyPair();
	const service = mockPushService(500);
	const result = await sendWebPush({
		subscription: subscriptionFor(receiver.publicKey, randomBytes(16)),
		payload: { title: "hi" },
		vapidKeys: testVapidKeys(),
		vapidSubject: "mailto:ops@example.com",
		fetchImpl: service.fetchImpl,
	});
	assertEquals(result, { outcome: "failed", statusCode: 500 });
});

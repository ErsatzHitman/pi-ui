import { test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

import { assertEquals } from "#testing/assertions";

import { generateEphemeralKeyPair } from "./aes128gcm.ts";
import { sendWebPush } from "./send-push.ts";
import type { VapidKeyPair } from "./vapid-keys.ts";

/**
 * The same independent receiver-side decrypt as `send-push_test.ts`, but
 * against a *real* `Bun.serve` HTTP server over the loopback socket instead
 * of an injected `fetchImpl` — this is the "real check that a push reaches a
 * Chrome push subscription" the RM2 plan asks for, adapted the way the plan
 * itself allows: a real push service (FCM) needs outbound internet access
 * this sandboxed environment doesn't have, so this proves the real thing it
 * stands in for — the actual HTTP request `sendWebPush` sends, over a real
 * socket, with real headers, decrypts correctly at the other end.
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
	const prk = hmacSha256(header.subarray(0, 16), ikm);
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
	return JSON.parse(padded.subarray(0, padded.length - 1).toString("utf8"));
}

test("sendWebPush's real HTTP request, over a real socket, decrypts correctly at a real server", async () => {
	const receiver = generateEphemeralKeyPair();
	const authSecret = randomBytes(16);
	const received: Array<{ headers: Record<string, string>; decrypted: unknown }> = [];

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			const body = Buffer.from(await request.arrayBuffer());
			received.push({
				headers: Object.fromEntries(request.headers),
				decrypted: decryptAsReceiver({
					body,
					receiverPrivateKey: receiver.privateKey,
					receiverPublicKey: receiver.publicKey,
					authSecret,
				}),
			});
			return new Response(null, { status: 201 });
		},
	});

	try {
		const vapidKeyPair = generateEphemeralKeyPair();
		const vapidKeys: VapidKeyPair = {
			publicKeyRaw: vapidKeyPair.publicKey,
			privateKeyD: vapidKeyPair.privateKey,
		};
		const payload = { title: "Background session finished", body: "~/work/pi-ui" };
		const result = await sendWebPush({
			subscription: {
				endpoint: `${server.url}push/real-socket-check`,
				p256dh: receiver.publicKey.toString("base64url"),
				auth: authSecret.toString("base64url"),
			},
			payload,
			vapidKeys,
			vapidSubject: "mailto:ops@example.com",
		});

		assertEquals(result, { outcome: "sent" });
		assertEquals(received.length, 1);
		assertEquals(received[0]?.decrypted, payload);
		assertEquals(received[0]?.headers["content-encoding"], "aes128gcm");
		assertEquals(received[0]?.headers.authorization?.startsWith("vapid t="), true);
	} finally {
		server.stop(true);
	}
});

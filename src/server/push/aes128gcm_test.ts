import { test } from "bun:test";
import { createDecipheriv } from "node:crypto";

import { assertEquals } from "#testing/assertions";

import {
	deriveWebPushKeyMaterial,
	encryptAes128Gcm,
	generateEphemeralKeyPair,
} from "./aes128gcm.ts";

function b64url(value: string): Buffer {
	return Buffer.from(value, "base64url");
}

// RFC 8291 Appendix A's worked example: every named input and intermediate value
// below is copied verbatim from the RFC (fetched from rfc-editor.org and
// cross-checked against a second independent fetch of the same document — both
// returned byte-identical values for every field here).
const rfc8291 = {
	asPrivateKey: b64url("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
	asPublicKey: b64url(
		"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	),
	uaPublicKey: b64url(
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	),
	authSecret: b64url("BTBZMqHH6r4Tts7J_aSIgg"),
	salt: b64url("DGv6ra1nlYgDCS1FRnbzlw"),
	plaintext: b64url("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
	// The RFC's own "Intermediate Values" for this example (§ Appendix A).
	contentEncryptionKey: b64url("oIhVW04MRdy2XN9CiKLxTg"),
	nonce: b64url("4h_95klXJ5E_qnoN"),
};

test("derives the exact Content Encryption Key and nonce from RFC 8291 Appendix A", () => {
	const material = deriveWebPushKeyMaterial(rfc8291);
	assertEquals(material.contentEncryptionKey, rfc8291.contentEncryptionKey);
	assertEquals(material.nonce, rfc8291.nonce);
});

test("encryptAes128Gcm's header and ciphertext round-trip through independent AES-128-GCM decryption using the RFC 8291 key material", () => {
	const body = encryptAes128Gcm({ ...rfc8291, recordSize: 4096 });

	// Content coding header (RFC 8188 §2): salt(16) | rs(4) | idlen(1) | keyid.
	assertEquals(body.subarray(0, 16), rfc8291.salt);
	assertEquals(body.readUInt32BE(16), 4096);
	assertEquals(body.readUInt8(20), 65);
	assertEquals(body.subarray(21, 86), rfc8291.asPublicKey);

	// Decrypt the ciphertext independently (not through this module's own
	// encrypt path) with the RFC's published key/nonce, and recover exactly the
	// RFC's plaintext plus its 0x02 padding delimiter.
	const ciphertext = body.subarray(86, body.length - 16);
	const tag = body.subarray(body.length - 16);
	const decipher = createDecipheriv(
		"aes-128-gcm",
		rfc8291.contentEncryptionKey,
		rfc8291.nonce,
	);
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	assertEquals(decrypted, Buffer.concat([rfc8291.plaintext, Uint8Array.of(2)]));
});

test("rejects a salt that isn't exactly 16 bytes", () => {
	const { privateKey, publicKey } = generateEphemeralKeyPair();
	let threw = false;
	try {
		encryptAes128Gcm({
			asPrivateKey: privateKey,
			asPublicKey: publicKey,
			uaPublicKey: publicKey,
			authSecret: Buffer.alloc(16),
			salt: Buffer.alloc(15),
			plaintext: Buffer.from("hi"),
		});
	} catch {
		threw = true;
	}
	assertEquals(threw, true);
});

test("rejects a plaintext that (with its delimiter) doesn't fit the record size", () => {
	const { privateKey, publicKey } = generateEphemeralKeyPair();
	let threw = false;
	try {
		encryptAes128Gcm({
			asPrivateKey: privateKey,
			asPublicKey: publicKey,
			uaPublicKey: publicKey,
			authSecret: Buffer.alloc(16),
			salt: Buffer.alloc(16),
			plaintext: Buffer.alloc(10),
			recordSize: 10,
		});
	} catch {
		threw = true;
	}
	assertEquals(threw, true);
});

test("generateEphemeralKeyPair produces keys a full encrypt call can use", () => {
	const sender = generateEphemeralKeyPair();
	const receiver = generateEphemeralKeyPair();
	assertEquals(sender.privateKey.length, 32);
	assertEquals(sender.publicKey.length, 65);
	assertEquals(sender.publicKey[0], 4);

	const body = encryptAes128Gcm({
		asPrivateKey: sender.privateKey,
		asPublicKey: sender.publicKey,
		uaPublicKey: receiver.publicKey,
		authSecret: Buffer.alloc(16, 7),
		salt: Buffer.alloc(16, 9),
		plaintext: Buffer.from(JSON.stringify({ title: "hi" })),
	});
	// The header carries the sender's own ephemeral public key back to the receiver.
	assertEquals(body.subarray(21, 86), sender.publicKey);
});

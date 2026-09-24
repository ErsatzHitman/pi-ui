/**
 * Web Push message encryption (RFC 8291 "Message Encryption for Web Push"), the
 * "aes128gcm" HTTP content coding (RFC 8188) instantiated with the ECDH key
 * agreement RFC 8291 §3.1-3.4 defines. Used by `send-push.ts` to encrypt a small
 * JSON payload so only the browser holding the subscription's private key (never
 * seen by this server) can read it; the push service in between only forwards
 * opaque bytes.
 *
 * All keys here are raw, fixed-width byte buffers (not PEM/JWK/DER): a 65-byte
 * uncompressed P-256 point (0x04 || X(32) || Y(32)) for public keys, and a 32-byte
 * big-endian scalar for private keys — the exact shapes `node:crypto`'s
 * `createECDH` produces and accepts, and the exact shapes a browser's
 * `PushSubscription.getKey("p256dh")` / RFC 8291 test vectors use, so no format
 * conversion happens anywhere in this module.
 */
import { createCipheriv, createECDH, createHmac } from "node:crypto";

/** RFC 8188 §2's per-message content coding header: the record's random salt,
 * its record size, and (for aes128gcm) the sender's ephemeral public key,
 * carried in-band so the receiver never needs an out-of-band "Crypto-Key" header. */
const publicKeyLength = 65;
const contentCodingHeaderLength = 16 + 4 + 1 + publicKeyLength;

export interface Aes128GcmEncryptOptions {
	/** This message's ephemeral ECDH keypair (RFC 8291's "as_private"/"as_public") —
	 * a fresh one per message is simplest and is what `send-push.ts` generates. */
	readonly asPrivateKey: Buffer;
	readonly asPublicKey: Buffer;
	/** The subscription's public key and auth secret (`PushSubscription.getKey`). */
	readonly uaPublicKey: Buffer;
	readonly authSecret: Buffer;
	/** 16 random bytes, unique per message (RFC 8188 requires it never repeat for
	 * a given key). Reusing it here (a test passes a fixed one) breaks secrecy. */
	readonly salt: Buffer;
	readonly plaintext: Buffer;
	/** RFC 8188 `rs`: the encrypted record size. pi-ui payloads are always a single
	 * record, so this only needs to be at least `plaintext.length + 1`; the RFC 8291
	 * worked example (and most implementations) uses 4096. */
	readonly recordSize?: number;
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

/** RFC 5869 HKDF-Expand, specialised to a single block: every derivation in RFC
 * 8291 asks for at most 32 bytes (one SHA-256 block), so the loop RFC 5869
 * describes never needs a second iteration. */
function hkdfExpandOneBlock(prk: Buffer, info: Buffer, length: number): Buffer {
	const block = hmacSha256(prk, Buffer.concat([info, Uint8Array.of(1)]));
	return block.subarray(0, length);
}

function infoBuffer(label: string, ...rest: readonly Buffer[]): Buffer {
	return Buffer.concat([Buffer.from(label, "ascii"), Uint8Array.of(0), ...rest]);
}

export interface WebPushKeyMaterial {
	readonly contentEncryptionKey: Buffer;
	readonly nonce: Buffer;
}

/**
 * RFC 8291 §3.3-3.4's key derivation, split out from {@link encryptAes128Gcm} so
 * it can be checked on its own against the RFC's published intermediate values
 * (`aes128gcm_test.ts`) independently of the AES-GCM step itself.
 */
export function deriveWebPushKeyMaterial(
	options: Pick<
		Aes128GcmEncryptOptions,
		"asPrivateKey" | "asPublicKey" | "uaPublicKey" | "authSecret" | "salt"
	>,
): WebPushKeyMaterial {
	if (options.salt.length !== 16) {
		throw new RangeError("aes128gcm salt must be 16 bytes");
	}

	// RFC 8291 §3.3: combine the ECDH shared secret with the subscription's
	// `auth_secret` (HKDF-Extract, then HKDF-Expand with both public keys bound
	// into `info` so an attacker can't replay a derivation against a different key
	// pair) to get the Input Keying Material for the per-message record.
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(options.asPrivateKey);
	const ecdhSecret = ecdh.computeSecret(options.uaPublicKey);

	const keyPrk = hmacSha256(options.authSecret, ecdhSecret);
	const keyInfo = infoBuffer("WebPush: info", options.uaPublicKey, options.asPublicKey);
	const inputKeyingMaterial = hkdfExpandOneBlock(keyPrk, keyInfo, 32);

	// RFC 8188 §2.1: HKDF-Extract the record's PRK from that IKM using the
	// record's own random salt, then derive the AEAD key and nonce from it.
	const prk = hmacSha256(options.salt, inputKeyingMaterial);
	const contentEncryptionKey = hkdfExpandOneBlock(
		prk,
		infoBuffer("Content-Encoding: aes128gcm"),
		16,
	);
	const nonce = hkdfExpandOneBlock(prk, infoBuffer("Content-Encoding: nonce"), 12);
	return { contentEncryptionKey, nonce };
}

/** Encrypts `plaintext` into a single aes128gcm record, RFC 8291 §3.4 + RFC 8188
 * §2: the returned bytes are the full HTTP request body a push service accepts
 * (content coding header, then the one ciphertext record) — nothing else needs
 * appending or framing. */
export function encryptAes128Gcm(options: Aes128GcmEncryptOptions): Buffer {
	const recordSize = options.recordSize ?? 4096;
	if (options.plaintext.length + 1 > recordSize) {
		throw new RangeError(
			"plaintext (plus its padding delimiter) exceeds the record size",
		);
	}
	const { contentEncryptionKey, nonce } = deriveWebPushKeyMaterial(options);

	// A single record (sequence number 0): RFC 8188 §2.1's per-record nonce is the
	// base NONCE XORed with the record's big-endian sequence number, which for
	// record 0 is the base NONCE unchanged.
	const header = Buffer.alloc(contentCodingHeaderLength);
	options.salt.copy(header, 0);
	header.writeUInt32BE(recordSize, 16);
	header.writeUInt8(options.asPublicKey.length, 20);
	options.asPublicKey.copy(header, 21);

	// RFC 8188 §2's padding: the last (here, only) record ends with delimiter
	// octet 0x02 before any padding (none added here beyond the delimiter itself).
	const padded = Buffer.concat([options.plaintext, Uint8Array.of(2)]);
	const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
	const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
	const tag = cipher.getAuthTag();

	return Buffer.concat([header, ciphertext, tag]);
}

export interface EphemeralKeyPair {
	readonly privateKey: Buffer;
	readonly publicKey: Buffer;
}

/** Generates a fresh ephemeral P-256 keypair for one message's `asPrivateKey`/
 * `asPublicKey` — RFC 8291 allows reuse, but a new pair per message is simpler
 * and leaks nothing across messages even if one nonce derivation were ever repeated. */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
	const ecdh = createECDH("prime256v1");
	const publicKey = ecdh.generateKeys();
	const privateKey = ecdh.getPrivateKey();
	// `getPrivateKey()` returns the scalar with leading zero bytes stripped; pad
	// it back to the fixed 32-byte width every other function here assumes.
	const padded = Buffer.alloc(32);
	privateKey.copy(padded, 32 - privateKey.length);
	return { privateKey: padded, publicKey };
}

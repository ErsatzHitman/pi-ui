/**
 * VAPID (RFC 8292) application-server identity: one long-lived ECDSA P-256
 * keypair per pi-ui data directory, generated on first use and reused for
 * every push message afterward — a push service uses its public key to
 * recognise repeated senders and rate-limit or block a misbehaving one.
 * Never confused with `aes128gcm.ts`'s ephemeral per-message ECDH keypair.
 */
import { generateKeyPairSync } from "node:crypto";

import { appDataPath } from "../../utils/app-dirs.ts";
import { isNotFound } from "../../utils/fs-errors.ts";
import { writeSecretFile } from "../../utils/secret-file.ts";

export interface VapidKeyPair {
	/** 65-byte uncompressed P-256 point (0x04 || X || Y) — the `applicationServerKey`
	 * a browser's `PushManager.subscribe` needs, and the VAPID header's `k=` value. */
	readonly publicKeyRaw: Buffer;
	/** 32-byte big-endian private scalar. */
	readonly privateKeyD: Buffer;
}

interface StoredVapidKeys {
	publicKeyRaw: string;
	privateKeyD: string;
}

export function vapidKeysPath(): string {
	return appDataPath("push-vapid-keys.json");
}

function isStoredVapidKeys(value: unknown): value is StoredVapidKeys {
	if (!value || typeof value !== "object") return false;
	// SAFETY: only used to read two fields for a `typeof === "string"` check each;
	// the function returns false below unless both checks pass, so a value that
	// isn't actually a `StoredVapidKeys` is never treated as one by any caller.
	const candidate = value as Partial<StoredVapidKeys>;
	return (
		typeof candidate.publicKeyRaw === "string" &&
		typeof candidate.privateKeyD === "string"
	);
}

function decode(stored: StoredVapidKeys): VapidKeyPair {
	return {
		publicKeyRaw: Buffer.from(stored.publicKeyRaw, "base64url"),
		privateKeyD: Buffer.from(stored.privateKeyD, "base64url"),
	};
}

async function readStoredKeys(path: string): Promise<VapidKeyPair | undefined> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isStoredVapidKeys(parsed) ? decode(parsed) : undefined;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function generateVapidKeyPair(): VapidKeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	// SAFETY: a P-256 (`prime256v1`) `KeyObject`'s JWK export always carries its
	// coordinates/scalar as base64url strings (RFC 7518 §6.2) — Node's `JsonWebKey`
	// type only leaves them optional because the same type covers every key kind.
	const publicJwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
	// SAFETY: same as above — a P-256 private `KeyObject`'s JWK export always
	// carries its scalar `d` as a base64url string.
	const privateJwk = privateKey.export({ format: "jwk" }) as { d: string };
	return {
		publicKeyRaw: Buffer.concat([
			Uint8Array.of(4),
			Buffer.from(publicJwk.x, "base64url"),
			Buffer.from(publicJwk.y, "base64url"),
		]),
		privateKeyD: Buffer.from(privateJwk.d, "base64url"),
	};
}

/**
 * Loads the persisted VAPID keypair, or generates and persists a new one on
 * first use. Concurrent first-use callers (e.g. two requests racing at
 * startup) converge on whichever one wins the exclusive create in
 * `writeSecretFile`: the loser re-reads the winner's file instead of using
 * its own discarded keypair.
 */
export async function loadOrCreateVapidKeys(
	path: string = vapidKeysPath(),
): Promise<VapidKeyPair> {
	const existing = await readStoredKeys(path);
	if (existing) return existing;

	const generated = generateVapidKeyPair();
	const serialized = JSON.stringify({
		publicKeyRaw: generated.publicKeyRaw.toString("base64url"),
		privateKeyD: generated.privateKeyD.toString("base64url"),
	} satisfies StoredVapidKeys);
	try {
		await writeSecretFile(path, serialized);
		return generated;
	} catch {
		// Lost a startup race with a concurrent creator; use what they wrote.
		const written = await readStoredKeys(path);
		if (written) return written;
		throw new Error(`Failed to create or read VAPID keys at ${path}`);
	}
}

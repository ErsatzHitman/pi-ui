// An optional username/password login in front of the auth token (request-auth.ts). The
// token stays the one server secret every request is checked against — the session
// cookie still carries it, and Bearer/`?token=` still work for scripts — but a person
// signing in from a browser types a username and password instead of a 64-character
// token. `pi-ui login set <username>` (server-main.ts) writes the file; the server reads
// it on every sign-in attempt, so setting or changing the password needs no restart.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import Type from "typebox";
import { Compile } from "typebox/compile";

import { timingSafeEqualStrings } from "./request-auth.ts";

export interface LoginCredentials {
	username: string;
	/** Bun.password (argon2id) hash; the password itself is never stored. */
	passwordHash: string;
}

const loginCredentialsValidator = Compile(
	Type.Object({
		username: Type.String({ minLength: 1 }),
		passwordHash: Type.String({ minLength: 1 }),
	}),
);

export const minimumPasswordLength = 8;

export async function readLoginCredentials(
	path: string,
): Promise<LoginCredentials | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (loginCredentialsValidator.Check(parsed))
			return { username: parsed.username, passwordHash: parsed.passwordHash };
	} catch {
		// Fall through: a corrupt file is the same as no login configured.
	}
	return undefined;
}

export function validateUsername(username: string): string | undefined {
	if (!username.trim()) return "The username can't be empty.";
	if (username !== username.trim())
		return "The username can't start or end with spaces.";
	if (username.length > 64) return "The username can be at most 64 characters.";
	return undefined;
}

export function validatePassword(password: string): string | undefined {
	if (password.length < minimumPasswordLength)
		return `The password must be at least ${minimumPasswordLength} characters.`;
	return undefined;
}

/** Hashes `password` and writes the login atomically, readable only by this user. */
export async function writeLoginCredentials(
	path: string,
	username: string,
	password: string,
): Promise<void> {
	const problem = validateUsername(username) ?? validatePassword(password);
	if (problem) throw new Error(problem);
	const credentials: LoginCredentials = {
		username,
		passwordHash: await Bun.password.hash(password),
	};
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(credentials, null, "\t")}\n`, {
		mode: 0o600,
	});
	// `mode` only applies when writeFile creates the file; chmod covers a leftover temp.
	await chmod(temp, 0o600).catch(() => undefined);
	await rename(temp, path);
}

export async function removeLoginCredentials(path: string): Promise<boolean> {
	const existed = (await readLoginCredentials(path)) !== undefined;
	await rm(path, { force: true });
	return existed;
}

/**
 * True when both match. The password hash is verified even for a wrong username, so a
 * response's timing doesn't reveal whether the username alone was right.
 */
export async function verifyLogin(
	credentials: LoginCredentials,
	username: string,
	password: string,
): Promise<boolean> {
	const usernameMatches = timingSafeEqualStrings(username, credentials.username);
	let passwordMatches = false;
	try {
		passwordMatches = await Bun.password.verify(password, credentials.passwordHash);
	} catch {
		passwordMatches = false;
	}
	return usernameMatches && passwordMatches;
}

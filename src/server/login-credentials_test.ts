import { test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assert, assertEquals, assertFalse, assertRejects } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import {
	readLoginCredentials,
	removeLoginCredentials,
	verifyLogin,
	writeLoginCredentials,
} from "./login-credentials.ts";

async function credentialsFile(): Promise<string> {
	return join(await makeTempDir({ prefix: "pi-ui-login-" }), "nested", "login.json");
}

test("a written login verifies only with its exact username and password", async () => {
	const path = await credentialsFile();
	await writeLoginCredentials(path, "akshat", "correct horse");
	const credentials = await readLoginCredentials(path);
	assert(credentials !== undefined, "expected saved credentials");
	assertEquals(credentials.username, "akshat");
	assert(
		!credentials.passwordHash.includes("correct horse"),
		"password stored in clear",
	);
	assert(await verifyLogin(credentials, "akshat", "correct horse"));
	assertFalse(await verifyLogin(credentials, "akshat", "wrong horse"));
	assertFalse(await verifyLogin(credentials, "someone", "correct horse"));
	assertFalse(await verifyLogin(credentials, "", ""));
});

test("the login file is readable only by its owner", async () => {
	if (process.platform === "win32") return;
	const path = await credentialsFile();
	await writeLoginCredentials(path, "akshat", "correct horse");
	assertEquals((await stat(path)).mode & 0o777, 0o600);
});

test("a missing or corrupt login file means no login is configured", async () => {
	const path = await credentialsFile();
	assertEquals(await readLoginCredentials(path), undefined);
	await writeLoginCredentials(path, "akshat", "correct horse");
	await writeFile(path, '{"username": "akshat"}');
	assertEquals(await readLoginCredentials(path), undefined);
	await writeFile(path, "{");
	assertEquals(await readLoginCredentials(path), undefined);
});

test("short passwords and blank usernames are refused", async () => {
	const path = await credentialsFile();
	await assertRejects(() => writeLoginCredentials(path, "akshat", "short"));
	await assertRejects(() => writeLoginCredentials(path, "  ", "correct horse"));
	assertEquals(await readLoginCredentials(path), undefined);
});

test("removing a login reports whether one existed", async () => {
	const path = await credentialsFile();
	assertFalse(await removeLoginCredentials(path));
	await writeLoginCredentials(path, "akshat", "correct horse");
	assert(await removeLoginCredentials(path));
	assertEquals(await readLoginCredentials(path), undefined);
});

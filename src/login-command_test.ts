import { test } from "bun:test";
import { join } from "node:path";

import { assert, assertEquals, assertRejects } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { type LoginCommandIo, runLoginCommand } from "./login-command.ts";
import { readLoginCredentials, verifyLogin } from "./server/login-credentials.ts";

function fakeIo(
	secrets: string[],
	interactive = true,
): LoginCommandIo & { lines: string[] } {
	const lines: string[] = [];
	return {
		interactive,
		lines,
		log: (message) => lines.push(message),
		readSecret: async () => secrets.shift() ?? "",
	};
}

async function loginFile(): Promise<string> {
	return join(await makeTempDir({ prefix: "pi-ui-login-cmd-" }), "login.json");
}

test("login set saves a login that verifies with the typed password", async () => {
	const path = await loginFile();
	await runLoginCommand(
		["set", "akshat"],
		path,
		fakeIo(["correct horse", "correct horse"]),
	);
	const credentials = await readLoginCredentials(path);
	assert(credentials !== undefined, "expected a saved login");
	assert(await verifyLogin(credentials, "akshat", "correct horse"));
});

test("login set refuses mismatched confirmation and saves nothing", async () => {
	const path = await loginFile();
	await assertRejects(() =>
		runLoginCommand(
			["set", "akshat"],
			path,
			fakeIo(["correct horse", "other horse"]),
		),
	);
	assertEquals(await readLoginCredentials(path), undefined);
});

test("login set reads the password once when piped", async () => {
	const path = await loginFile();
	await runLoginCommand(["set", "akshat"], path, fakeIo(["correct horse"], false));
	assert((await readLoginCredentials(path)) !== undefined, "expected a saved login");
});

test("login status and remove report the saved login", async () => {
	const path = await loginFile();
	const io = fakeIo(["correct horse", "correct horse"]);
	await runLoginCommand(["status"], path, io);
	await runLoginCommand(["set", "akshat"], path, io);
	await runLoginCommand(["status"], path, io);
	await runLoginCommand(["remove"], path, io);
	await runLoginCommand(["status"], path, io);
	assert(io.lines[0]?.startsWith("No pi-ui login is set") ?? false, io.lines[0]);
	assert(io.lines[2]?.includes('"akshat"') ?? false, io.lines[2]);
	assertEquals(io.lines[3], "pi-ui login removed");
	assert(io.lines[4]?.startsWith("No pi-ui login is set") ?? false, io.lines[4]);
});

test("unknown login actions print the usage", async () => {
	await assertRejects(() => runLoginCommand(["frobnicate"], "unused", fakeIo([])));
	await assertRejects(() => runLoginCommand(["set"], "unused", fakeIo([])));
});

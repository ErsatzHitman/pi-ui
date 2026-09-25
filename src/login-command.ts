// `pi-ui login set <username>|remove|status`: manages the username/password login the
// remote sign-in page asks for (server/login-credentials.ts). Run on the server itself,
// e.g. over SSH; a running server picks the change up on its next sign-in attempt.
import {
	readLoginCredentials,
	removeLoginCredentials,
	validatePassword,
	validateUsername,
	writeLoginCredentials,
} from "./server/login-credentials.ts";
import { loginCredentialsPath } from "./utils/app-dirs.ts";

export const loginUsage = `usage: pi-ui login set <username>   set the sign-in username and password
       pi-ui login remove           remove it (sign in with the access token again)
       pi-ui login status           show whether a login is set

The password is read without echo from the terminal, or from stdin when piped
(first line). It is stored only as an argon2id hash.`;

export interface LoginCommandIo {
	/** Reads one secret line: hidden when interactive, the first stdin line when piped. */
	readSecret(prompt: string): Promise<string>;
	/** False when stdin is piped, so the password is read once without confirmation. */
	interactive: boolean;
	log(message: string): void;
}

export async function runLoginCommand(
	args: readonly string[],
	path: string = loginCredentialsPath(),
	io: LoginCommandIo = terminalIo(),
): Promise<void> {
	const [action, ...rest] = args;
	if (action === "set" && rest.length === 1) {
		const username = rest[0] ?? "";
		const usernameProblem = validateUsername(username);
		if (usernameProblem) throw new Error(usernameProblem);
		const password = await io.readSecret("Password: ");
		const passwordProblem = validatePassword(password);
		if (passwordProblem) throw new Error(passwordProblem);
		if (io.interactive) {
			const confirmation = await io.readSecret("Repeat password: ");
			if (confirmation !== password) throw new Error("The passwords don't match.");
		}
		await writeLoginCredentials(path, username, password);
		io.log(`pi-ui login set for "${username}" (${path})`);
	} else if (action === "remove" && rest.length === 0) {
		const removed = await removeLoginCredentials(path);
		io.log(removed ? "pi-ui login removed" : "No pi-ui login was set");
	} else if (action === "status" && rest.length === 0) {
		const credentials = await readLoginCredentials(path);
		io.log(
			credentials
				? `pi-ui login is set for "${credentials.username}" (${path})`
				: "No pi-ui login is set; the sign-in page asks for the access token",
		);
	} else {
		throw new Error(loginUsage);
	}
}

function terminalIo(): LoginCommandIo {
	const interactive = process.stdin.isTTY === true;
	let pipedLines: Promise<string[]> | undefined;
	return {
		interactive,
		log: (message) => console.log(message),
		async readSecret(prompt) {
			if (!interactive) {
				pipedLines ??= Bun.stdin.text().then((text) => text.split(/\r?\n/));
				return (await pipedLines).shift() ?? "";
			}
			return readHiddenLine(prompt);
		},
	};
}

function readHiddenLine(prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		process.stdout.write(prompt);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		let value = "";
		const finish = (error?: Error) => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stdout.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: string) => {
			for (const character of chunk) {
				if (character === "\r" || character === "\n") return finish();
				if (character === "\u0003") return finish(new Error("Cancelled."));
				if (character === "\u007f" || character === "\b")
					value = value.slice(0, -1);
				else if (character >= " ") value += character;
			}
		};
		stdin.on("data", onData);
	});
}

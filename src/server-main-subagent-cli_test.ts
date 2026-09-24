import { afterEach, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertEquals, assertFalse, assertStringIncludes } from "#testing/assertions";
import { writeFakeStreamProviderExtensionFile } from "#testing/fake-stream-provider";

// subagents stream (PLAN-ux.md "subagents — sub-agents don't work under pi-ui"): this is
// the real-world reproduction of the bug `isPiCliPassthrough` (server-main.ts) fixes —
// spawns this repo's actual `src/server-main.ts` entry point with EXACTLY the argv shape
// `~/.pi/agent/extensions/subagents.ts` `piInvocation()` + `runJob()` hand it for a
// sub-agent child (see its `args` construction: `--mode json -p --no-session
// --no-extensions --no-skills [--no-tools] --append-system-prompt <file> <task>`), the way
// a real sub-agent child process is invoked when the running program is pi-ui. Before the
// fix this died immediately with "unknown option: --mode" (`parseServerOptions`) instead of
// running a turn; JSON-mode session events never appeared on stdout.
//
// Isolated per the plan's testing rules: a scratch PI_CODING_AGENT_DIR/HOME/APPDATA/
// LOCALAPPDATA, the offline fake-stream provider (`-e <path>` survives `--no-extensions`,
// exactly like a sub-agent profile's own allowed-extensions list), never a real model.

const cleanupDirs: string[] = [];

afterEach(async () => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

test("a sub-agent child's exact argv now runs a real (fake-model) turn instead of dying with `unknown option: --mode`", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "pi-ui-subagent-cli-"));
	cleanupDirs.push(scratch);
	const agentDir = join(scratch, "agent");
	const homeDir = join(scratch, "home");
	const appData = join(scratch, "appdata");
	const localAppData = join(scratch, "localappdata");

	const extensionPath = await writeFakeStreamProviderExtensionFile(agentDir);

	const repoRoot = join(import.meta.dir, "..");
	// This is the exact shape `runJob()` builds (minus the real temp prompt file/task,
	// which need this test's own scratch dir): --no-extensions with an explicit -e is
	// how a sub-agent's `options.launch.extensions` allowlist survives it, same as here.
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"-e",
		extensionPath,
		"--model",
		"pi-ui-fake-stream/scripted-1",
		"Say hello. [[TEXT:subagent-cli-smoke]]",
	];

	const proc = Bun.spawn({
		cmd: [process.execPath, "src/server-main.ts", ...args],
		cwd: repoRoot,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			HOME: homeDir,
			USERPROFILE: homeDir,
			APPDATA: appData,
			LOCALAPPDATA: localAppData,
			PI_UI_NO_UPDATE_CHECK: "1",
			PI_OFFLINE: "1",
			// Never call a real model: strip any provider credentials from the test runner's
			// own environment so a misconfigured PATH/env can't smuggle one in.
			ANTHROPIC_API_KEY: "",
			OPENAI_API_KEY: "",
			GEMINI_API_KEY: "",
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	assertFalse(
		stderr.includes("unknown option"),
		`sub-agent argv was mis-parsed as a pi-ui server flag: ${stderr}`,
	);
	assertEquals(exitCode, 0, `pi CLI exited non-zero; stderr: ${stderr}`);

	const events = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { type?: string; message?: unknown });

	const messageEnd = events.find(
		(event) =>
			event.type === "message_end" &&
			(event.message as { role?: string } | undefined)?.role === "assistant",
	);
	const text = JSON.stringify(messageEnd);
	assertStringIncludes(text, "Fake reply: subagent-cli-smoke");
}, 30_000);

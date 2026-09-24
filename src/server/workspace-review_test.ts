import { test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

import { assertEquals } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { outputCommand } from "../utils/command.ts";
import {
	areWorkspacePathsIgnored,
	findGitRoot,
	findGitWatchPaths,
	parseCommitLog,
	parseNameStatus,
	parsePorcelainStatus,
	readWorkspaceReview,
	type WorkspaceReviewMetadataCache,
} from "./workspace-review.ts";

test("ignore checks require every path to be ignored and respect tracked files and exceptions", async () => {
	const workspace = await makeTempDir();
	try {
		await git(workspace, "init");
		await Bun.write(`${workspace}/.gitignore`, "*.log\n!important.log\n");
		await Bun.write(`${workspace}/tracked.log`, "tracked\n");
		await git(workspace, "add", "-f", "tracked.log");
		assertEquals(
			await areWorkspacePathsIgnored(workspace, ["a.log", "odd\nname.log"]),
			true,
		);
		assertEquals(
			await areWorkspacePathsIgnored(workspace, ["a.log", "important.log"]),
			false,
		);
		assertEquals(
			await areWorkspacePathsIgnored(workspace, ["a.log", "tracked.log"]),
			false,
		);
		assertEquals(await areWorkspacePathsIgnored(workspace, []), false);
		assertEquals(
			await areWorkspacePathsIgnored(`${workspace}/missing`, ["a.log"]),
			false,
		);
	} finally {
		await rm(workspace, { recursive: true });
	}
});

test("reused metadata preserves content updates and retries an unborn history", async () => {
	const workspace = await makeTempDir();
	const cache: WorkspaceReviewMetadataCache = {};
	try {
		await git(workspace, "init");
		await git(workspace, "config", "user.email", "pi-ui@example.test");
		await git(workspace, "config", "user.name", "pi-ui");
		assertEquals((await readWorkspaceReview(workspace, cache)).commits, []);
		await Bun.write(`${workspace}/file.txt`, "initial\n");
		await git(workspace, "add", ".");
		await git(workspace, "commit", "-m", "initial");
		assertEquals(
			await readWorkspaceReview(workspace, cache),
			await readWorkspaceReview(workspace),
		);
		for (const contents of ["first edit\n", "second edit\n", "initial\n"]) {
			await Bun.write(`${workspace}/file.txt`, contents);
			assertEquals(
				await readWorkspaceReview(workspace, cache),
				await readWorkspaceReview(workspace),
			);
		}
	} finally {
		await rm(workspace, { recursive: true });
	}
});

test("porcelain status parsing keeps rename destinations and status precedence", () => {
	assertEquals(
		parsePorcelainStatus(
			"R  src/new.ts\0src/old.ts\0?? notes.txt\0 D deleted.ts\0AM added.ts\0",
		),
		[
			{ additions: 0, deletions: 0, path: "src/new.ts", status: "renamed" },
			{ additions: 0, deletions: 0, path: "notes.txt", status: "untracked" },
			{ additions: 0, deletions: 0, path: "deleted.ts", status: "deleted" },
			{ additions: 0, deletions: 0, path: "added.ts", status: "added" },
		],
	);
});

test("commit metadata and name-status parsing preserve Git data", () => {
	assertEquals(
		parseCommitLog(
			"0123456789012345678901234567890123456789\x1f0123456\x1fAda\x1f2026-07-20T12:00:00Z\x1ffeat: ship\x1e",
			new Set(["0123456789012345678901234567890123456789"]),
		),
		[
			{
				author: "Ada",
				authoredAt: "2026-07-20T12:00:00Z",
				hash: "0123456789012345678901234567890123456789",
				pushed: false,
				shortHash: "0123456",
				subject: "feat: ship",
			},
		],
	);
	assertEquals(parseNameStatus("M\0README.md\0R100\0old.ts\0new.ts\0"), [
		{ additions: 0, deletions: 0, path: "README.md", status: "modified" },
		{ additions: 0, deletions: 0, path: "new.ts", status: "renamed" },
	]);
});

test("workspace review combines repository files with tracked and untracked changes", async () => {
	const repository = await makeGitRepository();
	try {
		await mkdir(`${repository}/src`);
		await Bun.write(`${repository}/src/old.ts`, "export const old = 1;\n");
		await Bun.write(`${repository}/README.md`, "before\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "--quiet", "-m", "initial");

		await git(repository, "mv", "src/old.ts", "src/new.ts");
		await Bun.write(`${repository}/README.md`, "after\n");
		await Bun.write(`${repository}/notes.txt`, "untracked\n");

		const nestedWorkspace = `${repository}/src`;
		// `git rev-parse` always normalizes to forward slashes, even on Windows,
		// so compare against the same normalized form rather than the raw
		// (backslash-separated, on Windows) temp dir path.
		const canonicalRepository = repository.replaceAll("\\", "/");
		assertEquals(await findGitRoot(nestedWorkspace), canonicalRepository);
		assertEquals(await findGitWatchPaths(nestedWorkspace), [canonicalRepository]);
		const snapshot = await readWorkspaceReview(nestedWorkspace);
		assertEquals(snapshot.isGitRepository, true);
		assertEquals(snapshot.changeCount, 3);
		assertEquals(snapshot.commits.length, 1);
		assertEquals(Boolean(snapshot.branch), true);
		assertEquals(snapshot.commits[0].subject, "initial");
		assertEquals(snapshot.commits[0].pushed, null);
		assertEquals(snapshot.changes, [
			{
				additions: 0,
				deletions: 0,
				path: "src/new.ts",
				status: "renamed",
			},
			{
				additions: 0,
				deletions: 0,
				path: "notes.txt",
				status: "untracked",
			},
			{
				additions: 1,
				deletions: 1,
				path: "README.md",
				status: "modified",
			},
		]);
		assertEquals("patch" in snapshot, false);
		assertEquals(snapshot.revision.length, 64);

		await Bun.write(`${repository}/notes.txt`, "changed again\n");
		const updated = await readWorkspaceReview(repository);
		assertEquals(updated.revision, snapshot.revision);
	} finally {
		await rm(repository, { recursive: true });
	}
});

test("large untracked trees stay metadata-only", async () => {
	const repository = await makeGitRepository();
	try {
		await Bun.write(
			`${repository}/node_modules/large.js`,
			"x".repeat(4 * 1024 * 1024),
		);
		await Promise.all(
			Array.from({ length: 120 }, (_, index) =>
				Bun.write(
					`${repository}/node_modules/${index}.js`,
					`export const n = ${index};\n`,
				),
			),
		);
		// A filename with brackets, a space, and a non-ASCII character —
		// deliberately unusual, but a literal tab (0x09) is a reserved
		// control character NTFS refuses to create, so it's avoided here.
		await Bun.write(`${repository}/[new] café file.txt`, "visible new file\n");
		const snapshot = await readWorkspaceReview(repository);
		assertEquals(snapshot.changes.length, 122);
		assertEquals(snapshot.changeCount, 2);
		assertEquals("patch" in snapshot, false);
		await Bun.write(`${repository}/.gitignore`, "node_modules/\n");
		await git(repository, "add", "-f", "node_modules/0.js");
		assertEquals(
			(await readWorkspaceReview(repository)).changes
				.map((file) => file.path)
				.sort(),
			[".gitignore", "[new] café file.txt", "node_modules/0.js"],
		);
	} finally {
		await rm(repository, { recursive: true });
	}
});

test("workspace review reports non-repositories without throwing", async () => {
	const workspace = await makeTempDir();
	try {
		const snapshot = await readWorkspaceReview(workspace);
		assertEquals(snapshot.isGitRepository, false);
		assertEquals(snapshot.changes, []);
		assertEquals(snapshot.commits, []);
		assertEquals("patch" in snapshot, false);
		assertEquals(snapshot.revision, "non-git");
	} finally {
		await rm(workspace, { recursive: true });
	}
});

async function makeGitRepository(): Promise<string> {
	const repository = await makeTempDir();
	await git(repository, "init", "--quiet");
	await git(repository, "config", "user.email", "pi-ui@example.invalid");
	await git(repository, "config", "user.name", "pi-ui test");
	// Pin line-ending behavior for this repo regardless of the machine's global
	// git config: a global `core.autocrlf=true` (common on Windows) would
	// silently convert the `\n` fixtures below to `\r\n`, which is a machine
	// setting, not something this suite tests.
	await git(repository, "config", "core.autocrlf", "false");
	return repository;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const output = await outputCommand("git", {
		args: ["-C", cwd, ...args],
	});
	if (!output.success) {
		throw new Error(new TextDecoder().decode(output.stderr));
	}
}

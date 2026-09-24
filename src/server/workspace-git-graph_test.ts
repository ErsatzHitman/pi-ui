import { test } from "bun:test";
import { rm } from "node:fs/promises";

import { assertEquals } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { outputCommand } from "../utils/command.ts";
import {
	findWorkspaceGitGraphMainBranch,
	parseGitBranches,
	parseGitGraphLog,
	readWorkspaceGitGraph,
	readWorkspaceGitGraphCommit,
} from "./workspace-git-graph.ts";

test("git graph log parsing reads hash, parents, refs and subject", () => {
	assertEquals(
		parseGitGraphLog(
			"aaaa\x1faaa\x1fAda\x1f2026-07-20T12:00:00Z\x1fbbbb cccc\x1fHEAD -> main, tag: v1\x1ffeat: merge\x1e" +
				"bbbb\x1fbbb\x1fAda\x1f2026-07-19T12:00:00Z\x1f\x1f\x1froot commit\x1e",
		),
		[
			{
				author: "Ada",
				authoredAt: "2026-07-20T12:00:00Z",
				decoration: "HEAD -> main, tag: v1",
				hash: "aaaa",
				parents: ["bbbb", "cccc"],
				shortHash: "aaa",
				subject: "feat: merge",
			},
			{
				author: "Ada",
				authoredAt: "2026-07-19T12:00:00Z",
				decoration: "",
				hash: "bbbb",
				parents: [],
				shortHash: "bbb",
				subject: "root commit",
			},
		],
	);
});

test("branch list parsing reads tip hash, upstream and ahead/behind, and marks current/main", () => {
	assertEquals(
		parseGitBranches(
			"aaaa\x09main\x09origin/main\x09\n" +
				"bbbb\x09feature\x09origin/feature\x09[ahead 2, behind 1]\n" +
				"cccc\x09solo\x09\x09\n" +
				"dddd\x09stale\x09origin/stale\x09[gone]\n",
			"feature",
			"main",
		),
		[
			{
				ahead: 0,
				behind: 0,
				current: false,
				hash: "aaaa",
				main: true,
				name: "main",
				upstream: "origin/main",
			},
			{
				ahead: 2,
				behind: 1,
				current: true,
				hash: "bbbb",
				main: false,
				name: "feature",
				upstream: "origin/feature",
			},
			{
				ahead: 0,
				behind: 0,
				current: false,
				hash: "cccc",
				main: false,
				name: "solo",
				upstream: null,
			},
			{
				ahead: 0,
				behind: 0,
				current: false,
				hash: "dddd",
				main: false,
				name: "stale",
				upstream: "origin/stale",
			},
		],
	);
	assertEquals(parseGitBranches("", null, null), []);
});

test("git graph reports non-repositories without throwing", async () => {
	const workspace = await makeTempDir();
	try {
		const snapshot = await readWorkspaceGitGraph(workspace);
		assertEquals(snapshot.isGitRepository, false);
		assertEquals(snapshot.rows, []);
		assertEquals(snapshot.branches, []);
		assertEquals(snapshot.revision, "non-git");
		assertEquals(
			await readWorkspaceGitGraphCommit(workspace, "a".repeat(40)),
			undefined,
		);
	} finally {
		await rm(workspace, { recursive: true });
	}
});

test("git graph lays out a merged feature branch with refs and detects main", async () => {
	const repository = await makeGitRepository();
	try {
		await Bun.write(`${repository}/file.txt`, "base\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "base");
		await git(repository, "checkout", "-b", "feature");
		await Bun.write(`${repository}/feature.txt`, "feature\n");
		await git(repository, "add", ".");
		await git(
			repository,
			"commit",
			"-m",
			"feature work",
			"-m",
			"Why: the body line.\nSecond body line.",
		);
		await git(repository, "checkout", "main");
		await Bun.write(`${repository}/main.txt`, "main\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "main work");
		await git(repository, "merge", "--no-ff", "-m", "merge feature", "feature");
		await git(repository, "tag", "v1.0.0");

		const snapshot = await readWorkspaceGitGraph(repository);
		assertEquals(snapshot.isGitRepository, true);
		assertEquals(snapshot.branch, "main");
		assertEquals(snapshot.mainBranch, "main");
		assertEquals(snapshot.hasMore, false);
		assertEquals(snapshot.laneCount, 2);
		assertEquals(
			snapshot.rows.map((row) => row.subject),
			["merge feature", "feature work", "main work", "base"],
		);
		const merge = snapshot.rows[0]!;
		assertEquals(merge.lane, 0);
		assertEquals(merge.parents.length, 2);
		assertEquals(
			merge.refs.some((ref) => ref.name === "main" && ref.current && ref.main),
			true,
		);
		assertEquals(
			merge.refs.some((ref) => ref.name === "v1.0.0" && ref.kind === "tag"),
			true,
		);
		const feature = snapshot.rows[1]!;
		assertEquals(feature.subject, "feature work");
		assertEquals(feature.lane, 1);
		assertEquals(
			feature.refs.some((ref) => ref.name === "feature"),
			true,
		);

		const detail = await readWorkspaceGitGraphCommit(repository, merge.hash);
		assertEquals(detail?.subject, "merge feature");
		assertEquals(detail?.body, "");
		assertEquals(detail?.parents.length, 2);
		assertEquals(
			detail?.changes.some((change) => change.path === "feature.txt"),
			true,
		);
		// The detail shows the full message, not just the row's subject line.
		const featureDetail = await readWorkspaceGitGraphCommit(repository, feature.hash);
		assertEquals(featureDetail?.subject, "feature work");
		assertEquals(featureDetail?.body, "Why: the body line.\nSecond body line.");
	} finally {
		await rm(repository, { recursive: true });
	}
});

test("git graph honours a bounded page size and reports more history", async () => {
	const repository = await makeGitRepository();
	try {
		for (let index = 0; index < 5; index++) {
			await Bun.write(`${repository}/file.txt`, `${index}\n`);
			await git(repository, "add", ".");
			await git(repository, "commit", "-m", `commit ${index}`);
		}
		const snapshot = await readWorkspaceGitGraph(repository, 3);
		assertEquals(snapshot.rows.length, 3);
		assertEquals(snapshot.hasMore, true);
		assertEquals(
			snapshot.rows.map((row) => row.subject),
			["commit 4", "commit 3", "commit 2"],
		);
	} finally {
		await rm(repository, { recursive: true });
	}
});

test("git graph reports a detached HEAD as its own ref and branch label", async () => {
	const repository = await makeGitRepository();
	try {
		await Bun.write(`${repository}/file.txt`, "base\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "base");
		await Bun.write(`${repository}/file.txt`, "second\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "second");
		const headOutput = await outputCommand("git", {
			args: ["-C", repository, "rev-parse", "HEAD"],
		});
		const head = new TextDecoder().decode(headOutput.stdout).trim();
		await git(repository, "checkout", "--detach", "HEAD");

		const snapshot = await readWorkspaceGitGraph(repository);
		assertEquals(snapshot.isGitRepository, true);
		assertEquals(snapshot.branch, `detached@${head.slice(0, 7)}`);
		assertEquals(
			snapshot.rows.map((row) => row.subject),
			["second", "base"],
		);
		const detached = snapshot.rows[0]!;
		assertEquals(
			detached.refs.some(
				(ref) => ref.kind === "head" && ref.current && ref.name === "HEAD",
			),
			true,
		);
	} finally {
		await rm(repository, { recursive: true });
	}
});

test("git graph lays out a shallow clone's grafted boundary commit like a root", async () => {
	const origin = await makeGitRepository();
	const clone = await makeTempDir();
	try {
		for (let index = 0; index < 4; index++) {
			await Bun.write(`${origin}/file.txt`, `${index}\n`);
			await git(origin, "add", ".");
			await git(origin, "commit", "-m", `commit ${index}`);
		}
		await rm(clone, { recursive: true });
		await git(".", "clone", "--quiet", "--depth", "2", "--no-local", origin, clone);

		const snapshot = await readWorkspaceGitGraph(clone);
		assertEquals(snapshot.isGitRepository, true);
		assertEquals(
			snapshot.rows.map((row) => row.subject),
			["commit 3", "commit 2"],
		);
		// The shallow boundary commit ("commit 2") is grafted: Git reports it
		// with no parents, same as a genuine root commit, and the graph must
		// lay it out (and stop) without treating the missing parent as an error.
		assertEquals(snapshot.rows.at(-1)!.parents, []);
		assertEquals(snapshot.laneCount, 1);
	} finally {
		await rm(origin, { recursive: true });
		await rm(clone, { recursive: true, force: true });
	}
});

test("main branch detection falls back from origin/HEAD to a local main or master", async () => {
	const repository = await makeGitRepository();
	try {
		assertEquals(await findWorkspaceGitGraphMainBranch(repository), null);
		await Bun.write(`${repository}/file.txt`, "base\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "base");
		assertEquals(await findWorkspaceGitGraphMainBranch(repository), "main");
	} finally {
		await rm(repository, { recursive: true });
	}
});

test("git graph snapshot lists local branches with current/main flags and real upstream ahead/behind", async () => {
	const origin = await makeTempDir();
	const repository = await makeGitRepository();
	try {
		await git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
		await Bun.write(`${repository}/file.txt`, "base\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "base");
		await git(repository, "remote", "add", "origin", origin);
		await git(repository, "push", "-u", "origin", "main");
		await git(repository, "checkout", "-b", "feature");
		await Bun.write(`${repository}/file.txt`, "ahead\n");
		await git(repository, "commit", "-am", "ahead");
		await git(repository, "push", "-u", "origin", "feature");
		// A second local commit on main that main's own upstream never sees puts
		// main ahead of origin/main by 1, independent of the checked-out branch.
		await git(repository, "checkout", "main");
		await Bun.write(`${repository}/other.txt`, "more\n");
		await git(repository, "add", ".");
		await git(repository, "commit", "-m", "unpushed");
		await git(repository, "checkout", "feature");

		const snapshot = await readWorkspaceGitGraph(repository);
		assertEquals(snapshot.branch, "feature");
		assertEquals(snapshot.mainBranch, "main");
		const byName = new Map(snapshot.branches.map((branch) => [branch.name, branch]));
		assertEquals(byName.get("feature")?.current, true);
		assertEquals(byName.get("feature")?.main, false);
		assertEquals(byName.get("feature")?.upstream, "origin/feature");
		assertEquals(byName.get("feature")?.ahead, 0);
		assertEquals(byName.get("feature")?.behind, 0);
		assertEquals(byName.get("main")?.current, false);
		assertEquals(byName.get("main")?.main, true);
		assertEquals(byName.get("main")?.ahead, 1);
		assertEquals(byName.get("main")?.behind, 0);
	} finally {
		await rm(repository, { recursive: true });
		await rm(origin, { recursive: true });
	}
});

async function makeGitRepository(): Promise<string> {
	const repository = await makeTempDir();
	await git(repository, "init", "--quiet", "--initial-branch=main");
	await git(repository, "config", "user.email", "pi-ui@example.invalid");
	await git(repository, "config", "user.name", "pi-ui test");
	await git(repository, "config", "core.autocrlf", "false");
	return repository;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const output = await outputCommand("git", { args: ["-C", cwd, ...args] });
	if (!output.success) {
		throw new Error(new TextDecoder().decode(output.stderr));
	}
}

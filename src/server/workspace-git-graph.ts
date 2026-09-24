import { outputCommand } from "../utils/command.ts";
import { isNotFound } from "../utils/fs-errors.ts";
import { layoutGitGraphLanes, parseGitGraphRefs } from "../workspace-git-graph-layout.ts";
import {
	emptyWorkspaceGitGraphSnapshot,
	type GitGraphRow,
	type WorkspaceGitGraphCommitDetail,
	workspaceGitGraphPageSize,
	type WorkspaceGitGraphSnapshot,
} from "../workspace-git-graph-types.ts";
import {
	findGitRoot,
	parseNameStatus,
	parsePorcelainStatus,
} from "./workspace-review.ts";
export type {
	GitGraphRef,
	GitGraphRow,
	GitGraphSegment,
	WorkspaceGitGraphCommitDetail,
	WorkspaceGitGraphSnapshot,
} from "../workspace-git-graph-types.ts";

type GitResult = Readonly<{ code: number; stderr: string; stdout: string }>;
const graphLogFormat = "--format=format:%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%D%x1f%s%x1e";
const decoder = new TextDecoder();

type GitGraphLogEntry = Readonly<{
	author: string;
	authoredAt: string;
	decoration: string;
	hash: string;
	parents: readonly string[];
	shortHash: string;
	subject: string;
}>;

export function parseGitGraphLog(output: string): GitGraphLogEntry[] {
	const entries: GitGraphLogEntry[] = [];
	for (const rawRecord of output.split("\x1e")) {
		const record = rawRecord.replace(/^\n+|\n+$/g, "");
		if (!record) continue;
		const [hash, shortHash, author, authoredAt, parents, decoration, subject] =
			record.split("\x1f");
		if (!hash || !shortHash || !authoredAt) continue;
		entries.push({
			author: author ?? "",
			authoredAt,
			decoration: decoration ?? "",
			hash,
			parents: parents ? parents.split(" ").filter(Boolean) : [],
			shortHash,
			subject: subject ?? "",
		});
	}
	return entries;
}

/** Finds the branch `origin/HEAD` (or `main`/`master`) points at, if any. */
export async function findWorkspaceGitGraphMainBranch(
	root: string,
): Promise<string | null> {
	const originHead = await git(
		root,
		"symbolic-ref",
		"--quiet",
		"--short",
		"refs/remotes/origin/HEAD",
	);
	if (originHead.code === 0) {
		const name = originHead.stdout.trim();
		const slash = name.indexOf("/");
		return slash === -1 ? name : name.slice(slash + 1);
	}
	for (const candidate of ["main", "master"]) {
		const exists = await git(
			root,
			"show-ref",
			"--verify",
			"--quiet",
			`refs/heads/${candidate}`,
		);
		if (exists.code === 0) return candidate;
	}
	return null;
}

export async function readWorkspaceGitGraph(
	workspacePath: string,
	pageSize = workspaceGitGraphPageSize,
): Promise<WorkspaceGitGraphSnapshot> {
	const root = await findGitRoot(workspacePath);
	if (!root) return emptyWorkspaceGitGraphSnapshot;
	const [logResult, headResult, branchResult, mainBranch, remotesResult, statusResult] =
		await Promise.all([
			git(
				root,
				"log",
				"--all",
				"--topo-order",
				`-n`,
				String(pageSize + 1),
				graphLogFormat,
			),
			git(root, "rev-parse", "--verify", "HEAD"),
			git(root, "symbolic-ref", "--quiet", "--short", "HEAD"),
			findWorkspaceGitGraphMainBranch(root),
			git(root, "remote"),
			git(root, "status", "--porcelain=v1", "--untracked-files=normal", "-z"),
		]);
	const branch =
		branchResult.code === 0
			? branchResult.stdout.trim()
			: headResult.code === 0
				? `detached@${headResult.stdout.trim().slice(0, 7)}`
				: null;
	const remotes =
		remotesResult.code === 0
			? remotesResult.stdout
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
			: [];
	const entries = logResult.code === 0 ? parseGitGraphLog(logResult.stdout) : [];
	const hasMore = entries.length > pageSize;
	const bounded = hasMore ? entries.slice(0, pageSize) : entries;
	const layout = layoutGitGraphLanes(bounded);
	const rows: GitGraphRow[] = bounded.map((entry, index) => ({
		author: entry.author,
		authoredAt: entry.authoredAt,
		hash: entry.hash,
		lane: layout.rows[index]!.lane,
		parents: entry.parents,
		refs: parseGitGraphRefs(entry.decoration, mainBranch, remotes),
		segments: layout.rows[index]!.segments,
		shortHash: entry.shortHash,
		subject: entry.subject,
	}));
	const changeCount =
		statusResult.code === 0 ? parsePorcelainStatus(statusResult.stdout).length : 0;
	return {
		branch,
		changeCount,
		hasMore,
		isGitRepository: true,
		laneCount: layout.laneCount,
		mainBranch,
		revision: await hash(
			JSON.stringify([
				logResult.stdout,
				headResult.stdout,
				branchResult.stdout,
				mainBranch,
				statusResult.stdout,
				pageSize,
			]),
		),
		rows,
	};
}

export async function readWorkspaceGitGraphCommit(
	workspacePath: string,
	commitHash: string,
): Promise<WorkspaceGitGraphCommitDetail | undefined> {
	if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) return undefined;
	const root = await findGitRoot(workspacePath);
	if (!root) return undefined;
	const [metadataResult, statusResult] = await Promise.all([
		git(root, "show", "-s", graphLogFormat, commitHash),
		git(
			root,
			"diff-tree",
			"--root",
			"--no-commit-id",
			"--name-status",
			"-r",
			"-z",
			"--find-renames",
			"--diff-merges=first-parent",
			commitHash,
		),
	]);
	if (metadataResult.code !== 0 || statusResult.code !== 0) return undefined;
	const entry = parseGitGraphLog(metadataResult.stdout)[0];
	if (!entry) return undefined;
	const numstatResult = await git(
		root,
		"diff-tree",
		"--root",
		"--no-commit-id",
		"--numstat",
		"-r",
		"-z",
		"--find-renames",
		"--diff-merges=first-parent",
		commitHash,
	);
	const stats = new Map<string, { additions: number; deletions: number }>();
	if (numstatResult.code === 0) {
		const records = numstatResult.stdout.split("\0");
		for (let index = 0; index < records.length; index++) {
			const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index] ?? "");
			if (!match) continue;
			let path = match[3]!;
			if (!path) {
				index += 2;
				path = records[index]!;
			}
			stats.set(path, {
				additions: Number(match[1]) || 0,
				deletions: Number(match[2]) || 0,
			});
		}
	}
	const changes = parseNameStatus(statusResult.stdout).map((change) => ({
		additions: stats.get(change.path)?.additions ?? 0,
		deletions: stats.get(change.path)?.deletions ?? 0,
		path: change.path,
		status: change.status === "untracked" ? "added" : change.status,
	}));
	return {
		author: entry.author,
		authoredAt: entry.authoredAt,
		changes,
		hash: entry.hash,
		parents: entry.parents,
		shortHash: entry.shortHash,
		subject: entry.subject,
	};
}

async function hash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return new Uint8Array(digest).toHex();
}

async function git(cwd: string, ...args: string[]): Promise<GitResult> {
	try {
		const output = await outputCommand("git", {
			args: ["-C", cwd, "-c", "core.quotePath=false", ...args],
			env: { GIT_OPTIONAL_LOCKS: "0" },
		});
		return {
			code: output.code,
			stderr: decoder.decode(output.stderr),
			stdout: decoder.decode(output.stdout),
		};
	} catch (error) {
		if (!isNotFound(error)) throw error;
		return { code: 127, stderr: "Git executable not found.", stdout: "" };
	}
}

import { outputCommand } from "../utils/command.ts";
import { isNotFound } from "../utils/fs-errors.ts";
import { sortWorkspaceReviewEntries } from "../workspace-review-tree.ts";
import {
	emptyWorkspaceReviewSnapshot,
	type WorkspaceFileChange,
	type WorkspaceFileStatus,
	type WorkspaceReviewSnapshot,
} from "../workspace-review-types.ts";
export type {
	WorkspaceFileChange,
	WorkspaceReviewSnapshot,
} from "../workspace-review-types.ts";

type GitResult = Readonly<{ code: number; stderr: string; stdout: string }>;
const decoder = new TextDecoder();

/** An inconclusive ignore check must never suppress a workspace refresh. */
export async function areWorkspacePathsIgnored(
	root: string,
	paths: readonly string[],
): Promise<boolean> {
	if (paths.length === 0) return false;
	try {
		const result = await outputCommand("git", {
			args: ["-C", root, "check-ignore", "--stdin", "-z"],
			stdin: new TextEncoder().encode(`${paths.join("\0")}\0`),
		});
		if (!result.success) return false;
		const ignored = new Set(decoder.decode(result.stdout).split("\0"));
		return paths.every((path) => ignored.has(path));
	} catch {
		return false;
	}
}

export async function findGitRoot(workspacePath: string): Promise<string | undefined> {
	const result = await git(workspacePath, "rev-parse", "--show-toplevel");
	return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function findGitWatchPaths(
	workspacePath: string,
): Promise<string[] | undefined> {
	const root = await findGitRoot(workspacePath);
	if (!root) return undefined;
	const [gitDirResult, commonDirResult] = await Promise.all([
		git(root, "rev-parse", "--absolute-git-dir"),
		git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
	]);
	const paths = [root];
	for (const result of [gitDirResult, commonDirResult]) {
		const path = result.code === 0 ? result.stdout.trim() : "";
		if (
			path &&
			path !== root &&
			!path.startsWith(`${root}/`) &&
			!paths.includes(path)
		) {
			paths.push(path);
		}
	}
	return paths;
}

export type WorkspaceReviewMetadataCache = {
	value?: Awaited<ReturnType<typeof readWorkspaceMetadata>>;
};

async function readWorkspaceMetadata(root: string) {
	const [headResult, branchResult] = await Promise.all([
		git(root, "rev-parse", "--verify", "HEAD"),
		git(root, "symbolic-ref", "--quiet", "--short", "HEAD"),
	]);
	return { root, headResult, branchResult };
}

export async function readWorkspaceReview(
	workspacePath: string,
	metadataCache?: WorkspaceReviewMetadataCache,
): Promise<WorkspaceReviewSnapshot> {
	const root = await findGitRoot(workspacePath);
	if (!root) return emptyWorkspaceReviewSnapshot;
	const statusPromise = git(
		root,
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"-z",
	);
	const summaryPromise = git(
		root,
		"status",
		"--porcelain=v1",
		"--untracked-files=normal",
		"-z",
	);
	const metadata =
		metadataCache?.value?.root === root
			? metadataCache.value
			: await readWorkspaceMetadata(root);
	const { headResult, branchResult } = metadata;
	// Failed reads must be retried, not retained as a stale branch/HEAD.
	if (
		metadataCache &&
		headResult.code === 0 &&
		(branchResult.code === 0 || branchResult.code === 1)
	)
		metadataCache.value = metadata;
	const branch =
		branchResult.code === 0
			? branchResult.stdout.trim()
			: headResult.code === 0
				? `detached@${headResult.stdout.trim().slice(0, 7)}`
				: null;
	const metadataRevisionInputs = [headResult.stdout, branchResult.stdout];
	const [statusResult, summaryResult] = await Promise.all([
		statusPromise,
		summaryPromise,
	]);
	assertGit(statusResult, "read repository status");
	assertGit(summaryResult, "read grouped repository status");
	const changeCount = parsePorcelainEntries(summaryResult.stdout).length;
	let changes = sortWorkspaceReviewEntries(parsePorcelainStatus(statusResult.stdout));
	const revisionInputs = [
		statusResult.stdout,
		summaryResult.stdout,
		...metadataRevisionInputs,
	];
	let counts = "";
	if (changes.some((change) => change.status !== "untracked")) {
		const stats = await git(
			root,
			"diff",
			"--numstat",
			"--find-renames",
			"-z",
			"--no-ext-diff",
			"--no-textconv",
			...(headResult.code === 0 ? ["HEAD"] : ["--cached"]),
			"--",
		);
		assertGit(stats, "read change counts");
		counts = stats.stdout;
		changes = addNumStats(changes, counts);
	}
	return {
		branch,
		changes,
		isGitRepository: true,
		changeCount,
		revision: await hash(JSON.stringify([revisionInputs, counts])),
	};
}

export function parsePorcelainStatus(output: string): WorkspaceFileChange[] {
	return parsePorcelainEntries(output).map(({ code, path }) => ({
		additions: 0,
		deletions: 0,
		path,
		status: statusFromCode(code),
	}));
}

function parsePorcelainEntries(output: string): Array<{
	code: string;
	path: string;
	sourcePath?: string;
}> {
	const records = output.split("\0");
	const entries = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record || record.length < 4) continue;
		const code = record.slice(0, 2);
		const renamed = code.includes("R") || code.includes("C");
		entries.push({
			code,
			path: record.slice(3),
			sourcePath: renamed ? records[++index] : undefined,
		});
	}
	return entries;
}

export function parseNameStatus(output: string): WorkspaceFileChange[] {
	const records = output.split("\0");
	const changes: WorkspaceFileChange[] = [];
	for (let index = 0; index < records.length; index++) {
		const code = records[index];
		if (!code) continue;
		const renamed = code.startsWith("R") || code.startsWith("C");
		const firstPath = records[++index];
		const path = renamed ? records[++index] : firstPath;
		if (!path) continue;
		changes.push({
			additions: 0,
			deletions: 0,
			path,
			status: statusFromCode(code),
		});
	}
	return changes;
}

function addNumStats(
	changes: readonly WorkspaceFileChange[],
	output: string,
): WorkspaceFileChange[] {
	const records = output.split("\0");
	const stats = new Map<string, { additions: number; deletions: number }>();
	for (let index = 0; index < records.length; index++) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index]!);
		if (!match) continue;
		let path = match[3]!;
		if (!path) {
			index += 2; // A rename has separate old and new path records.
			path = records[index]!;
		}
		stats.set(path, {
			additions: Number(match[1]) || 0,
			deletions: Number(match[2]) || 0,
		});
	}
	return changes.map((change) => ({ ...change, ...stats.get(change.path) }));
}

function statusFromCode(code: string): WorkspaceFileStatus {
	if (code === "??") return "untracked";
	if (code.includes("R") || code.includes("C")) return "renamed";
	if (code.includes("D")) return "deleted";
	if (code.includes("A")) return "added";
	return "modified";
}

async function hash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return new Uint8Array(digest).toHex();
}

function assertGit(result: GitResult, action: string): void {
	if (result.code !== 0)
		throw new Error(`Unable to ${action}: ${result.stderr.trim()}`);
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

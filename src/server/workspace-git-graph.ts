import { outputCommand } from "../utils/command.ts";
import { isNotFound } from "../utils/fs-errors.ts";
import { layoutGitGraphLanes, parseGitGraphRefs } from "../workspace-git-graph-layout.ts";
import {
	emptyWorkspaceGitGraphSnapshot,
	type GitGraphBranch,
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
	GitGraphBranch,
	GitGraphRef,
	GitGraphRow,
	GitGraphSegment,
	WorkspaceGitGraphCommitDetail,
	WorkspaceGitGraphSnapshot,
} from "../workspace-git-graph-types.ts";

type GitResult = Readonly<{ code: number; stderr: string; stdout: string }>;
/**
 * `git log --all --topo-order` bound on the first page: without a `commit-graph` file
 * (most repos don't have one), topo-sorting needs to walk the whole reachable history
 * before it can emit even the first commit, so on a very large repo a bounded `-n` alone
 * doesn't keep it cheap. If it doesn't finish inside this budget, `readGraphLog` retries
 * with `--date-order` instead, which Git can stream without a full topological sort —
 * trading a possibly imperfect lane thread on that read for a graph that still loads. Ample
 * for any repo this graph's own tests (or D:/pi-ui itself) exercise, so it changes nothing
 * there; `readWorkspaceGitGraph`'s optional parameter exists so a test can force the
 * fallback deterministically without needing a repo large enough to actually trip it for real.
 */
const graphLogTimeoutMs = 1500;
const graphLogFormat = "--format=format:%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%D%x1f%s%x1e";
// The graph's fields plus the message body (%b), for one commit's detail only.
const commitDetailFormat =
	"--format=format:%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%D%x1f%s%x1f%b%x1e";
// One local branch per line: tip hash, name, upstream (blank if none), and Git's own
// ahead/behind summary against that upstream (e.g. "[ahead 2, behind 1]", "[gone]", or
// blank) — `%(upstream:track)` computes this itself, so the sidebar's ahead/behind needs
// no separate `rev-list` process per branch. Unlike `git log`'s pretty-format, `for-each-ref`
// doesn't expand `%x09`/`%x1f` hex-byte escapes — it needs an actual tab character.
const branchFormat =
	"%(objectname)\t%(refname:short)\t%(upstream:short)\t%(upstream:track)";
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

/** Parses `branchFormat`'s `for-each-ref refs/heads` output into the sidebar's branch list. */
export function parseGitBranches(
	output: string,
	currentBranch: string | null,
	mainBranch: string | null,
): GitGraphBranch[] {
	const branches: GitGraphBranch[] = [];
	for (const line of output.split("\n")) {
		if (!line) continue;
		const [hash, name, upstream, track] = line.split("\x09");
		if (!hash || !name) continue;
		const ahead = /ahead (\d+)/.exec(track ?? "");
		const behind = /behind (\d+)/.exec(track ?? "");
		branches.push({
			ahead: ahead ? Number(ahead[1]) : 0,
			behind: behind ? Number(behind[1]) : 0,
			current: name === currentBranch,
			hash,
			main: name === mainBranch,
			name,
			upstream: upstream || null,
		});
	}
	return branches;
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
	logTimeoutMs = graphLogTimeoutMs,
): Promise<WorkspaceGitGraphSnapshot> {
	const root = await findGitRoot(workspacePath);
	if (!root) return emptyWorkspaceGitGraphSnapshot;
	const [
		logResult,
		headResult,
		branchResult,
		mainBranch,
		remotesResult,
		statusResult,
		branchesResult,
	] = await Promise.all([
		readGraphLog(root, pageSize, logTimeoutMs),
		git(root, "rev-parse", "--verify", "HEAD"),
		git(root, "symbolic-ref", "--quiet", "--short", "HEAD"),
		findWorkspaceGitGraphMainBranch(root),
		git(root, "remote"),
		git(root, "status", "--porcelain=v1", "--untracked-files=normal", "-z"),
		git(root, "for-each-ref", `--format=${branchFormat}`, "refs/heads"),
	]);
	const branch =
		branchResult.code === 0
			? branchResult.stdout.trim()
			: headResult.code === 0
				? `detached@${headResult.stdout.trim().slice(0, 7)}`
				: null;
	const branches =
		branchesResult.code === 0
			? parseGitBranches(branchesResult.stdout, branch, mainBranch)
			: [];
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
		branches,
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
				branchesResult.stdout,
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
		git(root, "show", "-s", commitDetailFormat, commitHash),
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
		body: parseCommitBody(metadataResult.stdout),
		changes,
		hash: entry.hash,
		parents: entry.parents,
		shortHash: entry.shortHash,
		subject: entry.subject,
	};
}

/** The message body (everything after the subject) from `commitDetailFormat` output. */
export function parseCommitBody(output: string): string {
	return (output.split("\x1e")[0]?.split("\x1f")[7] ?? "").trim();
}

/**
 * The graph's commit log, `--topo-order` first (needed for `layoutGitGraphLanes`'s
 * children-before-parents assumption), falling back to `--date-order` — Git can stream
 * that without first sorting the whole reachable history — only when `--topo-order`
 * doesn't finish inside `timeoutMs`. See `graphLogTimeoutMs`'s own comment.
 */
async function readGraphLog(
	root: string,
	pageSize: number,
	timeoutMs: number,
): Promise<GitResult> {
	const rest = ["--all", "-n", String(pageSize + 1), graphLogFormat];
	const topoOrder = await gitBounded(root, ["log", "--topo-order", ...rest], timeoutMs);
	if (topoOrder) return topoOrder;
	return git(root, "log", "--date-order", ...rest);
}

/** Like `git()`, but returns `undefined` (instead of resolving) if it takes over `timeoutMs`. */
async function gitBounded(
	cwd: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<GitResult | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const output = await outputCommand("git", {
			args: ["-C", cwd, "-c", "core.quotePath=false", ...args],
			env: { GIT_OPTIONAL_LOCKS: "0" },
			signal: controller.signal,
		});
		// On this Bun/Windows combination, aborting the signal kills the spawned process
		// but does not reject this promise: it resolves normally with a signal-derived
		// exit code (e.g. 143) and empty output. Treat that the same as a rejection so a
		// timed-out run is never mistaken for a real (if failing) git result.
		if (controller.signal.aborted) return undefined;
		return {
			code: output.code,
			stderr: decoder.decode(output.stderr),
			stdout: decoder.decode(output.stdout),
		};
	} catch (error) {
		if (controller.signal.aborted) return undefined;
		if (!isNotFound(error)) throw error;
		return { code: 127, stderr: "Git executable not found.", stdout: "" };
	} finally {
		clearTimeout(timer);
	}
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

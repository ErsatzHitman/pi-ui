import { test } from "bun:test";
import { rename, rm } from "node:fs/promises";

import { assertEquals } from "#testing/assertions";
import { makeTempDir } from "#testing/temp";

import { AppStore } from "../state/app-store.ts";
import { outputCommand } from "../utils/command.ts";
import { WorkspaceReviewController } from "./workspace-review-controller.ts";

// These tests spawn real `git` subprocesses and poll for fs-watcher events;
// under full-suite parallel load (many other files, including
// workspace-git-graph_test.ts's real-repo tests, also spawning `git`) that
// round trip can take much longer than it does when the file runs alone.
// `waitFor`'s own deadline still fails fast with a clear message if the
// watcher genuinely never observes a change, so raising these budgets only
// buys headroom against scheduler contention, not against real bugs.
const defaultWaitTimeoutMs = 10_000;
const defaultTestTimeoutMs = 20_000;
const watcherWaitTimeoutMs = 15_000;
const watcherTestTimeoutMs = 60_000;

test.concurrent(
	"workspace review controller publishes Git changes to AppStore",
	async () => {
		const workspace = await makeTempDir();
		const store = new AppStore();
		const controller = new WorkspaceReviewController(store);
		try {
			await initGit(workspace);
			await Bun.write(`${workspace}/example.txt`, "first\n");
			await git(workspace, "add", "example.txt");
			await git(workspace, "commit", "-m", "initial");

			await controller.open(workspace);
			assertEquals(store.workspaceReview.isGitRepository, true);
			const revision = store.workspaceReview.revision;
			const filesRevision = store.workspaceFilesRevision;
			const treeRevision = store.workspaceTreeRevision;
			await Bun.write(`${workspace}/example.txt`, "second\n");
			await waitFor(() => store.workspaceReview.revision !== revision);
			await waitFor(() => store.workspaceFilesRevision !== filesRevision);

			assertEquals(store.workspaceReview.changes[0]?.path, "example.txt");
			assertEquals(store.workspaceTreeRevision, treeRevision);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const settledFilesRevision = store.workspaceFilesRevision;
			await new Promise((resolve) => setTimeout(resolve, 300));
			assertEquals(store.workspaceFilesRevision, settledFilesRevision);
		} finally {
			controller.dispose();
			await removeTempDir(workspace);
		}
	},
	defaultTestTimeoutMs,
);

test.concurrent(
	"ignored writes still notify the file browser; mixed writes and ignore rules refresh Git",
	async () => {
		const workspace = await makeTempDir();
		class MeasuredStore extends AppStore {
			refreshes = 0;
			override setWorkspaceReview(
				snapshot: Parameters<AppStore["setWorkspaceReview"]>[0],
			) {
				this.refreshes++;
				super.setWorkspaceReview(snapshot);
			}
		}
		const store = new MeasuredStore();
		const controller = new WorkspaceReviewController(store);
		try {
			await initGit(workspace);
			await Bun.write(`${workspace}/.gitignore`, "*.log\n");
			await Bun.write(`${workspace}/tracked.log`, "initial\n");
			await Bun.write(`${workspace}/ignored.log`, "initial\n");
			await git(workspace, "add", ".gitignore");
			await git(workspace, "add", "-f", "tracked.log");
			await git(workspace, "commit", "-m", "initial");
			await controller.open(workspace);
			assertEquals(store.workspaceReview.isGitRepository, true);
			const refreshes = store.refreshes;
			const filesRevision = store.workspaceFilesRevision;
			await Bun.write(`${workspace}/ignored.log`, "ignored edit\n");
			await waitFor(() => store.workspaceFilesRevision > filesRevision);
			await new Promise((resolve) => setTimeout(resolve, 300));
			assertEquals(store.refreshes, refreshes);
			await Bun.write(`${workspace}/ignored.log`, "mixed edit\n");
			await Bun.write(`${workspace}/tracked.log`, "tracked edit\n");
			await waitFor(() =>
				store.workspaceReview.changes.some(({ path }) => path === "tracked.log"),
			);
			await Bun.write(`${workspace}/.gitignore`, "*.log\n!ignored.log\n");
			await waitFor(() =>
				store.workspaceReview.changes.some(({ path }) => path === "ignored.log"),
			);
		} finally {
			controller.dispose();
			await removeTempDir(workspace);
		}
	},
	defaultTestTimeoutMs,
);

for (const linkedWorktree of [false, true]) {
	// Generous per-call and per-test budgets: this test shares the machine with
	// every other concurrently-scheduled test file (including the real-repo
	// Git subprocess load in workspace-git-graph_test.ts), so the watcher's
	// fs-event round trip can legitimately take longer than the 5s that's
	// plenty when the suite runs alone. `waitFor`'s own deadline (not Bun's
	// generic per-test timeout) still fails fast with a clear message if the
	// watcher genuinely never observes the change.
	test.concurrent(
		`workspace watcher ignores Git internals but observes commits (${linkedWorktree ? "linked worktree" : "repository"})`,
		async () => {
			const repository = await makeTempDir();
			const workspace = linkedWorktree ? await makeTempDir() : repository;
			const store = new AppStore();
			const controller = new WorkspaceReviewController(store);
			try {
				await initGit(repository);
				await git(repository, "commit", "--allow-empty", "-m", "initial");
				if (linkedWorktree)
					await git(repository, "worktree", "add", "-b", "linked", workspace);
				await controller.open(workspace);
				assertEquals(store.workspaceReview.isGitRepository, true);
				const filesRevision = store.workspaceFilesRevision;
				await Bun.write(`${repository}/.git/objects/pack/noise.tmp`, "noise");
				await Bun.write(`${repository}/.git/logs/noise`, "noise");
				await Bun.write(`${repository}/.git/index.lock`, "noise");
				await new Promise((resolve) => setTimeout(resolve, 500));
				assertEquals(store.workspaceFilesRevision, filesRevision);
				await rm(`${repository}/.git/index.lock`);

				// A worktree file named like Git metadata must not be filtered.
				await Bun.write(`${workspace}/output.lock`, "content");
				await waitFor(
					() =>
						store.workspaceReview.changes.some(
							({ path }) => path === "output.lock",
						),
					watcherWaitTimeoutMs,
				);
				const revisionBeforeCommit = store.workspaceReview.revision;
				await git(workspace, "commit", "--allow-empty", "-m", "next");
				// The snapshot's content-derived revision changes whenever HEAD moves
				// — the watcher observing the new commit is what makes this happen.
				await waitFor(
					() => store.workspaceReview.revision !== revisionBeforeCommit,
					watcherWaitTimeoutMs,
				);
				await git(workspace, "checkout", "-b", "switched");
				await waitFor(
					() => store.workspaceReview.branch === "switched",
					watcherWaitTimeoutMs,
				);
				await git(workspace, "checkout", "--detach", "HEAD");
				await waitFor(
					() => store.workspaceReview.branch?.startsWith("detached@") === true,
					watcherWaitTimeoutMs,
				);
			} finally {
				controller.dispose();
				if (linkedWorktree) await removeTempDir(workspace);
				await removeTempDir(repository);
			}
		},
		watcherTestTimeoutMs,
	);
}

test.concurrent(
	"tree revisions preserve structural changes across later content edits",
	async () => {
		const workspace = await makeTempDir();
		const store = new AppStore();
		const controller = new WorkspaceReviewController(store);
		try {
			await Bun.write(`${workspace}/existing.txt`, "initial");
			await controller.open(workspace);
			assertEquals(store.workspaceReview.revision, "non-git");

			const treeRevision = store.workspaceTreeRevision;
			await Bun.write(`${workspace}/existing.txt`, "edited");
			await waitFor(() => store.workspaceFilesRevision > 0);
			assertEquals(store.workspaceTreeRevision, treeRevision);

			for (const mutate of [
				() => Bun.write(`${workspace}/created.txt`, "created"),
				() => rename(`${workspace}/created.txt`, `${workspace}/renamed.txt`),
				() => rm(`${workspace}/renamed.txt`),
			]) {
				const before = store.workspaceTreeRevision;
				await mutate();
				await Bun.write(`${workspace}/existing.txt`, String(before));
				await waitFor(() => store.workspaceTreeRevision > before);
				assertEquals(
					store.snapshot().workspaceTreeRevision,
					store.workspaceTreeRevision,
				);
			}
			store.setWorkspacePath(`${workspace}/other`);
			assertEquals(store.workspaceTreeRevision, 0);
			assertEquals(store.workspaceFilesRevision, 0);
		} finally {
			controller.dispose();
			await removeTempDir(workspace);
		}
	},
	defaultTestTimeoutMs,
);

async function initGit(cwd: string): Promise<void> {
	await git(cwd, "init");
	await git(cwd, "config", "user.email", "pi-ui@example.test");
	await git(cwd, "config", "user.name", "pi-ui");
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const output = await outputCommand("git", {
		args: ["-C", cwd, ...args],
	});
	if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = defaultWaitTimeoutMs,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Git state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * Removes a temp directory, retrying on EBUSY/EPERM. On Windows, closing an
 * `fs.watch()`'d directory doesn't synchronously release the underlying OS
 * handle (ReadDirectoryChangesW keeps it briefly alive), so an `rm()` right
 * after `controller.dispose()` can race and fail — more likely to surface
 * under the extra CPU/IO load a full parallel `bun test` run adds. Retry
 * with a short backoff instead of failing the test over cleanup.
 */
async function removeTempDir(target: string): Promise<void> {
	const attempts = 10;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			await rm(target, { recursive: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt === attempts || (code !== "EBUSY" && code !== "EPERM"))
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
		}
	}
}

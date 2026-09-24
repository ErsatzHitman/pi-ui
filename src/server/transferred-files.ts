import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isNotFound } from "../utils/fs-errors.ts";

const TRANSFER_DIR_PREFIX = "pi-ui-transfers-";

// Directories created by this fix (or later) embed their creating process's pid right in
// the name, e.g. `pi-ui-transfers-4821-Ab3dQz`, set atomically by `mkdtemp` itself — there
// is no gap after creation where a concurrent cleanup could see the directory before its
// owner is recorded. `parseOwnerPid` reads that pid back out for a liveness check.
const OWNER_PID_PATTERN = /^pi-ui-transfers-(\d+)-/;

function parseOwnerPid(dirName: string): number | undefined {
	const match = OWNER_PID_PATTERN.exec(dirName);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Whether `pid` still names a running process, checked with the POSIX-standard
 * "signal 0" probe (also honored on Windows: it never actually signals the
 * process, it only reports whether one exists) — confirmed empirically on this
 * platform, since Node's docs describe it primarily for POSIX. `ESRCH` means no
 * such process; any other failure (e.g. `EPERM`, which means a process with
 * that pid exists but we're not allowed to signal it) is treated as "alive",
 * so an inconclusive check never leads to removing a directory that might
 * still be in use.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = Error.isError(error) && "code" in error ? error.code : undefined;
		return code !== "ESRCH";
	}
}

/**
 * Removes `pi-ui-transfers-*` directories left behind by a previous process
 * that crashed before it could dispose of its own store (a graceful shutdown
 * always cleans up; see `TransferredFileStore.dispose`).
 *
 * A directory's owning pid (embedded in its name — see `OWNER_PID_PATTERN`) is
 * checked for liveness and, whenever we can tell the owner is still running,
 * the directory is left alone no matter how old its contents look: an
 * in-progress transfer can easily go untouched for a second or more between
 * pasted files, and using mtime as the sole signal here previously let one
 * live pi-ui instance's startup delete another *still-running* instance's
 * in-progress uploads out from under it (two instances against the same temp
 * root, e.g. two projects open at once, is ordinary usage, not a crash).
 * Only a directory from a pi-ui version that predates pid-tagged names (no pid
 * to check) falls back to the previous best-effort heuristic: older than this
 * process's own start time. Ownership is checked where the platform reports it
 * (POSIX `uid`), so one user's server never removes another's leftovers on a
 * shared host. Best-effort throughout: any failure here must never stop the
 * server from starting.
 */
export async function cleanupStaleTransferDirs(
	tempRoot: string = tmpdir(),
): Promise<void> {
	const cutoff = Date.now() - process.uptime() * 1000;
	const ourUid = process.getuid?.();
	let entries: string[];
	try {
		entries = await readdir(tempRoot);
	} catch {
		return;
	}
	await Promise.all(
		entries
			.filter((name) => name.startsWith(TRANSFER_DIR_PREFIX))
			.map(async (name) => {
				const path = join(tempRoot, name);
				try {
					const info = await stat(path);
					if (!info.isDirectory()) return;
					const ownerPid = parseOwnerPid(name);
					if (ownerPid !== undefined) {
						if (isProcessAlive(ownerPid)) return;
					} else if (info.mtimeMs >= cutoff) {
						return;
					}
					if (ourUid !== undefined && info.uid !== ourUid) return;
					await rm(path, { recursive: true, force: true });
				} catch (error) {
					if (isNotFound(error)) return;
					// Best-effort: leave anything we can't inspect or remove alone.
				}
			}),
	);
}

export const MAX_TRANSFER_FILES = 10;
export const MAX_TRANSFER_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSFER_TOTAL_BYTES = 50 * 1024 * 1024;

// Browser multipart framing is small, but Content-Length includes it. This early
// bound is intentionally looser than the authoritative post-parse file limits.
export const MAX_TRANSFER_REQUEST_BYTES = MAX_TRANSFER_TOTAL_BYTES + 1024 * 1024;

export type TransferredFileErrorCode =
	| "too-many-files"
	| "file-too-large"
	| "total-too-large"
	| "request-too-large";

export interface TransferredFileErrorDetails {
	code: TransferredFileErrorCode;
	message: string;
	status: 400 | 413;
}

export interface TransferredFileLike {
	readonly name: string;
	readonly size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export class TransferredFileError extends Error {
	readonly code: TransferredFileErrorCode;
	readonly status: 400 | 413;

	constructor(details: TransferredFileErrorDetails) {
		super(details.message);
		this.name = "TransferredFileError";
		this.code = details.code;
		this.status = details.status;
	}
}

export function validateTransferredFiles(
	files: readonly Pick<TransferredFileLike, "name" | "size">[],
): TransferredFileErrorDetails | undefined {
	if (files.length > MAX_TRANSFER_FILES) {
		return {
			code: "too-many-files",
			message: `Attach at most ${MAX_TRANSFER_FILES} files at a time.`,
			status: 400,
		};
	}

	let totalBytes = 0;
	for (const file of files) {
		if (file.size > MAX_TRANSFER_FILE_BYTES) {
			return {
				code: "file-too-large",
				message: "Each transferred file must be 20 MiB or smaller.",
				status: 413,
			};
		}
		totalBytes += file.size;
	}

	if (totalBytes > MAX_TRANSFER_TOTAL_BYTES) {
		return {
			code: "total-too-large",
			message: "Transferred files must total 50 MiB or less.",
			status: 413,
		};
	}
}

export function validateTransferContentLength(
	contentLength: string | null,
): TransferredFileErrorDetails | undefined {
	if (contentLength === null) return;
	const bytes = Number(contentLength);
	if (!Number.isFinite(bytes) || bytes < 0 || bytes <= MAX_TRANSFER_REQUEST_BYTES) {
		return;
	}
	return {
		code: "request-too-large",
		message: "Transferred request is too large.",
		status: 413,
	};
}

export function getTransferredFiles(formData: FormData): File[] {
	return formData
		.getAll("file")
		.filter((value): value is File => value instanceof File);
}

export class TransferredFileStore {
	readonly rootPath: string;
	readonly #paths = new Set<string>();
	#disposed = false;

	private constructor(rootPath: string) {
		this.rootPath = rootPath;
	}

	static async create(
		options: { tempRoot?: string } = {},
	): Promise<TransferredFileStore> {
		const tempRoot = options.tempRoot ?? tmpdir();
		await cleanupStaleTransferDirs(tempRoot);
		// The pid is embedded directly in the prefix mkdtemp expands, so ownership is
		// recorded atomically with creation — see `cleanupStaleTransferDirs`.
		const rootPath = await mkdtemp(
			join(tempRoot, `${TRANSFER_DIR_PREFIX}${process.pid}-`),
		);
		return new TransferredFileStore(rootPath);
	}

	async importFiles(files: readonly TransferredFileLike[]): Promise<string[]> {
		if (this.#disposed) throw new Error("Transferred file store is disposed");
		const validationError = validateTransferredFiles(files);
		if (validationError) throw new TransferredFileError(validationError);

		const importedPaths: string[] = [];
		try {
			for (const file of files) {
				const path = join(
					this.rootPath,
					`file-${crypto.randomUUID()}-${sanitizeFileName(file.name || "pasted-file")}`,
				);
				this.#paths.add(path);
				importedPaths.push(path);
				await Bun.write(
					path,
					file instanceof Blob ? file : await file.arrayBuffer(),
				);
			}
			return importedPaths;
		} catch (error) {
			await Promise.allSettled(
				importedPaths.map((path) => this.#removeOwnedFile(path)),
			);
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#paths.clear();
		try {
			await rm(this.rootPath, { recursive: true });
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}

	async #removeOwnedFile(path: string): Promise<void> {
		if (!this.#paths.delete(path)) return;
		try {
			await Bun.file(path).delete();
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
}

export function sanitizeFileName(name: string): string {
	return (
		name
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 120) || "pasted-file"
	);
}

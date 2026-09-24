import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes `contents` to `path` as an owner-only-readable file (mode 0600 on
 * POSIX), for secrets (keys, tokens) this process persists to disk.
 * `Bun.write` silently ignores its `mode` option (verified on Linux, Bun
 * 1.4.2: the file comes out 0644 under the usual umask — the same bug the
 * RM1 fix for the service's `pi-ui.env` token file found), and `writeFile`'s
 * `mode` only applies when it *creates* the file. So any existing file (e.g.
 * a stale 0644 one from an older build) is dropped first and the replacement
 * is created exclusively ("wx") with the mode set at open(). No effect on
 * Windows, which has no POSIX permission bits; callers there rely on the
 * file simply never being served over the network (see `request-auth.ts`'s
 * public-asset allowlist, which this file is never added to).
 */
export async function writeSecretFile(
	path: string,
	contents: string,
	mode = 0o600,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await rm(path, { force: true });
	await writeFile(path, contents, { mode, flag: "wx" });
}

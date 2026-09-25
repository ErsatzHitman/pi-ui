import { readStoredCredential } from "@earendil-works/pi-coding-agent";

// Deep import, following the `ensureTool` precedent (`app.ts`): pi does not
// publicly export `resolveConfigValue`, but its dist output is stable enough
// to depend on directly (`resolve-config-value.js` caches shell-command
// (`!command`) results for the process lifetime, so this isn't re-run per
// request).
import { resolveConfigValue } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";

/**
 * Resolves the Groq API key voice input uses, in order:
 * 1. `GROQ_API_KEY` in the server's environment (already the convention pi
 *    itself uses for Groq, and shared with pi chat).
 * 2. A `groq` `api_key` credential in pi's `~/.pi/agent/auth.json`, resolved
 *    the same way pi resolves any stored key (a literal, an `$ENV_VAR`
 *    template, or a `!command`). OAuth credentials are ignored: Groq has no
 *    OAuth flow in pi, so an `oauth`-typed entry here would be foreign data.
 * 3. `undefined` — voice input reports `status: "no-key"`.
 *
 * The key never leaves the server: callers embed only `VoiceStatus.status`
 * in the page. `env` and `readCredential` are injectable for tests, which
 * must never touch a real `~/.pi/agent/auth.json`.
 */
export function resolveGroqApiKey(
	env: NodeJS.ProcessEnv = process.env,
	readCredential: (
		providerId: string,
	) => ReturnType<typeof readStoredCredential> = readStoredCredential,
): string | undefined {
	const fromEnv = env.GROQ_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	const credential = readCredential("groq");
	if (!credential || credential.type !== "api_key" || !credential.key) return undefined;
	// SAFETY: `resolveConfigValue` only ever reads a named key off `env` and
	// treats a missing one as unresolved either way, so `process.env`'s
	// `string | undefined` index values behave identically to a plain
	// `Record<string, string>` for every lookup this call performs.
	const resolved = resolveConfigValue(
		credential.key,
		env as Record<string, string>,
	)?.trim();
	return resolved || undefined;
}

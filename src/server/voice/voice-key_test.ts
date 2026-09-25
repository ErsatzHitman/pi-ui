import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { resolveGroqApiKey } from "./voice-key.ts";

test("env GROQ_API_KEY wins over a stored credential", () => {
	const key = resolveGroqApiKey({ GROQ_API_KEY: "env-key" }, () => ({
		type: "api_key",
		key: "auth-json-key",
	}));
	assertEquals(key, "env-key");
});

test("whitespace-only env is ignored, falling through to the stored credential", () => {
	const key = resolveGroqApiKey({ GROQ_API_KEY: "   " }, () => ({
		type: "api_key",
		key: "auth-json-key",
	}));
	assertEquals(key, "auth-json-key");
});

test("falls back to the auth.json api_key credential when env is unset", () => {
	const key = resolveGroqApiKey({}, () => ({ type: "api_key", key: "literal-key" }));
	assertEquals(key, "literal-key");
});

test("resolves an $ENV_VAR-templated stored key against the given env", () => {
	const key = resolveGroqApiKey({ MY_GROQ_KEY: "resolved-key" }, () => ({
		type: "api_key",
		key: "$MY_GROQ_KEY",
	}));
	assertEquals(key, "resolved-key");
});

test("an OAuth credential is ignored", () => {
	const key = resolveGroqApiKey({}, () => ({
		type: "oauth",
		refresh: "r",
		access: "a",
		expires: 0,
	}));
	assertEquals(key, undefined);
});

test("no env and no credential resolves to undefined", () => {
	assertEquals(
		resolveGroqApiKey({}, () => undefined),
		undefined,
	);
});

test("a stored api_key credential with no key resolves to undefined", () => {
	assertEquals(
		resolveGroqApiKey({}, () => ({ type: "api_key" })),
		undefined,
	);
});

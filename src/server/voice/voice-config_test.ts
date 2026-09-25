import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { defaultVoiceConfig, parseVoiceConfig } from "./voice-config.ts";

test("parseVoiceConfig falls back to defaults for undefined/non-record input", () => {
	assertEquals(parseVoiceConfig(undefined), defaultVoiceConfig);
	assertEquals(parseVoiceConfig(null), defaultVoiceConfig);
	assertEquals(parseVoiceConfig("nope"), defaultVoiceConfig);
	assertEquals(parseVoiceConfig(42), defaultVoiceConfig);
	assertEquals(parseVoiceConfig([1, 2, 3]), defaultVoiceConfig);
	assertEquals(parseVoiceConfig({}), defaultVoiceConfig);
});

test("parseVoiceConfig accepts a fully specified config", () => {
	assertEquals(
		parseVoiceConfig({
			enabled: false,
			model: "whisper-large-v3",
			language: "en",
			prompt: "pi-ui, Datastar, Bun",
			maxSeconds: 120,
			baseUrl: "https://example.test/openai/v1",
		}),
		{
			enabled: false,
			model: "whisper-large-v3",
			language: "en",
			prompt: "pi-ui, Datastar, Bun",
			maxSeconds: 120,
			baseUrl: "https://example.test/openai/v1",
		},
	);
});

test("parseVoiceConfig falls each invalid field back to its default independently", () => {
	assertEquals(
		parseVoiceConfig({
			enabled: "yes", // wrong type
			model: "   ", // blank
			language: "english", // fails the ISO-639-1-ish pattern
			prompt: "x".repeat(897), // over the length cap
			maxSeconds: "300", // wrong type
			baseUrl: "not a url",
		}),
		defaultVoiceConfig,
	);
});

test("parseVoiceConfig accepts a script-tagged language and trims whitespace", () => {
	const config = parseVoiceConfig({ language: " zh-Hans ", model: " custom-model " });
	assertEquals(config.language, "zh-Hans");
	assertEquals(config.model, "custom-model");
});

test("parseVoiceConfig clamps maxSeconds into range instead of rejecting it", () => {
	assertEquals(parseVoiceConfig({ maxSeconds: 1 }).maxSeconds, 10);
	assertEquals(parseVoiceConfig({ maxSeconds: 5000 }).maxSeconds, 1800);
	assertEquals(parseVoiceConfig({ maxSeconds: 60 }).maxSeconds, 60);
	assertEquals(
		parseVoiceConfig({ maxSeconds: 12.5 }).maxSeconds,
		defaultVoiceConfig.maxSeconds,
	);
});

test("parseVoiceConfig rejects a non-http(s) baseUrl", () => {
	assertEquals(
		parseVoiceConfig({ baseUrl: "ftp://example.test" }).baseUrl,
		defaultVoiceConfig.baseUrl,
	);
});

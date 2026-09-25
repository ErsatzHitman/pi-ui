import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { defaultVoiceConfig } from "./voice-config.ts";
import { createVoiceService } from "./voice-service.ts";

function fakeAudio(): File {
	return new File(["abc"], "voice.webm", { type: "audio/webm" });
}

test("status is disabled when config.enabled is false, regardless of the key", () => {
	const service = createVoiceService({
		config: { ...defaultVoiceConfig, enabled: false },
		resolveKey: () => "a-key",
		transcriber: { transcribe: async () => ({ ok: true, text: "" }) },
	});
	assertEquals(service.status(), {
		status: "disabled",
		maxSeconds: defaultVoiceConfig.maxSeconds,
	});
});

test("status is no-key when enabled but no key resolves", () => {
	const service = createVoiceService({
		config: defaultVoiceConfig,
		resolveKey: () => undefined,
		transcriber: { transcribe: async () => ({ ok: true, text: "" }) },
	});
	assertEquals(service.status(), {
		status: "no-key",
		maxSeconds: defaultVoiceConfig.maxSeconds,
	});
});

test("status is ready when enabled and a key resolves", () => {
	const service = createVoiceService({
		config: defaultVoiceConfig,
		resolveKey: () => "a-key",
		transcriber: { transcribe: async () => ({ ok: true, text: "" }) },
	});
	assertEquals(service.status(), {
		status: "ready",
		maxSeconds: defaultVoiceConfig.maxSeconds,
	});
});

test("transcribe on a disabled service returns the disabled error without calling the transcriber", async () => {
	let called = false;
	const service = createVoiceService({
		config: { ...defaultVoiceConfig, enabled: false },
		resolveKey: () => "a-key",
		transcriber: {
			transcribe: async () => {
				called = true;
				return { ok: true, text: "" };
			},
		},
	});
	const result = await service.transcribe({
		audio: fakeAudio(),
		signal: new AbortController().signal,
	});
	assertEquals(result, {
		ok: false,
		status: 404,
		code: "disabled",
		message: "Voice input is disabled.",
	});
	assertEquals(called, false);
});

test("transcribe with no key returns not-configured without calling the transcriber", async () => {
	let called = false;
	const service = createVoiceService({
		config: defaultVoiceConfig,
		resolveKey: () => undefined,
		transcriber: {
			transcribe: async () => {
				called = true;
				return { ok: true, text: "" };
			},
		},
	});
	const result = await service.transcribe({
		audio: fakeAudio(),
		signal: new AbortController().signal,
	});
	assertEquals(result.ok, false);
	if (!result.ok) assertEquals(result.code, "not-configured");
	assertEquals(called, false);
});

test("transcribe forwards resolved config and key to the transcriber", async () => {
	let seen: unknown;
	const service = createVoiceService({
		config: {
			...defaultVoiceConfig,
			model: "m",
			language: "en",
			prompt: "p",
			baseUrl: "https://x.test",
		},
		resolveKey: () => "resolved-key",
		transcriber: {
			transcribe: async (request) => {
				seen = request;
				return { ok: true, text: "hi" };
			},
		},
	});
	const audio = fakeAudio();
	const signal = new AbortController().signal;
	const result = await service.transcribe({ audio, signal });
	assertEquals(result, { ok: true, text: "hi" });
	assertEquals(seen, {
		audio,
		apiKey: "resolved-key",
		model: "m",
		baseUrl: "https://x.test",
		language: "en",
		prompt: "p",
		signal,
	});
});

test("a third concurrent transcription past the in-flight cap of 2 gets busy", async () => {
	const gates: Array<() => void> = [];
	const service = createVoiceService({
		config: defaultVoiceConfig,
		resolveKey: () => "a-key",
		transcriber: {
			transcribe: () =>
				new Promise((resolve) => {
					gates.push(() => resolve({ ok: true, text: "done" }));
				}),
		},
	});

	const first = service.transcribe({
		audio: fakeAudio(),
		signal: new AbortController().signal,
	});
	const second = service.transcribe({
		audio: fakeAudio(),
		signal: new AbortController().signal,
	});
	// Let both in-flight transcriptions register before the third is issued.
	await new Promise((resolve) => setTimeout(resolve, 0));

	const third = await service.transcribe({
		audio: fakeAudio(),
		signal: new AbortController().signal,
	});
	assertEquals(third, {
		ok: false,
		status: 429,
		code: "busy",
		message: "Another transcription is still running. Try again in a moment.",
	});

	for (const gate of gates) gate();
	assertEquals(await first, { ok: true, text: "done" });
	assertEquals(await second, { ok: true, text: "done" });
});

test("the in-flight count is released after a transcription so a later call can proceed", async () => {
	const service = createVoiceService({
		config: defaultVoiceConfig,
		resolveKey: () => "a-key",
		transcriber: { transcribe: async () => ({ ok: true, text: "done" }) },
		maxInFlight: 1,
	});
	assertEquals(
		await service.transcribe({
			audio: fakeAudio(),
			signal: new AbortController().signal,
		}),
		{
			ok: true,
			text: "done",
		},
	);
	assertEquals(
		await service.transcribe({
			audio: fakeAudio(),
			signal: new AbortController().signal,
		}),
		{
			ok: true,
			text: "done",
		},
	);
});

test("the in-flight count is released even when the transcriber throws (a caller abort)", async () => {
	const service = createVoiceService({
		config: defaultVoiceConfig,
		resolveKey: () => "a-key",
		transcriber: {
			transcribe: async () => {
				throw new DOMException("aborted", "AbortError");
			},
		},
		maxInFlight: 1,
	});
	await service
		.transcribe({ audio: fakeAudio(), signal: new AbortController().signal })
		.catch(() => {});
	const result = await service
		.transcribe({ audio: fakeAudio(), signal: new AbortController().signal })
		.catch((error: unknown) => error);
	// A second call after the first threw must not immediately see "busy" —
	// the in-flight slot from the first (aborted) call must have been released.
	if (result instanceof DOMException) {
		assertEquals(result.name, "AbortError");
	} else {
		assertEquals((result as { code?: string }).code !== "busy", true);
	}
});

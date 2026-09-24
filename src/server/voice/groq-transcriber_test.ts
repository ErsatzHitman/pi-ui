import { afterEach, expect, test } from "bun:test";

import { assertEquals, assertRejects, assertStringIncludes } from "#testing/assertions";
import { startFakeGroqServer, type FakeGroqServer } from "#testing/fake-groq-server";

import { createGroqTranscriber } from "./groq-transcriber.ts";

let server: FakeGroqServer | undefined;

afterEach(() => {
	server?.stop();
	server = undefined;
});

function audioFile(bytes = "fake-audio-bytes", type = "audio/webm;codecs=opus"): File {
	return new File([bytes], "blob", { type });
}

test("sends the request shape Groq expects: URL, bearer, multipart fields, filename extension", async () => {
	server = startFakeGroqServer();
	const transcriber = createGroqTranscriber({ appVersion: "9.9.9" });

	const result = await transcriber.transcribe({
		audio: audioFile("abc", "audio/webm;codecs=opus"),
		apiKey: "test-key",
		model: "whisper-large-v3-turbo",
		baseUrl: server.url,
		language: "en",
		prompt: "pi-ui",
		signal: new AbortController().signal,
	});

	assertEquals(result, { ok: true, text: "hello from the fake groq server" });
	assertEquals(server.requests.length, 1);
	const request = server.requests[0];
	assertEquals(request?.path, "/openai/v1/audio/transcriptions");
	assertEquals(request?.authorization, "Bearer test-key");
	assertEquals(request?.fields.model, "whisper-large-v3-turbo");
	assertEquals(request?.fields.language, "en");
	assertEquals(request?.fields.prompt, "pi-ui");
	assertEquals(request?.fields.response_format, "json");
	assertEquals(request?.fields.temperature, "0");
	assertEquals(request?.file?.name, "voice.webm");
	// The multipart part's own Content-Type header is Bun's, sniffed from the
	// filename extension when the form is serialized on the wire (it drops the
	// `;codecs=` parameter we set on the File) — not something this code
	// controls, and not something Groq relies on: per the design doc, Groq/
	// OpenAI detect the container from the *filename* extension, asserted above.
});

test("maps mime types to Groq's expected filename extension", async () => {
	server = startFakeGroqServer();
	const transcriber = createGroqTranscriber();
	const cases: Array<[string, string]> = [
		["audio/webm;codecs=opus", "voice.webm"],
		["audio/ogg;codecs=opus", "voice.ogg"],
		["audio/mp4;codecs=mp4a.40.2", "voice.m4a"],
		["audio/mp4", "voice.m4a"],
		["audio/x-m4a", "voice.m4a"],
		["audio/mpeg", "voice.mp3"],
		["audio/wav", "voice.wav"],
		["audio/flac", "voice.flac"],
		// Bun's `Request.formData()` reports these mangled aliases instead of the
		// wire Content-Type for a real upload (see `audio-mime.ts`); the route
		// hands this module whatever it received, so it must map these too.
		["video/webm", "voice.webm"],
		["video/mp4", "voice.m4a"],
		["audio/x-wav", "voice.wav"],
		["audio/x-flac", "voice.flac"],
	];
	for (const [mime] of cases) {
		await transcriber.transcribe({
			audio: audioFile("abc", mime),
			apiKey: "k",
			model: "m",
			baseUrl: server.url,
			signal: new AbortController().signal,
		});
	}
	assertEquals(
		server.requests.map((request) => request.file?.name),
		cases.map(([, name]) => name),
	);
});

test("omits language and prompt fields when unconfigured", async () => {
	server = startFakeGroqServer();
	const transcriber = createGroqTranscriber();
	await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		language: "",
		prompt: "",
		signal: new AbortController().signal,
	});
	assertEquals(server.requests[0]?.fields.language, null);
	assertEquals(server.requests[0]?.fields.prompt, null);
});

test("narrows a script-tagged language to its ISO-639-1 primary subtag", async () => {
	server = startFakeGroqServer();
	const transcriber = createGroqTranscriber();
	await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		language: "zh-Hans",
		signal: new AbortController().signal,
	});
	assertEquals(server.requests[0]?.fields.language, "zh");
});

test("tolerates unknown response fields and only requires a string `text`", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({
		json: { text: "ok", unknown_field: { nested: true }, x_groq: { id: "x" } },
	}));
	const transcriber = createGroqTranscriber();
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result, { ok: true, text: "ok" });
});

test("a 200 response with no string text field is a provider-error", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({ json: { unexpected: true } }));
	const transcriber = createGroqTranscriber();
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result.ok, false);
	if (!result.ok) assertEquals(result.code, "provider-error");
});

test("a 200 response with a non-JSON body is a provider-error", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({ body: "not json" }));
	const transcriber = createGroqTranscriber();
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result.ok, false);
	if (!result.ok) assertEquals(result.code, "provider-error");
});

test("401 maps to provider-unauthorized without retrying", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({ status: 401, json: { error: { message: "bad key" } } }));
	const transcriber = createGroqTranscriber();
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result.ok, false);
	if (!result.ok) {
		assertEquals(result.status, 502);
		assertEquals(result.code, "provider-unauthorized");
		assertStringIncludes(result.message, "Groq rejected the API key");
	}
	assertEquals(server.requests.length, 1);
});

test("413 maps to too-large without retrying", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({ status: 413, json: { error: "too big" } }));
	const transcriber = createGroqTranscriber();
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result, {
		ok: false,
		status: 413,
		code: "too-large",
		message: "Recording is too large for Groq (25 MB). Record a shorter take.",
	});
	assertEquals(server.requests.length, 1);
});

test("400/422 map to provider-rejected without retrying", async () => {
	for (const status of [400, 422]) {
		server = startFakeGroqServer();
		server.respond(() => ({ status }));
		const transcriber = createGroqTranscriber();
		const result = await transcriber.transcribe({
			audio: audioFile(),
			apiKey: "k",
			model: "m",
			baseUrl: server.url,
			signal: new AbortController().signal,
		});
		assertEquals(result.ok, false);
		if (!result.ok) assertEquals(result.code, "provider-rejected");
		assertEquals(server.requests.length, 1);
		server.stop();
	}
	server = undefined;
});

test("429 with a retry-after header succeeds after exactly one retry", async () => {
	server = startFakeGroqServer();
	let calls = 0;
	server.respond(() => {
		calls += 1;
		if (calls === 1) return { status: 429, headers: { "retry-after": "0" } };
		return { json: { text: "second try" } };
	});
	const transcriber = createGroqTranscriber();
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result, { ok: true, text: "second try" });
	assertEquals(server.requests.length, 2);
});

test("429 twice reports rate-limited with the retry-after seconds", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({ status: 429, headers: { "retry-after": "3" } }));
	const transcriber = createGroqTranscriber({ delay: async () => {} });
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result, {
		ok: false,
		status: 429,
		code: "rate-limited",
		message: "Groq rate limit reached. Try again in 3s.",
		retryAfterSeconds: 3,
	});
	assertEquals(server.requests.length, 2);
});

test("503 then 200 succeeds after one retry with the default delay", async () => {
	server = startFakeGroqServer();
	let calls = 0;
	server.respond(() => {
		calls += 1;
		if (calls === 1) return { status: 503 };
		return { json: { text: "recovered" } };
	});
	const transcriber = createGroqTranscriber({ delay: async () => {} });
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result, { ok: true, text: "recovered" });
	assertEquals(server.requests.length, 2);
});

test("500 twice reports provider-error after one retry", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({ status: 500 }));
	const transcriber = createGroqTranscriber({ delay: async () => {} });
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result.ok, false);
	if (!result.ok) {
		assertEquals(result.status, 502);
		assertEquals(result.code, "provider-error");
	}
	assertEquals(server.requests.length, 2);
});

test("498 is retried the same way as a 5xx", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({ status: 498 }));
	const transcriber = createGroqTranscriber({ delay: async () => {} });
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result.ok, false);
	if (!result.ok) assertEquals(result.code, "provider-error");
	assertEquals(server.requests.length, 2);
});

test("a delay past the request timeout produces provider-timeout, with no retry", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({ delayMs: 500, json: { text: "too late" } }));
	const transcriber = createGroqTranscriber({ requestTimeoutMs: 200 });
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: server.url,
		signal: new AbortController().signal,
	});
	assertEquals(result.ok, false);
	if (!result.ok) {
		assertEquals(result.status, 504);
		assertEquals(result.code, "provider-timeout");
	}
	assertEquals(server.requests.length, 1);
});

test("a caller abort rejects instead of retrying", async () => {
	server = startFakeGroqServer();
	const controller = new AbortController();
	server.respond(async () => {
		controller.abort();
		return { delayMs: 200 };
	});
	const transcriber = createGroqTranscriber();
	await assertRejects(() =>
		transcriber.transcribe({
			audio: audioFile(),
			apiKey: "k",
			model: "m",
			baseUrl: server!.url,
			signal: controller.signal,
		}),
	);
	assertEquals(server.requests.length, 1);
});

test("a stopped server (transport failure) is retried once, then reports provider-unreachable", async () => {
	server = startFakeGroqServer();
	const url = server.url;
	server.stop();
	server = undefined;
	const transcriber = createGroqTranscriber({ delay: async () => {} });
	const result = await transcriber.transcribe({
		audio: audioFile(),
		apiKey: "k",
		model: "m",
		baseUrl: url,
		signal: new AbortController().signal,
	});
	assertEquals(result.ok, false);
	if (!result.ok) assertEquals(result.code, "provider-unreachable");
});

test("error bodies are truncated to 300 chars in server logs, never shown to the caller", async () => {
	server = startFakeGroqServer();
	server.respond(() => ({
		status: 500,
		json: { error: { message: "x".repeat(1000) } },
	}));
	const errors: unknown[][] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args);
	};
	try {
		const transcriber = createGroqTranscriber({ delay: async () => {} });
		const result = await transcriber.transcribe({
			audio: audioFile(),
			apiKey: "super-secret-key",
			model: "m",
			baseUrl: server.url,
			signal: new AbortController().signal,
		});
		assertEquals(result.ok, false);
		if (!result.ok) {
			expect(result.message).not.toContain("super-secret-key");
			expect(result.message).not.toContain("x".repeat(1000));
		}
		const logged = errors.flat().map((entry) => String(entry));
		for (const entry of logged) {
			expect(entry).not.toContain("super-secret-key");
		}
		const loggedDetail = String(errors.at(-1)?.[1] ?? "");
		expect(loggedDetail.length).toBeLessThanOrEqual(300);
	} finally {
		console.error = originalError;
	}
});

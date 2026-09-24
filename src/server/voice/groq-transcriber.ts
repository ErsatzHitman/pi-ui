import { isRecord, isString } from "../../utils/type-guards.ts";
import { baseMimeType, extensionForBaseMime } from "./audio-mime.ts";

/** `VoiceErrorCode` values a Groq call itself can produce. `voice-service.ts`
 * adds the local codes ("disabled", "not-configured", "invalid-audio",
 * "too-long", "busy") that never reach this module. */
export type GroqErrorCode =
	| "too-large"
	| "rate-limited"
	| "provider-unauthorized"
	| "provider-rejected"
	| "provider-error"
	| "provider-timeout"
	| "provider-unreachable";

export type GroqTranscribeResult =
	| { ok: true; text: string }
	| {
			ok: false;
			status: number;
			code: GroqErrorCode;
			message: string;
			retryAfterSeconds?: number;
	  };

export interface GroqTranscribeRequest {
	audio: File;
	apiKey: string;
	model: string;
	baseUrl: string;
	/** ISO-639-1 language code, or "" / omitted for auto-detect. */
	language?: string;
	/** Vocabulary/spelling hint, or "" / omitted. */
	prompt?: string;
	signal: AbortSignal;
}

export interface GroqTranscriber {
	transcribe(request: GroqTranscribeRequest): Promise<GroqTranscribeResult>;
}

export interface CreateGroqTranscriberOptions {
	/** pi-ui's own version, sent as the `User-Agent`. */
	appVersion?: string;
	/** Whole-call timeout, from the first byte sent to the last byte of the
	 * response (including the one bounded retry). Default 60s: Groq transcribes
	 * five minutes of audio in about two seconds, so this is generous, not tight. */
	requestTimeoutMs?: number;
	/** Injectable for tests, so they hit the in-process fake Groq server instead
	 * of a real socket even where `fetch` isn't otherwise intercepted. */
	fetchImpl?: typeof fetch;
	/** Injectable clock, for deterministic "time budget remaining" tests. */
	now?: () => number;
	/** Injectable sleep, so retry-delay tests don't have to burn wall-clock time. */
	delay?: (ms: number) => Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 5_000;
const MAX_LOGGED_ERROR_CHARS = 300;

/** Groq/OpenAI detect the audio container from the filename extension, not
 * `Content-Type`, so an unrecognized mime still needs a plausible extension
 * (matches this app's own upload path, never a truly foreign mime — the route
 * validates the base mime, via the same table, before this is ever called). */
export function extensionForMime(mime: string): string {
	return extensionForBaseMime(baseMimeType(mime)) ?? "webm";
}

/** `zh-Hans` -> `zh`, matching Handy's `effective_language`: Groq/Whisper's
 * `language` parameter wants a bare ISO-639-1 code, not a script subtag. */
function effectiveLanguage(language: string): string {
	return language.split("-", 1)[0] ?? language;
}

export function createGroqTranscriber(
	options: CreateGroqTranscriberOptions = {},
): GroqTranscriber {
	const appVersion = options.appVersion ?? "development";
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const delay =
		options.delay ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

	return {
		async transcribe(request: GroqTranscribeRequest): Promise<GroqTranscribeResult> {
			const deadline = now() + requestTimeoutMs;
			const first = await attempt(request, deadline, fetchImpl, appVersion);
			if (first.kind === "abort") throw first.error;
			if (first.kind === "ok") return { ok: true, text: first.text };
			if (!first.retryable || request.signal.aborted) return toResult(first);

			const delayMs = retryDelayMs(first.retryAfterSeconds);
			if (delayMs > deadline - now()) return toResult(first);
			await delay(delayMs);

			const second = await attempt(request, deadline, fetchImpl, appVersion);
			if (second.kind === "abort") throw second.error;
			if (second.kind === "ok") return { ok: true, text: second.text };
			return toResult(second);
		},
	};
}

type AttemptOutcome =
	| { kind: "ok"; text: string }
	| { kind: "abort"; error: unknown }
	| {
			kind: "fail";
			status: number;
			code: GroqErrorCode;
			message: string;
			retryAfterSeconds?: number;
			retryable: boolean;
	  };

function toResult(
	outcome: Extract<AttemptOutcome, { kind: "fail" }>,
): GroqTranscribeResult {
	const result: GroqTranscribeResult = {
		ok: false,
		status: outcome.status,
		code: outcome.code,
		message: outcome.message,
	};
	if (outcome.retryAfterSeconds !== undefined) {
		result.retryAfterSeconds = outcome.retryAfterSeconds;
	}
	return result;
}

async function attempt(
	request: GroqTranscribeRequest,
	deadline: number,
	fetchImpl: typeof fetch,
	appVersion: string,
): Promise<AttemptOutcome> {
	const remainingMs = Math.max(0, deadline - Date.now());
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(remainingMs)]);
	const url = `${request.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${request.apiKey}`,
				"User-Agent": `pi-ui/${appVersion}`,
			},
			body: buildMultipartBody(request),
			signal,
		});
	} catch (error) {
		if (isAbortError(error)) {
			if (request.signal.aborted) return { kind: "abort", error };
			return {
				kind: "fail",
				status: 504,
				code: "provider-timeout",
				message: "Transcription timed out. Retry in a moment.",
				retryable: false,
			};
		}
		logProviderFailure("transport failure", error);
		return {
			kind: "fail",
			status: 502,
			code: "provider-unreachable",
			message:
				"Couldn't reach Groq from the pi-ui server. Check its internet connection.",
			retryable: true,
		};
	}

	if (response.ok) {
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			// The parse error's message can quote the (transcript) body; log its name only.
			logProviderFailure(
				"non-JSON 200 response",
				error instanceof Error ? error.name : "unparseable body",
			);
			return providerErrorOutcome();
		}
		if (isRecord(body) && isString(body.text)) return { kind: "ok", text: body.text };
		// Field names only: the body of a 200 may hold the transcript under some other key,
		// and transcripts are never logged.
		logProviderFailure(
			"200 response missing a string `text` field",
			isRecord(body)
				? `keys: ${Object.keys(body).join(", ")}`
				: "not a JSON object",
		);
		return providerErrorOutcome();
	}

	const rawBody = await response.text().catch(() => "");
	logProviderFailure(`HTTP ${response.status}`, extractProviderErrorMessage(rawBody));
	return classifyErrorResponse(response);
}

function providerErrorOutcome(): AttemptOutcome {
	return {
		kind: "fail",
		status: 502,
		code: "provider-error",
		message: "Groq is having trouble right now. Retry in a moment.",
		retryable: false,
	};
}

function classifyErrorResponse(response: Response): AttemptOutcome {
	const status = response.status;
	if (status === 401 || status === 403) {
		return {
			kind: "fail",
			status: 502,
			code: "provider-unauthorized",
			message:
				"Groq rejected the API key. Check GROQ_API_KEY (or pi's Groq key) on the server.",
			retryable: false,
		};
	}
	if (status === 413) {
		return {
			kind: "fail",
			status: 413,
			code: "too-large",
			message: "Recording is too large for Groq (25 MB). Record a shorter take.",
			retryable: false,
		};
	}
	if (status === 429) {
		const retryAfterSeconds = parseRetryAfterSeconds(
			response.headers.get("retry-after"),
		);
		const outcome: Extract<AttemptOutcome, { kind: "fail" }> = {
			kind: "fail",
			status: 429,
			code: "rate-limited",
			message: rateLimitedMessage(retryAfterSeconds),
			retryable: true,
		};
		if (retryAfterSeconds !== undefined)
			outcome.retryAfterSeconds = retryAfterSeconds;
		return outcome;
	}
	if (status === 400 || status === 422) {
		return {
			kind: "fail",
			status: 502,
			code: "provider-rejected",
			message: "Groq couldn't process this audio. Try recording again.",
			retryable: false,
		};
	}
	if (status === 498 || (status >= 500 && status <= 599)) {
		return {
			kind: "fail",
			status: 502,
			code: "provider-error",
			message: "Groq is having trouble right now. Retry in a moment.",
			retryable: true,
		};
	}
	return providerErrorOutcome();
}

function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
	if (retryAfterSeconds === undefined) {
		return "Groq rate limit reached. Try again in a moment.";
	}
	return `Groq rate limit reached. Try again in ${Math.max(1, Math.round(retryAfterSeconds))}s.`;
}

function retryDelayMs(retryAfterSeconds: number | undefined): number {
	if (retryAfterSeconds === undefined) return DEFAULT_RETRY_DELAY_MS;
	return Math.min(
		MAX_RETRY_DELAY_MS,
		Math.max(0, Math.round(retryAfterSeconds * 1000)),
	);
}

function parseRetryAfterSeconds(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function buildMultipartBody(request: GroqTranscribeRequest): FormData {
	const form = new FormData();
	const extension = extensionForMime(request.audio.type || "");
	const file = new File([request.audio], `voice.${extension}`, {
		type: request.audio.type || "application/octet-stream",
	});
	form.append("file", file);
	form.append("model", request.model);
	form.append("response_format", "json");
	form.append("temperature", "0");
	const language = request.language?.trim();
	if (language) form.append("language", effectiveLanguage(language));
	const prompt = request.prompt?.trim();
	if (prompt) form.append("prompt", prompt);
	return form;
}

function isAbortError(cause: unknown): boolean {
	return (
		cause instanceof DOMException &&
		(cause.name === "AbortError" || cause.name === "TimeoutError")
	);
}

/** `{error:{message}} | {error:"…"} | {message}`, tried in that order; falls
 * back to the raw body. Truncated to keep logs bounded — this is server-log
 * only, never shown to the browser and never includes the API key. */
function extractProviderErrorMessage(rawBody: string): string {
	try {
		const parsed: unknown = JSON.parse(rawBody);
		if (isRecord(parsed)) {
			if (isRecord(parsed.error) && isString(parsed.error.message)) {
				return parsed.error.message.slice(0, MAX_LOGGED_ERROR_CHARS);
			}
			if (isString(parsed.error))
				return parsed.error.slice(0, MAX_LOGGED_ERROR_CHARS);
			if (isString(parsed.message))
				return parsed.message.slice(0, MAX_LOGGED_ERROR_CHARS);
		}
	} catch {
		// Not JSON: fall through to the raw body below.
	}
	return rawBody.slice(0, MAX_LOGGED_ERROR_CHARS);
}

function logProviderFailure(context: string, cause: unknown): void {
	console.error(`Groq transcription failed (${context})`, cause);
}

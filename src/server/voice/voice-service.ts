import type { GroqTranscriber } from "./groq-transcriber.ts";
import { cleanTranscript } from "./transcript-cleanup.ts";
import type { VoiceConfig } from "./voice-config.ts";

export type VoiceErrorCode =
	| "disabled"
	| "not-configured"
	| "invalid-audio"
	| "too-large"
	| "too-long"
	| "busy"
	| "rate-limited"
	| "provider-unauthorized"
	| "provider-rejected"
	| "provider-error"
	| "provider-timeout"
	| "provider-unreachable";

export type VoiceStatus = {
	status: "ready" | "no-key" | "disabled";
	maxSeconds: number;
};

export type VoiceTranscribeResult =
	| { ok: true; text: string }
	| {
			ok: false;
			status: number;
			code: VoiceErrorCode;
			message: string;
			retryAfterSeconds?: number;
	  };

export interface VoiceService {
	status(): VoiceStatus;
	transcribe(input: {
		audio: File;
		signal: AbortSignal;
	}): Promise<VoiceTranscribeResult>;
}

const NOT_CONFIGURED_MESSAGE =
	"Voice input needs a Groq API key. Set GROQ_API_KEY for the pi-ui server (or add a Groq key to pi), then reload.";

export interface CreateVoiceServiceOptions {
	config: VoiceConfig;
	/** Resolves the Groq API key. Called per status check and per transcription
	 * (cheap: env is a lookup, and `resolveConfigValue` caches command results
	 * for the process lifetime), so a key added to `auth.json` works after a
	 * page reload with no server restart. */
	resolveKey: () => string | undefined;
	transcriber: GroqTranscriber;
	/** Concurrent Groq calls allowed before new requests get `busy`. Default 2:
	 * closes the "unbounded concurrent transcription" gap without needing a
	 * queue for what is, in practice, one person dictating from one device
	 * at a time. */
	maxInFlight?: number;
}

export function createVoiceService(options: CreateVoiceServiceOptions): VoiceService {
	const { config, resolveKey, transcriber } = options;
	const maxInFlight = options.maxInFlight ?? 2;
	let inFlight = 0;

	function status(): VoiceStatus {
		if (!config.enabled) return { status: "disabled", maxSeconds: config.maxSeconds };
		if (!resolveKey()) return { status: "no-key", maxSeconds: config.maxSeconds };
		return { status: "ready", maxSeconds: config.maxSeconds };
	}

	return {
		status,
		async transcribe(input): Promise<VoiceTranscribeResult> {
			if (!config.enabled) {
				return {
					ok: false,
					status: 404,
					code: "disabled",
					message: "Voice input is disabled.",
				};
			}
			const apiKey = resolveKey();
			if (!apiKey) {
				return {
					ok: false,
					status: 503,
					code: "not-configured",
					message: NOT_CONFIGURED_MESSAGE,
				};
			}
			if (inFlight >= maxInFlight) {
				return {
					ok: false,
					status: 429,
					code: "busy",
					message:
						"Another transcription is still running. Try again in a moment.",
				};
			}

			inFlight += 1;
			try {
				const result = await transcriber.transcribe({
					audio: input.audio,
					apiKey,
					model: config.model,
					baseUrl: config.baseUrl,
					language: config.language,
					prompt: config.prompt,
					signal: input.signal,
				});
				if (!result.ok) return result;
				return {
					ok: true,
					text: cleanTranscript(result.text, {
						removeFillerWords: config.removeFillerWords,
						// The configured language is stronger evidence than Whisper's guess.
						language: config.language || result.language,
					}),
				};
			} finally {
				inFlight -= 1;
			}
		},
	};
}

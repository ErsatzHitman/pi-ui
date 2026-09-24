import type { RouteMap } from "../route.ts";
import { ALLOWED_AUDIO_BASE_MIME_TYPES, baseMimeType } from "../voice/audio-mime.ts";
import type { VoiceErrorCode } from "../voice/voice-service.ts";
import type { RouteContext } from "./context.ts";
import { endpoints } from "./endpoints.ts";

/** 25 MiB, matching Groq's own upload cap (`voice.md`, R2). */
const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
/** The audio cap plus generous multipart framing overhead — the
 * `validateTransferContentLength` pattern (`transferred-files.ts`): reject an
 * over-budget request before reading its body at all. */
const MAX_VOICE_REQUEST_BYTES = MAX_VOICE_AUDIO_BYTES + 64 * 1024;

const NOT_CONFIGURED_MESSAGE =
	"Voice input needs a Groq API key. Set GROQ_API_KEY for the pi-ui server (or add a Groq key to pi), then reload.";

export const voiceRoutes = {
	[endpoints.voiceTranscribe]: {
		POST: transcribeVoice,
	},
} satisfies RouteMap<RouteContext>;

async function transcribeVoice(
	request: Request,
	context: RouteContext,
): Promise<Response> {
	const status = context.voice.status();
	if (status.status === "disabled") {
		return voiceErrorResponse(404, "disabled", "Voice input is disabled.");
	}
	if (status.status === "no-key") {
		return voiceErrorResponse(503, "not-configured", NOT_CONFIGURED_MESSAGE);
	}

	const tooLarge = validateVoiceContentLength(request.headers.get("content-length"));
	if (tooLarge) return tooLarge;

	// `request.formData()` itself throws (and is left uncaught here) if the
	// request is aborted mid-body; `executeRoute` maps that to a 499 for a
	// client-cancelled recording, the same way it does for every other route.
	const formData = await request.formData();
	const audio = formData.get("audio");
	if (!(audio instanceof File) || audio.size === 0) {
		return voiceErrorResponse(400, "invalid-audio", "No recording was received.");
	}
	if (audio.size > MAX_VOICE_AUDIO_BYTES) {
		return voiceErrorResponse(
			413,
			"too-large",
			"Recording is too large for Groq (25 MB). Record a shorter take.",
		);
	}
	const baseMime = baseMimeType(audio.type || "");
	if (!baseMime || !ALLOWED_AUDIO_BASE_MIME_TYPES.has(baseMime)) {
		return voiceErrorResponse(
			400,
			"invalid-audio",
			"That doesn't look like a supported audio recording.",
		);
	}

	const durationMs = parseDurationMs(formData.get("durationMs"));
	if (durationMs !== undefined && durationMs > (status.maxSeconds + 5) * 1000) {
		return voiceErrorResponse(413, "too-long", "Recording is too long.");
	}

	const result = await context.voice.transcribe({ audio, signal: request.signal });
	if (result.ok) return Response.json({ text: result.text });
	return voiceErrorResponse(
		result.status,
		result.code,
		result.message,
		result.retryAfterSeconds,
	);
}

function parseDurationMs(value: FormDataEntryValue | null): number | undefined {
	if (value === null || value instanceof File) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function validateVoiceContentLength(contentLength: string | null): Response | undefined {
	if (contentLength === null) return undefined;
	const bytes = Number(contentLength);
	if (!Number.isFinite(bytes) || bytes < 0 || bytes <= MAX_VOICE_REQUEST_BYTES) {
		return undefined;
	}
	return voiceErrorResponse(
		413,
		"too-large",
		"Recording is too large for Groq (25 MB). Record a shorter take.",
	);
}

function voiceErrorResponse(
	status: number,
	error: VoiceErrorCode,
	message: string,
	retryAfterSeconds?: number,
): Response {
	// `Response.json` serializes through `JSON.stringify`, which drops an
	// `undefined`-valued property entirely, so an absent `retryAfterSeconds`
	// never reaches the browser as a `null` or empty field.
	return Response.json({ error, message, retryAfterSeconds }, { status });
}

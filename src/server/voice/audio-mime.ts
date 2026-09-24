/**
 * Base audio container mime types voice input accepts, mapped to the
 * filename extension Groq/OpenAI need to detect each container — they read
 * the filename, not the multipart part's `Content-Type` (see
 * `groq-transcriber.ts`).
 *
 * Verified empirically against this Bun version: `Request.formData()` does
 * **not** preserve the wire `Content-Type` of a multipart file part. It
 * substitutes its own mime-type-from-extension guess instead —
 * `"video/webm"` for a `voice.webm` upload, `"video/mp4"` for `voice.mp4`,
 * `"audio/x-flac"` for `voice.flac`, `"audio/x-wav"` for `voice.wav`,
 * `"audio/x-m4a"` for `voice.m4a` — even when the browser genuinely sent
 * `audio/webm` etc. on the wire. Every base mime this table accepts
 * therefore includes both the "logical" `audio/*` type (in case a future
 * Bun version, or some other client, preserves it) and Bun's actual guessed
 * alias, so a real `MediaRecorder` upload — named `voice.<ext>` per the
 * client contract (`DESIGN-voice.md` §7.1) — validates against what this
 * server actually receives, not just what the spec says a compliant HTTP
 * stack would receive.
 */
export const EXTENSION_BY_AUDIO_MIME = {
	"audio/webm": "webm",
	"video/webm": "webm",
	"audio/ogg": "ogg",
	"audio/mp4": "m4a",
	"video/mp4": "m4a",
	"audio/x-m4a": "m4a",
	"audio/m4a": "m4a",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac",
	"audio/x-flac": "flac",
} as const satisfies Readonly<Record<string, string>>;

export const ALLOWED_AUDIO_BASE_MIME_TYPES = new Set(
	Object.keys(EXTENSION_BY_AUDIO_MIME),
);

/** Strips a `;codecs=…` (or other) parameter and lowercases, so callers can
 * match a raw `File.type`/`Content-Type` against the tables above. */
export function baseMimeType(mime: string): string {
	return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The filename extension Groq needs for `baseMime`, or `undefined` when it
 * isn't one of the accepted containers (`voice.ts` rejects those before this
 * is ever consulted for a real request; `groq-transcriber.ts` still falls
 * back to `"webm"` defensively). */
export function extensionForBaseMime(baseMime: string): string | undefined {
	if (!Object.hasOwn(EXTENSION_BY_AUDIO_MIME, baseMime)) return undefined;
	// SAFETY: the `Object.hasOwn` check just above confirms `baseMime` names an
	// actual key of this exact object, so the lookup below cannot land on the
	// prototype or return `undefined` for a key that shouldn't be there.
	return EXTENSION_BY_AUDIO_MIME[baseMime as keyof typeof EXTENSION_BY_AUDIO_MIME];
}

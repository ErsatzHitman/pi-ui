// Pure logic for voice input (speech-to-text): no DOM, no timers, no I/O. Everything here is
// deterministic given its inputs so it can be unit tested without a browser. The imperative glue
// (getUserMedia, MediaRecorder, canvas drawing, DOM) lives in voice.js / voice-waveform.js.

/** Legal client-side voice states, per the shared contract (DESIGN-voice.md §7.3). */
export const VOICE_STATES = [
	"idle",
	"arming",
	"recording",
	"paused",
	"stopping",
	"transcribing",
];

const FORWARD_TRANSITIONS = {
	// idle -> transcribing is retry(): re-uploading a blob retained from a failed transcription,
	// without recording again.
	idle: ["arming", "transcribing"],
	arming: ["recording", "idle"],
	recording: ["paused", "stopping", "idle"],
	paused: ["recording", "stopping", "idle"],
	stopping: ["transcribing", "idle"],
	transcribing: ["idle"],
};

/**
 * Whether the state machine may move from `from` to `to`. Any non-idle state may always return
 * to `idle` (cancel, error revert, or a completed transcription) even when that edge isn't
 * spelled out above; every other edge must be explicit. A state never "transitions" to itself.
 */
export function canTransition(from, to) {
	if (from === to) return false;
	if (to === "idle") return from !== "idle";
	return FORWARD_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Formats elapsed milliseconds as `m:ss`. */
export function formatElapsed(elapsedMs) {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Whether voice input is blocked for this browser/page, and why. Computed once and pushed into
 * the `_voiceBlocked` signal; never re-checked per click.
 */
export function blockedReason({
	isSecureContext,
	hasGetUserMedia,
	hasMediaRecorder,
	voiceStatus,
}) {
	if (!isSecureContext || !hasGetUserMedia) return "insecure";
	if (!hasMediaRecorder) return "unsupported";
	if (voiceStatus === "no-key") return "no-key";
	return "";
}

/**
 * Whether arming should transition to recording (§2.1.9): a real audio signal from the
 * analyser, the `MediaRecorder` itself firing its `start` event (proof audio is flowing
 * even when the analyser never will — no `AudioContext` constructor, or one that silently
 * failed to produce data), or the fallback timeout elapsing. Any one of the three is
 * enough, so a missing/failed `AudioContext` can never leave the UI stuck in arming
 * forever: the recorder's own `start` still fires.
 */
export function armingIsReady({
	hasSignal,
	recorderStarted,
	armingElapsedMs,
	fallbackMs,
}) {
	return hasSignal || recorderStarted || armingElapsedMs >= fallbackMs;
}

/** Every `error` code `POST /voice/transcribe` answers with (DESIGN-voice.md §7.1). */
const VOICE_ERROR_CODES = new Set([
	"disabled",
	"not-configured",
	"invalid-audio",
	"too-large",
	"too-long",
	"busy",
	"rate-limited",
	"provider-unauthorized",
	"provider-rejected",
	"provider-error",
	"provider-timeout",
	"provider-unreachable",
]);

const RETRYABLE_VOICE_ERROR_CODES = new Set([
	"busy",
	"rate-limited",
	"provider-error",
	"provider-timeout",
	"provider-unreachable",
]);

/**
 * Whether a failed upload keeps its recording and offers Retry (§7.1). A voice error code
 * decides on its own, so a 502 `provider-unauthorized` or a 503 `not-configured` is not
 * retryable; only a generic route error (`{ error: <message> }`) falls back to "any 5xx".
 */
export function isRetryableUploadFailure({ status, code }) {
	if (VOICE_ERROR_CODES.has(code)) return RETRYABLE_VOICE_ERROR_CODES.has(code);
	return status >= 500;
}

const MIME_CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/ogg;codecs=opus",
	"audio/mp4;codecs=mp4a.40.2",
	"audio/mp4",
];

/** Picks the best MediaRecorder mime type this browser supports, or "" for the browser default. */
export function pickMimeType(isTypeSupported) {
	for (const candidate of MIME_CANDIDATES) {
		if (isTypeSupported(candidate)) return candidate;
	}
	return "";
}

const EXTENSION_BY_BASE_MIME = {
	"audio/webm": "webm",
	"audio/ogg": "ogg",
	"audio/mp4": "m4a",
	"audio/x-m4a": "m4a",
	"audio/m4a": "m4a",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac",
};

/** Maps a MediaRecorder mime type (with optional `;codecs=`) to the upload filename extension. */
export function extensionForMime(mimeType) {
	const base = (mimeType ?? "").split(";")[0].trim().toLowerCase();
	return EXTENSION_BY_BASE_MIME[base] ?? "webm";
}

/** Classifies a getUserMedia/MediaRecorder DOMException name into a stable, testable code. */
export function classifyMediaError(name) {
	switch (name) {
		case "NotAllowedError":
		case "SecurityError":
			return "permission-denied";
		case "NotFoundError":
		case "DevicesNotFoundError":
			return "no-device";
		case "NotReadableError":
		case "TrackStartError":
			return "device-unavailable";
		case "OverconstrainedError":
		case "ConstraintNotSatisfiedError":
			return "overconstrained";
		case "AbortError":
			return "aborted";
		default:
			return "unknown";
	}
}

/** Tunable constants for the level meter and speech gate. Kept in one object so VERIFY can tune. */
export const LEVEL_TUNING = {
	noiseFloorInitDb: -60,
	noiseFloorMinDb: -80,
	noiseFloorMaxDb: -35,
	noiseFallAlpha: 0.2,
	noiseRiseTauMs: 8000,
	normHiDb: -14,
	normLoOffsetDb: 6,
	normLoFloorDb: -60,
	gain: 1.3,
	curvePower: 0.7,
	attackTauMs: 25,
	releaseTauMs: 140,
	speechGateDeltaDb: 12,
	speechGateAbsoluteDb: -50,
	speechMinVoicedMs: 250,
	speechMinActiveMs: 400,
};

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

/** Root-mean-square of a Float32Array (or plain array) of time-domain audio samples. */
export function levelFromSamples(samples) {
	if (!samples || samples.length === 0) return 0;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index];
		sumSquares += sample * sample;
	}
	return Math.sqrt(sumSquares / samples.length);
}

/** Converts linear RMS (0..1) to dBFS, floored to avoid `-Infinity` on silence. */
export function dbFromRms(rms) {
	return 20 * Math.log10(Math.max(rms, 1e-8));
}

/**
 * Adapts the noise floor towards `db`: falls fast (alpha 0.2/frame) when the room gets quieter,
 * rises slowly (an ~8s time constant) when it gets louder, so a burst of speech doesn't drag the
 * floor up with it. Clamped to a sane dBFS range.
 */
export function updateNoiseFloor(noiseFloorDb, db, dtMs, tuning = LEVEL_TUNING) {
	const next =
		db < noiseFloorDb
			? noiseFloorDb + (db - noiseFloorDb) * tuning.noiseFallAlpha
			: noiseFloorDb +
				(db - noiseFloorDb) * (1 - Math.exp(-dtMs / tuning.noiseRiseTauMs));
	return clamp(next, tuning.noiseFloorMinDb, tuning.noiseFloorMaxDb);
}

/** Normalizes `db` against the current noise floor and applies Handy's gain/curve shaping. */
export function curveLevel(db, noiseFloorDb, tuning = LEVEL_TUNING) {
	const lo = Math.max(noiseFloorDb + tuning.normLoOffsetDb, tuning.normLoFloorDb);
	const hi = tuning.normHiDb;
	const norm = clamp((db - lo) / (hi - lo), 0, 1);
	const gained = clamp(norm * tuning.gain, 0, 1);
	return gained ** tuning.curvePower;
}

/** Frame-rate-independent one-pole envelope: fast attack, slower release. */
export function updateEnvelope(env, curved, dtMs, tuning = LEVEL_TUNING) {
	const tau = curved > env ? tuning.attackTauMs : tuning.releaseTauMs;
	const alpha = 1 - Math.exp(-dtMs / tau);
	return env + (curved - env) * alpha;
}

/** Whether a single frame counts as voiced, for the no-speech gate. */
export function isVoicedFrame(db, noiseFloorDb, tuning = LEVEL_TUNING) {
	return (
		db > noiseFloorDb + tuning.speechGateDeltaDb && db > tuning.speechGateAbsoluteDb
	);
}

/** Combines the pure level functions into one per-frame step, holding the running state. */
export class LevelMeter {
	constructor(tuning = LEVEL_TUNING) {
		this.tuning = tuning;
		this.noiseFloorDb = tuning.noiseFloorInitDb;
		this.env = 0;
	}

	/** @param {ArrayLike<number>} samples @param {number} dtMs */
	update(samples, dtMs) {
		const rms = levelFromSamples(samples);
		const db = dbFromRms(rms);
		this.noiseFloorDb = updateNoiseFloor(this.noiseFloorDb, db, dtMs, this.tuning);
		const curved = curveLevel(db, this.noiseFloorDb, this.tuning);
		this.env = updateEnvelope(this.env, curved, dtMs, this.tuning);
		const voiced = isVoicedFrame(db, this.noiseFloorDb, this.tuning);
		return { db, noiseFloorDb: this.noiseFloorDb, curved, env: this.env, voiced };
	}
}

/** The only VAD in v1: a no-speech gate over accumulated voiced time. */
export class SpeechGate {
	constructor(tuning = LEVEL_TUNING) {
		this.tuning = tuning;
		this.voicedMs = 0;
	}

	pushFrame(voiced, dtMs) {
		if (voiced) this.voicedMs += dtMs;
	}

	/** @param {number} activeMs Active (non-paused) recording duration. */
	passes(activeMs) {
		return (
			this.voicedMs >= this.tuning.speechMinVoicedMs &&
			activeMs >= this.tuning.speechMinActiveMs
		);
	}
}

/**
 * Ring buffer of bar heights for the scrolling waveform: one entry per `bucketMs`, holding the
 * max envelope value seen in that bucket (so a short syllable between pushes isn't dropped).
 */
export class BarHistory {
	constructor(bucketMs = 60, capacity = 64) {
		this.bucketMs = bucketMs;
		this.capacity = Math.max(1, capacity);
		this.bars = [];
		this._bucketMax = 0;
		this._bucketElapsedMs = 0;
	}

	setCapacity(capacity) {
		this.capacity = Math.max(1, Math.floor(capacity));
		while (this.bars.length > this.capacity) this.bars.shift();
	}

	/** @param {number} value Current envelope value (0..1). @param {number} dtMs */
	push(value, dtMs) {
		this._bucketMax = Math.max(this._bucketMax, value);
		this._bucketElapsedMs += dtMs;
		while (this._bucketElapsedMs >= this.bucketMs) {
			this.bars.push(this._bucketMax);
			if (this.bars.length > this.capacity) this.bars.shift();
			this._bucketElapsedMs -= this.bucketMs;
			this._bucketMax = 0;
		}
	}

	reset() {
		this.bars = [];
		this._bucketMax = 0;
		this._bucketElapsedMs = 0;
	}

	/** Fraction (0..1) of the way through the current bucket; used to sub-bar-scroll smoothly. */
	get bucketProgress() {
		return this._bucketElapsedMs / this.bucketMs;
	}
}

/**
 * Inserts `text` (trimmed) into `value` at `[start, end)`, adding a single space on each side
 * whose neighbour is non-whitespace. Returns the new value and the caret position right after
 * the inserted text. An empty/whitespace-only `text` is a no-op (caret stays at `start`).
 */
export function insertTranscript(value, start, end, text) {
	const trimmed = (text ?? "").trim();
	if (trimmed === "") return { value, caret: start };
	const before = value.slice(0, start);
	const after = value.slice(end);
	const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
	const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
	const insertion = `${needsLeadingSpace ? " " : ""}${trimmed}${needsTrailingSpace ? " " : ""}`;
	return { value: before + insertion + after, caret: before.length + insertion.length };
}

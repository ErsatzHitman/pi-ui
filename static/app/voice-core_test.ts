import { test } from "bun:test";

import { assert, assertEquals, assertFalse } from "#testing/assertions";

import {
	BarHistory,
	blockedReason,
	canTransition,
	classifyMediaError,
	dbFromRms,
	extensionForMime,
	formatElapsed,
	insertTranscript,
	isRetryableUploadFailure,
	isVoicedFrame,
	LEVEL_TUNING,
	LevelMeter,
	levelFromSamples,
	pickMimeType,
	SpeechGate,
	updateEnvelope,
	updateNoiseFloor,
} from "./voice-core.js";

test("pickMimeType prefers webm opus, then ogg opus, then mp4 variants, then default", () => {
	const supports = (set) => (type) => set.has(type);
	assertEquals(
		pickMimeType(
			supports(new Set(["audio/webm;codecs=opus", "audio/ogg;codecs=opus"])),
		),
		"audio/webm;codecs=opus",
	);
	assertEquals(
		pickMimeType(supports(new Set(["audio/ogg;codecs=opus", "audio/mp4"]))),
		"audio/ogg;codecs=opus",
	);
	// Safari 18.3 and earlier: no webm/ogg, only mp4 with an explicit codec string.
	assertEquals(
		pickMimeType(supports(new Set(["audio/mp4;codecs=mp4a.40.2", "audio/mp4"]))),
		"audio/mp4;codecs=mp4a.40.2",
	);
	assertEquals(pickMimeType(supports(new Set())), "");
});

test("extensionForMime maps container mime types, ignoring codec suffixes", () => {
	assertEquals(extensionForMime("audio/webm;codecs=opus"), "webm");
	assertEquals(extensionForMime("audio/ogg;codecs=opus"), "ogg");
	assertEquals(extensionForMime("audio/mp4;codecs=mp4a.40.2"), "m4a");
	assertEquals(extensionForMime("audio/mp4"), "m4a");
	assertEquals(extensionForMime("audio/x-m4a"), "m4a");
	assertEquals(extensionForMime("audio/mpeg"), "mp3");
	assertEquals(extensionForMime("audio/wav"), "wav");
	assertEquals(extensionForMime("audio/flac"), "flac");
	assertEquals(extensionForMime(""), "webm");
	assertEquals(extensionForMime(undefined), "webm");
});

test("classifyMediaError maps DOMException names to stable codes", () => {
	assertEquals(classifyMediaError("NotAllowedError"), "permission-denied");
	assertEquals(classifyMediaError("NotFoundError"), "no-device");
	assertEquals(classifyMediaError("NotReadableError"), "device-unavailable");
	assertEquals(classifyMediaError("OverconstrainedError"), "overconstrained");
	assertEquals(classifyMediaError("AbortError"), "aborted");
	assertEquals(classifyMediaError("SomeWeirdError"), "unknown");
});

test("blockedReason detects insecure context, missing MediaRecorder, and no-key", () => {
	const base = { isSecureContext: true, hasGetUserMedia: true, hasMediaRecorder: true };
	assertEquals(blockedReason({ ...base, isSecureContext: false }), "insecure");
	assertEquals(blockedReason({ ...base, hasGetUserMedia: false }), "insecure");
	assertEquals(blockedReason({ ...base, hasMediaRecorder: false }), "unsupported");
	assertEquals(blockedReason({ ...base, voiceStatus: "no-key" }), "no-key");
	assertEquals(blockedReason({ ...base, voiceStatus: "ready" }), "");
});

test("isRetryableUploadFailure lets a voice error code decide, else any 5xx", () => {
	for (const code of [
		"busy",
		"rate-limited",
		"provider-error",
		"provider-timeout",
		"provider-unreachable",
	]) {
		assert(isRetryableUploadFailure({ status: 502, code }), code);
	}
	assertFalse(isRetryableUploadFailure({ status: 502, code: "provider-unauthorized" }));
	assertFalse(isRetryableUploadFailure({ status: 502, code: "provider-rejected" }));
	assertFalse(isRetryableUploadFailure({ status: 503, code: "not-configured" }));
	assertFalse(isRetryableUploadFailure({ status: 400, code: "invalid-audio" }));
	// Generic route errors carry a message, not a voice code, in `error`.
	assert(isRetryableUploadFailure({ status: 500, code: "Something broke." }));
	assert(isRetryableUploadFailure({ status: 500, code: undefined }));
	assertFalse(isRetryableUploadFailure({ status: 404, code: "Not found." }));
});

test("levelFromSamples: all-zero samples give zero RMS, a loud sine gives a high RMS", () => {
	assertEquals(levelFromSamples(new Float32Array(512)), 0);
	assertEquals(levelFromSamples([]), 0);

	// A full-scale sine wave has RMS ~= 1/sqrt(2) ~= 0.707; a -6 dBFS sine is about half that
	// amplitude, so its RMS should still read comfortably above the near-silence floor.
	const sine = new Float32Array(512);
	const amplitude = 10 ** (-6 / 20);
	for (let index = 0; index < sine.length; index += 1) {
		sine[index] = amplitude * Math.sin((2 * Math.PI * 40 * index) / sine.length);
	}
	const rms = levelFromSamples(sine);
	assert(rms > 0.3, `expected a high RMS for a -6 dBFS sine, got ${rms}`);
});

test("dbFromRms floors at -160 dBFS instead of -Infinity for exact silence", () => {
	assertEquals(dbFromRms(0), -160);
	assert(dbFromRms(1) === 0);
});

test("updateNoiseFloor falls fast towards a quieter room and rises slowly towards a louder one", () => {
	let floor = -60;
	// One big drop should move almost all the way (alpha 0.2, but repeated frames accumulate).
	for (let i = 0; i < 5; i += 1) floor = updateNoiseFloor(floor, -75, 16);
	assert(floor < -65, `expected the floor to fall towards -75, got ${floor}`);

	// A single frame of a much louder room barely moves the floor (slow ~8s rise).
	const beforeRise = -60;
	const afterOneFrame = updateNoiseFloor(beforeRise, -20, 16);
	assert(
		afterOneFrame - beforeRise < 1,
		`expected a slow rise, moved by ${afterOneFrame - beforeRise}`,
	);

	// It never escapes the configured clamp.
	assert(updateNoiseFloor(-35, -10, 100000) <= LEVEL_TUNING.noiseFloorMaxDb);
	assert(updateNoiseFloor(-80, -90, 100000) >= LEVEL_TUNING.noiseFloorMinDb);
});

test("updateEnvelope attacks faster than it releases", () => {
	// Rising from 0 towards 1 (attack) should cover more ground per frame than falling from 1
	// towards 0 (release) at the same dt, since attackTauMs < releaseTauMs.
	const attacked = updateEnvelope(0, 1, 20);
	const released = updateEnvelope(1, 0, 20);
	const attackDelta = attacked - 0;
	const releaseDelta = 1 - released;
	assert(
		attackDelta > releaseDelta,
		`expected attack (${attackDelta}) to outpace release (${releaseDelta})`,
	);
});

test("isVoicedFrame requires both a floor margin and an absolute threshold", () => {
	assertFalse(isVoicedFrame(-55, -60)); // only 5 dB above the floor
	assertFalse(isVoicedFrame(-60, -80)); // 20 dB above the floor, but not above -50 dBFS absolute
	assert(isVoicedFrame(-30, -60));
});

test("SpeechGate: silence never passes", () => {
	const gate = new SpeechGate();
	for (let i = 0; i < 100; i += 1) gate.pushFrame(false, 16);
	assertEquals(gate.voicedMs, 0);
	assertFalse(gate.passes(2000));
});

test("SpeechGate: a steady noise floor stops counting as voiced once the floor adapts", () => {
	const meter = new LevelMeter();
	const gate = new SpeechGate();
	const dtMs = 20;
	const steadyDb = -45;
	// Synthesize frames at a constant -45 dBFS long enough for the noise floor to catch up. Early
	// frames (before the floor has risen) legitimately register as voiced — that's the ramp — but
	// once the floor has caught up, the same steady level must stop registering as voiced.
	let lastVoiced = true;
	for (let i = 0; i < 1000; i += 1) {
		meter.noiseFloorDb = updateNoiseFloor(meter.noiseFloorDb, steadyDb, dtMs);
		lastVoiced = isVoicedFrame(steadyDb, meter.noiseFloorDb);
		gate.pushFrame(lastVoiced, dtMs);
	}
	assertFalse(
		lastVoiced,
		`expected steady noise to stop registering as voiced once the floor adapts, floor=${meter.noiseFloorDb}`,
	);
});

test("SpeechGate: a burst of loud frames above a quiet floor passes", () => {
	const gate = new SpeechGate();
	// The floor starts at -60; a burst well above -60+12 and above -50 counts as voiced.
	for (let i = 0; i < 30; i += 1) gate.pushFrame(isVoicedFrame(-20, -60), 20);
	assert(gate.passes(600));
});

test("formatElapsed formats m:ss and pads seconds", () => {
	assertEquals(formatElapsed(0), "0:00");
	assertEquals(formatElapsed(7000), "0:07");
	assertEquals(formatElapsed(65000), "1:05");
	assertEquals(formatElapsed(599999), "9:59");
	assertEquals(formatElapsed(-5), "0:00");
});

test("the transition table only allows the documented edges, plus cancel-to-idle from anywhere", () => {
	assert(canTransition("idle", "arming"));
	assert(canTransition("arming", "recording"));
	assert(canTransition("recording", "paused"));
	assert(canTransition("paused", "recording"));
	assert(canTransition("recording", "stopping"));
	assert(canTransition("paused", "stopping"));
	assert(canTransition("stopping", "transcribing"));
	assert(canTransition("transcribing", "idle"));
	// retry(): re-uploading a retained blob without recording again.
	assert(canTransition("idle", "transcribing"));
	// Cancel/revert-on-failure: every non-idle state can drop straight back to idle.
	assert(canTransition("arming", "idle"));
	assert(canTransition("recording", "idle"));
	assert(canTransition("paused", "idle"));
	assert(canTransition("stopping", "idle"));

	// Illegal edges.
	assertFalse(canTransition("transcribing", "paused"));
	assertFalse(canTransition("idle", "recording"));
	assertFalse(canTransition("stopping", "recording"));
	assertFalse(canTransition("paused", "arming"));
	assertFalse(canTransition("idle", "idle"));
	assertFalse(canTransition("recording", "recording"));
});

test("insertTranscript adds a single space only where the neighbour needs one", () => {
	assertEquals(insertTranscript("", 0, 0, " hello world  "), {
		value: "hello world",
		caret: 11,
	});
	assertEquals(insertTranscript("fix the", 7, 7, "bug"), {
		value: "fix the bug",
		caret: 11,
	});
	assertEquals(insertTranscript("fix the bug", 0, 0, "please"), {
		value: "please fix the bug",
		caret: 7,
	});
	// Replaces a selection.
	assertEquals(insertTranscript("fix the old bug", 8, 11, "new"), {
		value: "fix the new bug",
		caret: 11,
	});
	// Neighbour already whitespace: no extra space added.
	assertEquals(insertTranscript("fix the ", 8, 8, "bug"), {
		value: "fix the bug",
		caret: 11,
	});
	// Empty/whitespace-only transcript is a no-op.
	assertEquals(insertTranscript("draft", 5, 5, "   "), { value: "draft", caret: 5 });
});

test("BarHistory records the max envelope value per bucket, not the last sample", () => {
	const history = new BarHistory(60, 10);
	// Three sub-bucket pushes; only the max (0.8) should be recorded once the bucket closes.
	history.push(0.2, 20);
	history.push(0.8, 20);
	history.push(0.3, 20); // 60ms reached: closes the bucket.
	assertEquals(history.bars, [0.8]);
});

test("BarHistory trims to its capacity, dropping the oldest bars first", () => {
	const history = new BarHistory(60, 3);
	for (let i = 0; i < 5; i += 1) history.push(i / 10, 60);
	assertEquals(history.bars.length, 3);
	assertEquals(history.bars, [0.2, 0.3, 0.4]);
});

test("BarHistory.setCapacity trims immediately", () => {
	const history = new BarHistory(60, 10);
	for (let i = 0; i < 5; i += 1) history.push(i / 10, 60);
	history.setCapacity(2);
	assertEquals(history.bars, [0.3, 0.4]);
});

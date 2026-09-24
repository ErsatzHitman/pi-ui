// Voice input (speech-to-text) controller: state machine, getUserMedia, MediaRecorder,
// AudioContext, upload, and the window.piUi.voice API. DOM reflection back into Datastar happens
// through a single CustomEvent (`pi-ui-voice-state`, see prompt-box.tsx) rather than direct
// signal writes, so this module has no dependency on Datastar. Pure math lives in voice-core.js;
// canvas drawing lives in voice-waveform.js.

import { isString } from "../../src/utils/type-guards.ts";
import { promptInput } from "./prompt.js";
import {
	BarHistory,
	blockedReason,
	canTransition,
	classifyMediaError,
	extensionForMime,
	formatElapsed,
	insertTranscript,
	LevelMeter,
	pickMimeType,
	SpeechGate,
	updateEnvelope,
} from "./voice-core.js";
import { createWaveformRenderer } from "./voice-waveform.js";

const MAX_BLOB_BYTES = 24 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 75_000;
const ARMING_READY_FALLBACK_MS = 1500;
const ARMING_PERMISSION_HINT_MS = 600;
const NO_AUDIO_HINT_MS = 4000;
const MAX_DURATION_WARNING_MS = 15_000;

const RETRYABLE_CODES = new Set([
	"busy",
	"rate-limited",
	"provider-error",
	"provider-timeout",
	"provider-unreachable",
]);

const MEDIA_ERROR_MESSAGES = {
	"permission-denied":
		"Microphone access is blocked. Allow it in your browser's site settings and try again.",
	"no-device": "No microphone found.",
	"device-unavailable":
		"The microphone is busy or unavailable. Close other apps using it and try again.",
	overconstrained: "Couldn't start the microphone with the requested settings.",
	aborted: "Microphone access was cancelled.",
	unknown: "Couldn't start the microphone. Try again.",
};

const BLOCKED_MESSAGES = {
	insecure:
		"Voice input needs a secure connection. Open pi-ui over HTTPS (for example your Tailscale https://…ts.net address) or on localhost.",
	unsupported: "This browser can't record audio for voice input.",
	"no-key":
		"Voice input needs a Groq API key. Set GROQ_API_KEY for the pi-ui server (or add a Groq key to pi), then reload.",
};

// --- Module state (one recording session lives on one browser tab). ---
let state = "idle";
let blocked = "";
let generation = 0;

let audioCtx;
let micStream;
let analyser;
let frameBuffer;
let recorder;
let chunks = [];
let levelMeter;
let speechGate;
let barHistory;
let waveform;

let rafId;
let lastFrameTs;
let armingElapsedMs = 0;
let armingHintTimer;
let firstZeroFrameAt;
let noAudioHintShown = false;
let decayEnv = 0;
let reducedMotionAccMs = 0;

let activeAccumulatedMs = 0;
let activeStartedAt = 0;
let isActiveInterval = false;

let savedSelection;
let cameFromMicButton = false;
let retainedBlob;
let retainedMimeType = "";
let retainedActiveMs = 0;
let activeUploadController;
let errorClearTimer;
let resizeObserver;
let colorObserver;

function maxDurationMs() {
	const raw = Number(document.body?.dataset.voiceMaxSeconds);
	return (Number.isFinite(raw) && raw > 0 ? raw : 300) * 1000;
}

function reducedMotion() {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

// --- DOM lookups (queried fresh each time; the panel is data-ignore-morph so it persists, but
// nothing here assumes a cached reference stays valid across a full page re-render). ---
function panelEl() {
	return document.getElementById("prompt-voice-panel");
}
function canvasEl() {
	return document.getElementById("prompt-voice-wave");
}
function timerEl() {
	return document.getElementById("prompt-voice-timer");
}
function labelTextEl() {
	return document.querySelector(".prompt-voice-label-text");
}
function statusEl() {
	return document.getElementById("prompt-voice-status");
}
function micButtonEl() {
	return document.getElementById("prompt-voice-button");
}
function doneButtonEl() {
	return document.getElementById("prompt-voice-done");
}

function dispatchVoiceState() {
	document.getElementById("prompt-box")?.dispatchEvent(
		new CustomEvent("pi-ui-voice-state", {
			bubbles: true,
			detail: { state, blocked },
		}),
	);
}

function setState(next) {
	if (next === state) return;
	if (!canTransition(state, next)) {
		console.error(`voice: illegal state transition ${state} -> ${next}`);
	}
	state = next;
	const panel = panelEl();
	if (panel) panel.hidden = next === "idle";
	dispatchVoiceState();
}

function announce(message) {
	const el = statusEl();
	if (el) el.textContent = message;
}

function updateLabel(text) {
	const el = labelTextEl();
	if (el) el.textContent = text;
}

// --- Elapsed time: summed only over active (recording, not paused) intervals. ---
function beginActiveInterval() {
	if (isActiveInterval) return;
	isActiveInterval = true;
	activeStartedAt = performance.now();
}
function endActiveInterval() {
	if (!isActiveInterval) return;
	isActiveInterval = false;
	activeAccumulatedMs += performance.now() - activeStartedAt;
}
function elapsedMsSnapshot() {
	return (
		activeAccumulatedMs + (isActiveInterval ? performance.now() - activeStartedAt : 0)
	);
}
function resetElapsed() {
	activeAccumulatedMs = 0;
	isActiveInterval = false;
}

function captureCaret() {
	const input = promptInput();
	if (!input) return { start: 0, end: 0 };
	return {
		start: input.selectionStart ?? input.value.length,
		end: input.selectionEnd ?? input.value.length,
	};
}

// --- Errors and blocked explanations (precedent: showTransferError in file-transfer.js). ---
function showError(message, { retryable = false } = {}) {
	const input = promptInput();
	if (!input) return;
	let el = document.getElementById("prompt-voice-error");
	if (!(el instanceof HTMLParagraphElement)) {
		el = document.createElement("p");
		el.id = "prompt-voice-error";
		el.className = "file-transfer-error prompt-voice-error";
		el.setAttribute("role", "alert");
		input.before(el);
	}
	el.replaceChildren();
	const text = document.createElement("span");
	text.textContent = message;
	el.append(text);
	if (retryable) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "btn prompt-voice-error-retry";
		button.dataset.variant = "link";
		button.dataset.size = "xs";
		button.textContent = "Retry";
		button.addEventListener("click", () => {
			clearError();
			void retry();
		});
		el.append(button);
	}
	el.hidden = false;
	clearTimeout(errorClearTimer);
	if (!retryable) errorClearTimer = setTimeout(clearError, 8000);
}

function clearError() {
	clearTimeout(errorClearTimer);
	const el = document.getElementById("prompt-voice-error");
	if (el) {
		el.hidden = true;
		el.replaceChildren();
	}
}

function showNotice(message) {
	showError(message, { retryable: false });
	announce(message);
}

function showBlockedExplanation() {
	showError(BLOCKED_MESSAGES[blocked] ?? "Voice input isn't available.", {
		retryable: false,
	});
}

// --- Teardown: the single cleanup path, idempotent, called from every terminal edge. ---
function stopLoop() {
	if (rafId !== undefined) cancelAnimationFrame(rafId);
	rafId = undefined;
	lastFrameTs = undefined;
}

function onRecorderError(event) {
	console.error("voice: MediaRecorder error", event?.error ?? event);
	showError("Recording failed. Try again.", { retryable: false });
	teardown();
	setState("idle");
}

function onTrackEnded() {
	if (state !== "recording" && state !== "paused") return;
	const hadSpeech = (speechGate?.voicedMs ?? 0) > 0;
	announce(
		hadSpeech
			? "Microphone disconnected — transcribing what was recorded."
			: "Microphone disconnected.",
	);
	void complete();
}

function onVisibilityChange() {
	if (document.hidden && state === "recording") pause();
}

function bindActiveListeners() {
	document.addEventListener("visibilitychange", onVisibilityChange);
}
function removeActiveListeners() {
	document.removeEventListener("visibilitychange", onVisibilityChange);
}

function teardown() {
	stopLoop();
	clearTimeout(armingHintTimer);
	removeActiveListeners();
	resetElapsed();

	if (recorder) {
		recorder.removeEventListener("error", onRecorderError);
		try {
			if (recorder.state !== "inactive") recorder.stop();
		} catch {
			// Already stopping/stopped.
		}
	}
	recorder = undefined;
	chunks = [];

	if (micStream) {
		for (const track of micStream.getTracks()) {
			track.removeEventListener("ended", onTrackEnded);
			track.stop();
		}
	}
	micStream = undefined;

	analyser?.disconnect();
	analyser = undefined;

	if (audioCtx && audioCtx.state !== "closed") {
		audioCtx.close().catch(() => {});
	}
	audioCtx = undefined;

	resizeObserver?.disconnect();
	resizeObserver = undefined;
	colorObserver?.disconnect();
	colorObserver = undefined;

	levelMeter = undefined;
	speechGate = undefined;
	barHistory = undefined;
	decayEnv = 0;
	reducedMotionAccMs = 0;
	noAudioHintShown = false;
	firstZeroFrameAt = undefined;
}

// --- getUserMedia / MediaRecorder plumbing. ---
async function requestMicrophone() {
	const constraints = {
		audio: {
			echoCancellation: { ideal: true },
			noiseSuppression: { ideal: true },
			autoGainControl: { ideal: true },
			channelCount: { ideal: 1 },
			voiceIsolation: { ideal: true },
		},
	};
	try {
		return await navigator.mediaDevices.getUserMedia(constraints);
	} catch (error) {
		if (error?.name === "OverconstrainedError") {
			return await navigator.mediaDevices.getUserMedia({ audio: true });
		}
		throw error;
	}
}

function isTypeSupported(type) {
	return (
		typeof MediaRecorder !== "undefined" &&
		MediaRecorder.isTypeSupported?.(type) === true
	);
}

function setUpObservers() {
	const canvas = canvasEl();
	if (canvas && typeof ResizeObserver !== "undefined") {
		resizeObserver = new ResizeObserver(() => {
			waveform?.resize();
			barHistory?.setCapacity(waveform.barCapacity());
		});
		resizeObserver.observe(canvas);
	}
	if (typeof MutationObserver !== "undefined") {
		colorObserver = new MutationObserver(() => waveform?.readColor());
		colorObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
	}
}

async function start() {
	if (blocked) {
		showBlockedExplanation();
		return;
	}
	if (state !== "idle") return;

	generation += 1;
	const mySession = generation;
	clearError();

	// iOS Safari requires the AudioContext to be created (and resumed) synchronously inside the
	// user gesture, before any `await`. This line runs before the first await below.
	const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
	const ctx = AudioContextCtor ? new AudioContextCtor() : undefined;
	void ctx?.resume();

	cameFromMicButton = document.activeElement === micButtonEl();
	savedSelection = captureCaret();
	armingElapsedMs = 0;
	setState("arming");
	updateLabel("Starting microphone…");
	startLoop();

	armingHintTimer = setTimeout(() => {
		if (state === "arming") updateLabel("Allow microphone access…");
	}, ARMING_PERMISSION_HINT_MS);

	let stream;
	try {
		stream = await requestMicrophone();
	} catch (error) {
		clearTimeout(armingHintTimer);
		if (mySession !== generation) return;
		void ctx?.close();
		stopLoop();
		showError(MEDIA_ERROR_MESSAGES[classifyMediaError(error?.name)], {
			retryable: false,
		});
		setState("idle");
		return;
	}
	clearTimeout(armingHintTimer);
	if (mySession !== generation) {
		for (const track of stream.getTracks()) track.stop();
		void ctx?.close();
		return;
	}
	if (state === "arming") updateLabel("Starting microphone…");

	audioCtx = ctx;
	micStream = stream;

	if (audioCtx) {
		const source = audioCtx.createMediaStreamSource(stream);
		analyser = audioCtx.createAnalyser();
		analyser.fftSize = 1024;
		source.connect(analyser);
		frameBuffer = new Float32Array(analyser.fftSize);
	}

	levelMeter = new LevelMeter();
	speechGate = new SpeechGate();
	waveform = waveform ?? createWaveformRenderer(canvasEl());
	waveform.resize();
	waveform.readColor();
	barHistory = new BarHistory(60, waveform.barCapacity());
	decayEnv = 0;
	reducedMotionAccMs = 0;
	firstZeroFrameAt = undefined;
	noAudioHintShown = false;

	const mimeType = pickMimeType(isTypeSupported);
	try {
		recorder = mimeType
			? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48000 })
			: new MediaRecorder(stream);
	} catch {
		recorder = new MediaRecorder(stream);
	}
	chunks = [];
	recorder.addEventListener("dataavailable", (event) => {
		if (event.data && event.data.size > 0) chunks.push(event.data);
	});
	recorder.addEventListener("error", onRecorderError);
	for (const track of stream.getTracks()) track.addEventListener("ended", onTrackEnded);

	setUpObservers();
	bindActiveListeners();
	recorder.start(1000);
}

function enterRecording() {
	beginActiveInterval();
	setState("recording");
	updateLabel("");
	announce("Recording");
	doneButtonEl()?.focus({ preventScroll: true });
}

function pause() {
	if (state !== "recording") return;
	try {
		recorder?.pause();
	} catch {
		// Ignore: recorder may already be inactive.
	}
	endActiveInterval();
	setState("paused");
	updateLabel("Paused");
	announce("Paused");
}

function resume() {
	if (state !== "paused") return;
	if (
		audioCtx &&
		(audioCtx.state === "suspended" || audioCtx.state === "interrupted")
	) {
		void audioCtx.resume();
	}
	try {
		recorder?.resume();
	} catch {
		// Ignore: recorder may already be active.
	}
	beginActiveInterval();
	setState("recording");
	updateLabel("");
	announce("Resumed");
}

function togglePause() {
	if (state === "recording") pause();
	else if (state === "paused") resume();
}

function restoreFocusToInput() {
	promptInput()?.focus({ preventScroll: true });
}

async function complete() {
	if (state !== "recording" && state !== "paused") return;
	const mySession = generation;
	if (state === "recording") endActiveInterval();
	setState("stopping");
	updateLabel("");

	const finalRecorder = recorder;
	const finalMimeType = finalRecorder?.mimeType || "";
	const activeMs = elapsedMsSnapshot();
	const gate = speechGate;

	await new Promise((resolve) => {
		if (!finalRecorder || finalRecorder.state === "inactive") {
			resolve();
			return;
		}
		finalRecorder.addEventListener("stop", () => resolve(), { once: true });
		try {
			finalRecorder.stop();
		} catch {
			resolve();
		}
	});
	if (mySession !== generation) return;

	const blob = new Blob(chunks, { type: finalMimeType || "audio/webm" });
	teardown();

	if (!(gate?.passes(activeMs) ?? false)) {
		showNotice("Didn't catch any speech. Try again closer to the microphone.");
		setState("idle");
		restoreFocusToInput();
		return;
	}
	if (blob.size > MAX_BLOB_BYTES) {
		showError("Recording is too large. Record a shorter take.", { retryable: false });
		setState("idle");
		restoreFocusToInput();
		return;
	}

	retainedBlob = blob;
	retainedMimeType = finalMimeType;
	retainedActiveMs = activeMs;
	await uploadAndInsert({
		blob,
		mimeType: finalMimeType,
		activeMs,
		session: mySession,
	});
}

function combinedSignal(controller) {
	if ("any" in AbortSignal) {
		return AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		]);
	}
	// Fallback for engines without AbortSignal.any: honour whichever fires first manually.
	const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
	controller.signal.addEventListener("abort", () => clearTimeout(timeout), {
		once: true,
	});
	return controller.signal;
}

async function uploadBlob(blob, mimeType, activeMs, signal) {
	const endpoint = document.body?.dataset.voiceEndpoint || "/voice/transcribe";
	const formData = new FormData();
	formData.set("audio", blob, `voice.${extensionForMime(mimeType)}`);
	if (Number.isFinite(activeMs))
		formData.set("durationMs", String(Math.round(activeMs)));

	let response;
	try {
		response = await fetch(endpoint, { method: "POST", body: formData, signal });
	} catch (error) {
		if (error?.name === "AbortError") throw error;
		return { ok: false, kind: "network" };
	}
	if (response.status === 499) return { ok: false, kind: "aborted" };

	let payload;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}
	if (response.ok) {
		return { ok: true, text: isString(payload?.text) ? payload.text : "" };
	}
	const code = isString(payload?.error) ? payload.error : undefined;
	const message = isString(payload?.message)
		? payload.message
		: isString(payload?.error)
			? payload.error
			: undefined;
	return {
		ok: false,
		kind: "server",
		status: response.status,
		code,
		message,
		retryAfterSeconds: payload?.retryAfterSeconds,
	};
}

function handleUploadFailure(result) {
	if (result.kind === "network") {
		showError("Couldn't reach pi-ui. Check your connection and retry.", {
			retryable: true,
		});
		return;
	}
	if (result.kind === "aborted") return;
	const retryable = RETRYABLE_CODES.has(result.code) || result.status >= 500;
	if (result.message) {
		showError(result.message, { retryable });
	} else {
		showError("Transcription failed. Retry in a moment.", { retryable: true });
	}
}

async function uploadAndInsert({ blob, mimeType, activeMs, session }) {
	setState("transcribing");
	updateLabel("Transcribing…");

	const controller = new AbortController();
	activeUploadController = controller;
	const signal = combinedSignal(controller);

	try {
		const result = await uploadBlob(blob, mimeType, activeMs, signal);
		if (session !== generation) return;
		if (!result.ok) {
			handleUploadFailure(result);
			setState("idle");
			restoreFocusToInput();
			return;
		}
		finishWithTranscript(result.text);
	} catch (error) {
		if (session !== generation) return;
		if (error?.name === "AbortError" && controller.signal.aborted) {
			// The user cancelled; cancel() already handled state/focus.
			return;
		}
		showError("Transcription timed out. Retry in a moment.", { retryable: true });
		setState("idle");
		restoreFocusToInput();
	} finally {
		if (activeUploadController === controller) activeUploadController = undefined;
	}
}

function finishWithTranscript(text) {
	const trimmed = (text ?? "").trim();
	if (trimmed === "") {
		showNotice("Didn't catch any speech. Try again closer to the microphone.");
		setState("idle");
		restoreFocusToInput();
		return;
	}
	const input = promptInput();
	const caret = savedSelection ?? {
		start: input?.value.length ?? 0,
		end: input?.value.length ?? 0,
	};
	if (input) {
		const { value, caret: newCaret } = insertTranscript(
			input.value,
			caret.start,
			caret.end,
			trimmed,
		);
		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.focus({ preventScroll: true });
		input.selectionStart = newCaret;
		input.selectionEnd = newCaret;
	}
	clearError();
	retainedBlob = undefined;
	announce("Transcript inserted");
	setState("idle");
}

function cancel() {
	if (state === "idle") return;
	generation += 1;
	activeUploadController?.abort();
	activeUploadController = undefined;
	teardown();
	retainedBlob = undefined;
	clearError();
	setState("idle");
	announce("Recording cancelled");
	if (cameFromMicButton) micButtonEl()?.focus({ preventScroll: true });
	else restoreFocusToInput();
}

async function retry() {
	if (!retainedBlob || state !== "idle") return;
	const blob = retainedBlob;
	const mimeType = retainedMimeType;
	const activeMs = retainedActiveMs;
	generation += 1;
	const mySession = generation;
	await uploadAndInsert({ blob, mimeType, activeMs, session: mySession });
}

function toggle() {
	if (blocked) {
		showBlockedExplanation();
		return;
	}
	if (state === "idle") {
		void start();
		return;
	}
	if (state === "recording" || state === "paused") {
		void complete();
	}
}

// --- Waveform + timer animation loop. ---
function checkNoAudioHint(hasSignal, now) {
	if (hasSignal) {
		if (noAudioHintShown) {
			noAudioHintShown = false;
			updateLabel("");
		}
		firstZeroFrameAt = undefined;
		return;
	}
	if (firstZeroFrameAt === undefined) firstZeroFrameAt = now;
	if (!noAudioHintShown && now - firstZeroFrameAt >= NO_AUDIO_HINT_MS) {
		noAudioHintShown = true;
		updateLabel("No audio from the microphone — check it isn't muted.");
	}
}

function checkMaxDuration() {
	if (state !== "recording" && state !== "paused") return;
	if (elapsedMsSnapshot() >= maxDurationMs()) {
		announce("Reached the time limit — transcribing.");
		void complete();
	}
}

function updateTimerDisplay() {
	const el = timerEl();
	if (!el) return;
	const elapsed = elapsedMsSnapshot();
	const remaining = maxDurationMs() - elapsed;
	if (remaining <= MAX_DURATION_WARNING_MS) {
		el.textContent = `${formatElapsed(elapsed)} / ${formatElapsed(maxDurationMs())}`;
		el.dataset.voiceWarning = "";
	} else {
		el.textContent = formatElapsed(elapsed);
		delete el.dataset.voiceWarning;
	}
}

function pushBar(value, dtMs) {
	if (!barHistory) return;
	if (reducedMotion()) {
		reducedMotionAccMs += dtMs;
		if (reducedMotionAccMs >= 250) {
			barHistory.push(value, reducedMotionAccMs);
			reducedMotionAccMs = 0;
		}
	} else {
		barHistory.push(value, dtMs);
	}
}

function render(liveValue) {
	if (!waveform) return;
	if (state === "arming") {
		if (reducedMotion()) waveform.clear();
		else waveform.drawArming(armingElapsedMs);
		return;
	}
	if (state === "recording") {
		waveform.draw(
			barHistory.bars,
			liveValue,
			reducedMotion() ? 0 : barHistory.bucketProgress,
		);
		return;
	}
	if (state === "paused") {
		waveform.draw(barHistory.bars, decayEnv, 0);
	}
}

function loopFrame(now) {
	const dt = lastFrameTs ? Math.min(now - lastFrameTs, 250) : 16;
	lastFrameTs = now;

	let liveValue = 0;
	if (state === "arming" || state === "recording") {
		armingElapsedMs += dt;
		if (analyser) {
			analyser.getFloatTimeDomainData(frameBuffer);
			let hasSignal = false;
			for (let i = 0; i < frameBuffer.length; i += 1) {
				if (frameBuffer[i] !== 0) {
					hasSignal = true;
					break;
				}
			}
			const result = levelMeter.update(frameBuffer, dt);
			liveValue = result.env;
			if (
				state === "arming" &&
				(hasSignal || armingElapsedMs >= ARMING_READY_FALLBACK_MS)
			) {
				enterRecording();
			} else if (state === "recording") {
				checkNoAudioHint(hasSignal, now);
				speechGate.pushFrame(result.voiced, dt);
				pushBar(liveValue, dt);
				checkMaxDuration();
			}
		}
	} else if (state === "paused") {
		decayEnv = updateEnvelope(decayEnv, 0, dt);
		liveValue = decayEnv;
	}

	render(liveValue);
	if (state === "recording" || state === "paused") updateTimerDisplay();
	rafId = requestAnimationFrame(loopFrame);
}

function startLoop() {
	stopLoop();
	lastFrameTs = undefined;
	rafId = requestAnimationFrame(loopFrame);
}

// --- Keyboard (capture phase, so it runs before the textarea's/#prompt-action's bubble-phase
// handlers) and a11y wiring, bound once for the page's lifetime. ---
function hasOpenDismissible() {
	if (window.piUi?.pickers?.isOpen?.()) return true;
	if (document.querySelector(":modal")) return true;
	return Boolean(
		document.querySelector(
			"[popover]:popover-open:not([data-slot='tooltip-content'])",
		),
	);
}

function onWindowKeydown(event) {
	if (state === "idle") return;
	if (
		event.code === "Escape" &&
		!event.ctrlKey &&
		!event.metaKey &&
		!event.altKey &&
		!event.shiftKey
	) {
		if (hasOpenDismissible()) return;
		event.preventDefault();
		event.stopPropagation();
		cancel();
		return;
	}
	if (
		event.key === "Enter" &&
		!event.shiftKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		!event.altKey &&
		!event.isComposing &&
		!(event.target instanceof HTMLButtonElement) &&
		(state === "recording" || state === "paused")
	) {
		event.preventDefault();
		event.stopPropagation();
		void complete();
	}
}

function computeBlockedReason() {
	return blockedReason({
		isSecureContext: window.isSecureContext === true,
		hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
		hasMediaRecorder: typeof MediaRecorder !== "undefined",
		voiceStatus: document.body?.dataset.voiceStatus,
	});
}

/** Binds voice input once, at page load. Called from main.js's DOMContentLoaded. */
export function bindVoice() {
	blocked = computeBlockedReason();
	dispatchVoiceState();
	window.addEventListener("keydown", onWindowKeydown, true);
	window.addEventListener("pagehide", () => {
		if (state !== "idle") cancel();
	});
	promptInput()?.addEventListener("input", () => clearError());
}

function publicState() {
	return {
		state,
		blocked,
		liveTracks: micStream
			? micStream.getTracks().filter((track) => track.readyState === "live").length
			: 0,
		audioContextState: audioCtx ? audioCtx.state : "none",
		elapsedMs: elapsedMsSnapshot(),
	};
}

export const voice = {
	toggle,
	start: () => void start(),
	pause,
	resume,
	togglePause,
	complete: () => void complete(),
	cancel,
	retry: () => void retry(),
	state: publicState,
};

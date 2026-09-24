// Canvas drawing for the voice-input waveform. All the math (bar heights, envelope, noise floor)
// lives in voice-core.js; this module only turns numbers into pixels.

export const BAR_WIDTH = 3;
export const BAR_GAP = 2;
export const PITCH = BAR_WIDTH + BAR_GAP;
const MIN_BAR_HEIGHT = 2;
const EDGE_INSET = 4;
const ARM_SWEEP_PERIOD_MS = 1200;
const ARM_SIGMA_BARS = 3;
const ARM_AMPLITUDE = 0.35;
const ARM_FLOOR = 0.05;

function clamp01(value) {
	return Math.min(1, Math.max(0, value));
}

/**
 * Left x (CSS px) of a waveform bar. `index` -1 is the live (still-filling) bar; 0 is the newest
 * completed bar, and so on back in time. The whole strip — live bar included — glides left by one
 * pitch per bucket, so when a bucket completes the live bar lands exactly where completed bar 0
 * starts: nothing jumps, and the gap between neighbours never changes. With `bucketProgress` 0
 * (reduced motion) the live bar is flush with the right edge.
 */
export function barX(index, cssWidth, bucketProgress) {
	return cssWidth - BAR_WIDTH - PITCH * (index + 1) - PITCH * clamp01(bucketProgress);
}

/** Creates a renderer bound to one `<canvas>`. Call `resize()` whenever its box changes. */
export function createWaveformRenderer(canvas) {
	const ctx = canvas.getContext("2d");
	let dpr = 1;
	let cssWidth = 1;
	let cssHeight = 1;
	let color = "currentColor";

	function resize() {
		const rect = canvas.getBoundingClientRect();
		cssWidth = Math.max(1, Math.round(rect.width));
		cssHeight = Math.max(1, Math.round(rect.height));
		dpr = window.devicePixelRatio || 1;
		const targetWidth = Math.round(cssWidth * dpr);
		const targetHeight = Math.round(cssHeight * dpr);
		if (canvas.width !== targetWidth) canvas.width = targetWidth;
		if (canvas.height !== targetHeight) canvas.height = targetHeight;
	}

	function readColor() {
		color = (ctx && getComputedStyle(canvas).color) || "currentColor";
	}

	/** How many bars fit across the canvas, plus a couple extra so the scroll never gaps. */
	function barCapacity() {
		return Math.max(1, Math.ceil(cssWidth / PITCH) + 2);
	}

	function drawBar(x, heightFraction, alpha) {
		const maxH = Math.max(MIN_BAR_HEIGHT, cssHeight - EDGE_INSET);
		const h = MIN_BAR_HEIGHT + clamp01(heightFraction) * (maxH - MIN_BAR_HEIGHT);
		const y = (cssHeight - h) / 2;
		ctx.globalAlpha = alpha;
		ctx.beginPath();
		if ("roundRect" in ctx) {
			ctx.roundRect(x, y, BAR_WIDTH, h, BAR_WIDTH / 2);
		} else {
			ctx.rect(x, y, BAR_WIDTH, h);
		}
		ctx.fill();
	}

	function beginFrame() {
		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssWidth, cssHeight);
		ctx.fillStyle = color;
	}

	/**
	 * @param {number[]} bars Oldest-to-newest completed bar heights (0..1).
	 * @param {number} liveValue Current envelope value (0..1) for the still-filling newest bar.
	 * @param {number} bucketProgress 0..1 fraction through the current bucket, for sub-bar scroll.
	 */
	function draw(bars, liveValue, bucketProgress) {
		beginFrame();
		drawBar(barX(-1, cssWidth, bucketProgress), liveValue, 0.9);
		// Slots older than the recording so far draw as floor dots, so the strip spans the whole
		// canvas from the first frame (silence reads as a dotted baseline, never as empty space).
		for (let i = 0; ; i += 1) {
			const x = barX(i, cssWidth, bucketProgress);
			if (x + BAR_WIDTH < 0) break;
			drawBar(x, i < bars.length ? bars[bars.length - 1 - i] : 0, 0.9);
		}
		ctx.restore();
	}

	/** Muted travelling bump across the floor, shown before real audio is flowing. */
	function drawArming(elapsedMs) {
		beginFrame();
		const capacity = barCapacity();
		const phase =
			((elapsedMs % ARM_SWEEP_PERIOD_MS) / ARM_SWEEP_PERIOD_MS) * capacity;
		for (let i = 0; i < capacity; i += 1) {
			const x = cssWidth - PITCH * (i + 1);
			if (x + BAR_WIDTH < 0) break;
			const distance = Math.min(
				Math.abs(i - phase),
				Math.abs(i - phase + capacity),
				Math.abs(i - phase - capacity),
			);
			const bump =
				ARM_AMPLITUDE *
				Math.exp(-(distance * distance) / (2 * ARM_SIGMA_BARS ** 2));
			drawBar(x, ARM_FLOOR + bump, 0.5);
		}
		ctx.restore();
	}

	function clear() {
		beginFrame();
		ctx.restore();
	}

	return { barCapacity, clear, draw, drawArming, readColor, resize };
}

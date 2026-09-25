import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { BAR_GAP, BAR_WIDTH, barX, PITCH } from "./voice-waveform.js";

const width = 300;

test("the live bar sits flush with the right edge at the start of a bucket", () => {
	assertEquals(barX(-1, width, 0), width - BAR_WIDTH);
});

test("completed bars keep the normal bar gap to the live bar throughout a bucket", () => {
	for (const progress of [0, 0.25, 0.5, 0.99]) {
		const live = barX(-1, width, progress);
		const newest = barX(0, width, progress);
		assertEquals(live - (newest + BAR_WIDTH), BAR_GAP);
	}
});

test("the strip is continuous across a bucket boundary: no bar jumps when one is pushed", () => {
	// Just before the push, the live bar and every completed bar sit a hair
	// short of one pitch left of their bucket-start position; right after the
	// push the live bar becomes completed bar 0, bar i becomes bar i + 1.
	const almostFull = 1 - 1e-9;
	const epsilon = 1e-6;
	const near = (a: number, b: number) => Math.abs(a - b) < epsilon;
	assertEquals(near(barX(-1, width, almostFull), barX(0, width, 0)), true);
	for (let index = 0; index < 5; index += 1) {
		assertEquals(
			near(barX(index, width, almostFull), barX(index + 1, width, 0)),
			true,
		);
	}
});

test("every bar moves left by exactly one pitch over one bucket", () => {
	assertEquals(barX(3, width, 0) - barX(3, width, 1), PITCH);
});

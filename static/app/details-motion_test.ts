import { test } from "bun:test";
import { readFileSync } from "node:fs";

import { assert, assertEquals } from "#testing/assertions";

import { chevronTurns, nextDetailsIntent, settleDetails } from "./details-motion.js";

/** The declarations of the (first) rule whose selector is exactly `selector`. */
function ruleBody(file: string, selector: string): string {
	const css = readFileSync(new URL(file, import.meta.url), "utf8");
	const start = css.indexOf(`${selector} {`);
	assert(start >= 0, `${file} has a \`${selector}\` rule`);
	return css.slice(start, css.indexOf("}", start));
}

test("a click toggles a resting details", () => {
	assertEquals(nextDetailsIntent(true, undefined), false);
	assertEquals(nextDetailsIntent(false, undefined), true);
});

test("a click mid-flight reverses the latest intent, not the DOM state", () => {
	// While either direction animates the details stays open in the DOM.
	assertEquals(nextDetailsIntent(true, { wantOpen: false }), true);
	assertEquals(nextDetailsIntent(true, { wantOpen: true }), false);
});

test("close, then click again mid-flight, ends open", () => {
	const details = { open: true };
	const closing = { wantOpen: nextDetailsIntent(details.open, undefined) };
	const reopening = { wantOpen: nextDetailsIntent(details.open, closing) };
	// The cancelled close never settles; only the latest intent may.
	assertEquals(settleDetails(details, closing, reopening), false);
	assertEquals(details.open, true);
	assertEquals(settleDetails(details, reopening, reopening), true);
	assertEquals(details.open, true);
});

test("open, then click again mid-flight, ends closed", () => {
	const details = { open: false };
	const opening = { wantOpen: nextDetailsIntent(details.open, undefined) };
	details.open = true; // opened synchronously for the animation
	const closing = { wantOpen: nextDetailsIntent(details.open, opening) };
	assertEquals(settleDetails(details, opening, closing), false);
	assertEquals(settleDetails(details, closing, closing), true);
	assertEquals(details.open, false);
});

test("the WAAPI chevron turn mirrors the CSS it stands in for", () => {
	const { context, piui } = chevronTurns;
	const icon = ruleBody("../../src/ui/messages.css", "	.context-chevron-icon");
	assert(
		icon.includes(`${context.property}: ${context.closed};`),
		"context closed turn",
	);
	const openIcon = ruleBody(
		"../../src/ui/messages.css",
		".context-details[open] > .context-summary .context-chevron-icon",
	);
	assert(
		openIcon.includes(`${context.property}: ${context.open};`),
		"context open turn",
	);
	const marker = ruleBody(
		"../../src/ui/pi-ui-elements.css",
		".piui-widget-lines-collapsible summary::before",
	);
	assert(
		marker.includes(`transition: ${piui.property} `),
		"PIUI marker turns on transform",
	);
	assert(!marker.includes(`${piui.property}:`), "PIUI closed marker is untransformed");
	const openMarker = ruleBody(
		"../../src/ui/pi-ui-elements.css",
		".piui-widget-lines-collapsible[open] summary::before",
	);
	assert(openMarker.includes(`${piui.property}: ${piui.open};`), "PIUI open turn");
});

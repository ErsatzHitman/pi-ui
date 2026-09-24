import { test } from "bun:test";

import { assertStringIncludes } from "#testing/assertions";

const html = await Bun.file(new URL("./offline.html", import.meta.url)).text();

test("the offline page links the public favicon, so it logs no /favicon.ico 404", () => {
	assertStringIncludes(
		html,
		'<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
	);
});

test("the offline page's own colors are OKLCH, like the rest of pi-ui", () => {
	const hex = html.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
	if (hex.length > 0) throw new Error(`hex colors left: ${hex.join(", ")}`);
});

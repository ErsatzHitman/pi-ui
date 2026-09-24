import { test } from "bun:test";

import { assertEquals, assertStringIncludes } from "#testing/assertions";

import { renderServiceWorkerScript } from "./service-worker-script.ts";

test("is a classic (non-module) script with no imports", () => {
	const script = renderServiceWorkerScript("abc123");
	assertEquals(script.includes("import "), false);
	assertEquals(script.includes("export "), false);
});

test("embeds the given app version into a versioned cache name", () => {
	const script = renderServiceWorkerScript("abc123");
	assertStringIncludes(script, 'const CACHE_NAME = "pi-ui-offline-abc123"');

	const other = renderServiceWorkerScript("def456");
	assertStringIncludes(other, 'const CACHE_NAME = "pi-ui-offline-def456"');
});

test("only intercepts navigation requests, and only to add an offline fallback", () => {
	const script = renderServiceWorkerScript("abc123");
	assertStringIncludes(script, 'if (event.request.mode !== "navigate") return;');
	assertStringIncludes(script, "caches.match(OFFLINE_URL)");
});

test("precaches the offline page on install and calls skipWaiting", () => {
	const script = renderServiceWorkerScript("abc123");
	assertStringIncludes(script, "cache.add(OFFLINE_URL)");
	assertStringIncludes(script, "self.skipWaiting()");
});

test("drops every other pi-ui offline cache on activate and claims clients", () => {
	const script = renderServiceWorkerScript("abc123");
	assertStringIncludes(script, "caches.delete(name)");
	assertStringIncludes(script, 'name.startsWith("pi-ui-offline-")');
	assertStringIncludes(script, "self.clients.claim()");
});

test("is syntactically valid JavaScript", () => {
	// `new Function` throws a SyntaxError for anything that doesn't parse. `self`,
	// `caches`, `fetch` etc. are unresolved identifiers here, which is fine —
	// this only checks the syntax, never executes the body.
	// eslint-disable-next-line no-new-func
	new Function(renderServiceWorkerScript("abc123"));
});

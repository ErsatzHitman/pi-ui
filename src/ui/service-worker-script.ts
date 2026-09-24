/**
 * Renders the minimal PWA service worker (round RM2 "pwa"): network-only — it
 * never serves a cached response instead of the network for HTML, `/stream`,
 * or any API/authenticated request — with one narrow, explicit exception: a
 * tiny, precached offline page for a navigation that fails outright (the
 * server is unreachable), so a lost connection shows "Can't reach your pi-ui
 * server" instead of the browser's own generic offline page.
 *
 * Served dynamically (`routes/service-worker.ts`'s `GET /sw.js`), not as a
 * static file, so its content embeds the current `appVersion`: the cache name
 * changes on every deploy, `activate` drops every other pi-ui offline cache,
 * and `skipWaiting()`/`clients.claim()` mean the new worker takes over
 * immediately rather than waiting for every open tab to close first — the
 * existing `appVersion` reload gate (`routes/stream.ts`) already reloads a
 * tab running stale assets, so nothing here needs to strand a client on an
 * old worker to stay consistent with it.
 *
 * A classic (non-module) script deliberately: module service workers aren't
 * Baseline-newly-available yet, and this needs no imports.
 */
export function renderServiceWorkerScript(appVersion: string): string {
	// `appVersion` is always the static-asset content hash (`static-assets.ts`), a
	// short hex string — never untrusted input — so it's safe to embed directly
	// both in the JS identifier below and via JSON.stringify for the comment.
	const cacheName = `pi-ui-offline-${appVersion}`;
	return `// Generated for pi-ui ${JSON.stringify(appVersion)} — see src/ui/service-worker-script.ts.
const CACHE_NAME = ${JSON.stringify(cacheName)};
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter((name) => name !== CACHE_NAME && name.startsWith("pi-ui-offline-"))
						.map((name) => caches.delete(name)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

// Network-only: every request goes straight to the network. The only
// exception is a failed *navigation* (mode === "navigate"), where the
// precached offline page stands in for a connection error instead of the
// browser's own no-connectivity interstitial. Nothing is ever cached from a
// live response — never HTML, never /stream, never an API or authenticated
// request — so nothing here can ever serve stale or private data.
self.addEventListener("fetch", (event) => {
	if (event.request.mode !== "navigate") return;
	event.respondWith(
		fetch(event.request).catch(() => caches.match(OFFLINE_URL)),
	);
});
`;
}

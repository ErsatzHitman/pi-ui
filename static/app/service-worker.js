/**
 * Registers the network-only PWA service worker (round RM2 "pwa",
 * `src/ui/service-worker-script.ts` renders `/sw.js`). Registered unconditionally,
 * in local mode too: it caches nothing but a tiny offline fallback page, so there's
 * no downside locally, and it lets a local pi-ui also be installed as an app.
 * `static/app/push.js` reuses the same registration for `PushManager.subscribe`.
 */
let registration;

export function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) return Promise.resolve(undefined);
	registration ??= navigator.serviceWorker.register("/sw.js").catch(() => undefined);
	return registration;
}

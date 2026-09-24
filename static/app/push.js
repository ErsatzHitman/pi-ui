/**
 * Web Push opt-in (round RM2 "pwa"): keeps the browser's `PushSubscription` in
 * sync with the same "Notify on completion" bell toggle that opts a tab into
 * the in-page Web Notification (`notifications.js`, `src/client/live-workspace.ts`).
 * Subscribing only happens in remote mode — local mode's client never calls
 * `PushManager.subscribe` at all, so the server-side `PushService` gate
 * (`isRemoteMode()` there too) is defence in depth, not the only thing keeping
 * local mode silent.
 */
import { endpoints } from "../../src/server/routes/endpoints.ts";

/** `PushManager.subscribe`'s `applicationServerKey` wants a raw `Uint8Array`,
 * not the base64url string the server hands the page. */
export function base64UrlToUint8Array(base64url) {
	const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
	const base64 = `${base64url}${padding}`.replaceAll("-", "+").replaceAll("_", "/");
	const raw = atob(base64);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

function subscriptionRequestBody(subscription) {
	const json = subscription.toJSON();
	return {
		endpoint: json.endpoint,
		keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
	};
}

export function createPushOptIn(options) {
	async function ensureSubscribed() {
		if (
			!options.isRemoteMode() ||
			!options.applicationServerKey ||
			options.getPermission() !== "granted"
		) {
			return;
		}
		const registration = await options.getRegistration();
		if (!registration?.pushManager) return;
		try {
			const subscription =
				(await registration.pushManager.getSubscription()) ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: options.toApplicationServerKey(
						options.applicationServerKey,
					),
				}));
			await options.post(
				endpoints.pushSubscribe,
				subscriptionRequestBody(subscription),
			);
		} catch {
			// Best-effort: the in-page Web Notification (this tab, while open) still
			// works even if the push subscription itself never succeeds.
		}
	}

	async function ensureUnsubscribed() {
		const registration = await options.getRegistration();
		const subscription = await registration?.pushManager?.getSubscription();
		if (!subscription) return;
		const body = subscriptionRequestBody(subscription);
		try {
			await subscription.unsubscribe();
		} finally {
			await options.post(endpoints.pushUnsubscribe, { endpoint: body.endpoint });
		}
	}

	return { ensureSubscribed, ensureUnsubscribed };
}

async function postJson(url, body) {
	await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function bindPushOptIn({ getRegistration } = {}) {
	const pushOptIn = createPushOptIn({
		isRemoteMode: () => "remoteMode" in document.body.dataset,
		applicationServerKey: document.body.dataset.pushPublicKey,
		getPermission: () =>
			typeof Notification === "undefined" ? "denied" : Notification.permission,
		getRegistration:
			getRegistration ??
			(async () => {
				const { registerServiceWorker } = await import("./service-worker.js");
				return registerServiceWorker();
			}),
		toApplicationServerKey: base64UrlToUint8Array,
		post: postJson,
	});

	document.body.addEventListener("pi-ui-live-workspace-preferences", (event) => {
		if (event.detail?.notifications) {
			void pushOptIn.ensureSubscribed();
		} else {
			void pushOptIn.ensureUnsubscribed();
		}
	});

	// The toggle only fires that event on click; a preference already on from a
	// previous visit (a persisted signal) needs its own sync once permission and
	// the service worker are both available.
	if (window.piUi.liveWorkspace?.notificationsOptedIn?.()) {
		void pushOptIn.ensureSubscribed();
	}

	return pushOptIn;
}

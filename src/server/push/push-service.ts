/**
 * Wires "a session finished" (foreground or background) to Web Push: fans a notification out
 * to every stored subscription, but only when it's actually needed. Called
 * from `RuntimeController.notifyRuntimeDone` (`activationOptions.sendWebPush`,
 * wired in `app.ts`) alongside the existing SSE-based `AppStore.notifySessionFinished`.
 */
import { isRemoteMode } from "../../remote-mode.ts";
import type { SessionDoneNotification } from "../../system-notifications.ts";
import { sendWebPush as sendWebPushDefault } from "./send-push.ts";
import type { PushSubscriptionStore } from "./subscription-store.ts";
import type { VapidKeyPair } from "./vapid-keys.ts";

export interface PushHub {
	/** Connected clients whose page is visible (see `DatastarClientHub`). */
	readonly visibleClientCount: number;
}

export interface PushServiceOptions {
	readonly vapidKeys: VapidKeyPair;
	/** RFC 8292 `sub` contact URI, e.g. `mailto:you@example.com`. */
	readonly vapidSubject: string;
	readonly subscriptions: Pick<PushSubscriptionStore, "list" | "remove">;
	readonly hub: PushHub;
	readonly sendWebPush?: typeof sendWebPushDefault;
	readonly isRemoteMode?: () => boolean;
	/** The shared "Notify on completion" preference (the Live Workspace bell). A device
	 * keeps its subscription when the bell is switched off elsewhere, so this is what
	 * actually stops pushes. Defaults to always on (tests). */
	readonly isOptedIn?: () => boolean;
}

/**
 * Sends a push only when nobody is looking: no connected client reports a
 * visible page. Counting every open `/stream` instead missed the common phone
 * case — a backgrounded (frozen/suspended) PWA or a tab parked in the
 * back/forward cache keeps its stream open, yet can run no in-page
 * notification. A hidden tab of a browser that HAS a push subscription skips
 * its own in-page notice (`static/app/push.js`'s `covers()`), so the SW's push
 * notification is the only one it shows. Push is remote-mode-only: local mode's
 * client never calls `PushManager.subscribe` (`static/app/push.js`), so this
 * gate is defence in depth, not the only thing keeping local mode silent.
 */
export class PushService {
	constructor(private readonly options: PushServiceOptions) {}

	/** `background: false` is the foreground run (the one a phone prompted before its
	 * app was closed), titled like the in-page "Turn finished" notice. */
	async notifySessionFinished(
		details: SessionDoneNotification,
		background = true,
	): Promise<void> {
		const remote = this.options.isRemoteMode?.() ?? isRemoteMode();
		if (!remote || this.options.isOptedIn?.() === false) return;
		if (this.options.hub.visibleClientCount > 0) return;

		const subscriptions = await this.options.subscriptions.list();
		if (subscriptions.length === 0) return;

		const send = this.options.sendWebPush ?? sendWebPushDefault;
		// `allSettled`, not `all`: `sendWebPush()` itself never rejects (a network-level
		// `fetchImpl` failure resolves to `{ outcome: "network-error" }`, see send-push.ts), but
		// this is defence in depth for the documented invariant on the caller
		// (`RuntimeControllerActivationOptions.sendWebPush`'s doc comment: "a push failure must
		// never affect the session runtime") — one endpoint's send throwing unexpectedly (an
		// injected override, a future refactor, `subscriptions.remove()` itself) must never stop
		// the others from being attempted or reject this method.
		const results = await Promise.allSettled(
			subscriptions.map(async (subscription) => {
				const result = await send({
					subscription,
					payload: {
						title: background
							? "Background session finished"
							: "Turn finished",
						body: details.workspace,
						tag: details.sessionPath ?? details.workspace,
						sessionPath: details.sessionPath,
					},
					vapidKeys: this.options.vapidKeys,
					vapidSubject: this.options.vapidSubject,
				});
				if (result.outcome === "gone") {
					await this.options.subscriptions.remove(subscription.endpoint);
				}
			}),
		);
		for (const result of results) {
			if (result.status === "rejected") {
				console.error("Web Push send failed", result.reason);
			}
		}
	}
}

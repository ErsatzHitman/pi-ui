/**
 * Wires "a background session finished" to Web Push: fans a notification out
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
	readonly clientCount: number;
}

export interface PushServiceOptions {
	readonly vapidKeys: VapidKeyPair;
	/** RFC 8292 `sub` contact URI, e.g. `mailto:you@example.com`. */
	readonly vapidSubject: string;
	readonly subscriptions: Pick<PushSubscriptionStore, "list" | "remove">;
	readonly hub: PushHub;
	readonly sendWebPush?: typeof sendWebPushDefault;
	readonly isRemoteMode?: () => boolean;
}

/**
 * Sends a push only when it can actually reach someone that the existing
 * in-page Web Notification (`static/app/notifications.js`, driven by the SSE
 * `session-finished` effect) cannot: no browser tab has an open `/stream`
 * connection right now. This is also the de-duplication rule — a tab that's
 * open (visible or hidden) already gets the in-page notification, so it never
 * also gets a push for the same event. Push is remote-mode-only: local mode's
 * client never calls `PushManager.subscribe` (`static/app/push.js`), so this
 * gate is defence in depth, not the only thing keeping local mode silent.
 */
export class PushService {
	constructor(private readonly options: PushServiceOptions) {}

	async notifySessionFinished(details: SessionDoneNotification): Promise<void> {
		const remote = this.options.isRemoteMode?.() ?? isRemoteMode();
		if (!remote || this.options.hub.clientCount > 0) return;

		const subscriptions = await this.options.subscriptions.list();
		if (subscriptions.length === 0) return;

		const send = this.options.sendWebPush ?? sendWebPushDefault;
		await Promise.all(
			subscriptions.map(async (subscription) => {
				const result = await send({
					subscription,
					payload: {
						title: "Background session finished",
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
	}
}

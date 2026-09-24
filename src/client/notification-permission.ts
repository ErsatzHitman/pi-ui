/**
 * Extracted from `live-workspace.ts` so it can be unit-tested on its own: that file assigns to
 * `window.piUi` at module scope (a browser-only side effect), so it can never be `import`ed
 * directly from `bun test`.
 */

/** Returns a promise that resolves once the permission decision is settled — immediately if
 * `Notification` doesn't exist or the person already answered (granted/denied), otherwise once
 * `Notification.requestPermission()`'s (user-gesture-gated) prompt resolves. The notifications
 * toggle's click handler (`src/ui/live-workspace.tsx`) awaits this before dispatching
 * `pi-ui-live-workspace-preferences`, so `static/app/push.js`'s `ensureSubscribed()` — which only
 * calls `PushManager.subscribe()` when permission is already `"granted"` — sees the just-granted
 * permission on the very first opt-in click instead of only on a later click or page reload. */
export function requestNotificationPermission(): Promise<void> {
	if (typeof Notification === "undefined" || Notification.permission !== "default") {
		return Promise.resolve();
	}
	return Notification.requestPermission().then(() => undefined);
}

/** True while this browser hasn't answered the notification prompt yet. The bell's
 * preference is shared by every device (server-side), so a device can find it already
 * on without ever having been asked: its click then asks instead of switching it off. */
export function needsNotificationPermission(): boolean {
	return typeof Notification !== "undefined" && Notification.permission === "default";
}

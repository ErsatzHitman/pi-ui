/**
 * "Background session finished" Web Notifications (round RM1 "notifications"). The server
 * broadcasts a `sessionFinished(detail)` call to every connected tab whenever a *background*
 * session completes (see `AppStore.notifySessionFinished` and `UiRenderer.mainEffectScripts`'s
 * `session-finished` effect) — this module decides, per tab, whether that is worth surfacing.
 *
 * The *foreground* session already gets a "Turn finished" notification from
 * `src/client/live-workspace.ts`'s `notifyTurnEvent`, which this deliberately does not
 * duplicate; both read the same "Notify on completion" opt-in
 * (`window.piUi.liveWorkspace.notificationsOptedIn()`, backed by the persisted
 * `liveWorkspacePreferences.notifications` signal) and the same browser `Notification`
 * permission — never requested here, only from that toggle's own click (a user gesture).
 *
 * Cross-tab de-duplication (never show the same finished session twice across tabs of the
 * same browser) relies on the Notification `tag`: same-origin notifications with the same tag
 * replace one another rather than stacking, so every tab may call `createNotification`, but the
 * browser shows just one. `detail.id` (a monotonically increasing per-server counter) additionally
 * guards a single tab against acting on a duplicate or out-of-order call.
 */
export function createSessionNotifier(options) {
	let lastShownId;

	function sessionFinished(detail) {
		if (!detail) return false;
		if (!options.isOptedIn()) return false;
		if (options.getPermission() !== "granted") return false;
		// The viewer is already looking at this tab — nothing to surface.
		if (!options.isHidden() && options.hasFocus()) return false;
		// Hidden, and this browser is push-subscribed: the server pushes whenever no tab
		// is visible, and the service worker shows that one — never both (push.js).
		if (options.isHidden() && options.pushCovers?.()) return false;
		if (lastShownId !== undefined && detail.id <= lastShownId) return false;
		lastShownId = detail.id;

		const notification = options.createNotification("Background session finished", {
			body: detail.workspace,
			tag: detail.sessionPath || detail.workspace || "pi-ui-background-session",
			icon: "/notification-icon.png",
		});
		if (notification) {
			notification.onclick = () => {
				options.focusWindow();
				notification.close?.();
			};
		}
		return true;
	}

	return { sessionFinished };
}

function notificationPermission() {
	if (typeof Notification === "undefined") return "denied";
	return Notification.permission;
}

function createBrowserNotification(title, init) {
	if (typeof Notification === "undefined") return undefined;
	return new Notification(title, init);
}

export function bindNotifications() {
	return createSessionNotifier({
		isOptedIn: () => Boolean(window.piUi.liveWorkspace?.notificationsOptedIn?.()),
		getPermission: notificationPermission,
		isHidden: () => document.hidden,
		hasFocus: () => document.hasFocus(),
		createNotification: createBrowserNotification,
		focusWindow: () => window.focus(),
		pushCovers: () => Boolean(window.piUi.push?.covers()),
	});
}

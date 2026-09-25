import { realpath, stat } from "node:fs/promises";

// pi does not publicly export its provisioner. A static import lets Bun bundle it.
import { ensureTool } from "../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js";
import { parseAutoTitleConfig, type AutoTitleConfig } from "../agent/auto-title.ts";
import {
	applyExtensionsHostMarker,
	type ExtensionsConfig,
	parseExtensionsConfig,
} from "../agent/extensions-config.ts";
import { RuntimeController } from "../agent/runtime-controller.ts";
import { SessionTransitionController } from "../agent/session-transition-controller.ts";
import { defaultCodeThemes, validCodeThemes } from "../code-themes.ts";
import { defaultFonts, setActiveFonts, validFonts } from "../fonts.ts";
import { parseKeybindOverrides, setActiveKeybinds } from "../keybinds.ts";
import { normalizeLiveWorkspacePreferences } from "../live-workspace-types.ts";
import { setActiveCodeTheme } from "../pierre-theme.ts";
import { resolveExclusiveRightPane } from "../right-pane-preferences.ts";
import {
	normalizeSessionSidebarPreferences,
	sessionSidebarWidthDefault,
} from "../session-sidebar-types.ts";
import { AppStore } from "../state/app-store.ts";
import { loadPierreLanguage } from "../ui/diffs.ts";
import { UiRenderer } from "../ui/ui-renderer.ts";
import { checkForUpdate } from "../update-check.ts";
import { expandHomePath } from "../utils/workspace.ts";
import { normalizeWorkspaceReviewPreferences } from "../workspace-review-types.ts";
import { ensureAppConfig } from "./app-config.ts";
import { DatastarClientHub } from "./datastar-client-hub.ts";
import { PushService } from "./push/push-service.ts";
import { PushSubscriptionStore } from "./push/subscription-store.ts";
import { loadOrCreateVapidKeys } from "./push/vapid-keys.ts";
import type { RouteContext, RouteResources } from "./routes/context.ts";
import { SessionImageStore } from "./session-image-store.ts";
import { createStaticAssetServer } from "./static-assets.ts";
import { staticRoot } from "./static-path.ts";
import { TransferredFileStore } from "./transferred-files.ts";
import { createGroqTranscriber } from "./voice/groq-transcriber.ts";
import { parseVoiceConfig } from "./voice/voice-config.ts";
import { resolveGroqApiKey } from "./voice/voice-key.ts";
import { createVoiceService } from "./voice/voice-service.ts";
import { WorkspaceReviewController } from "./workspace-review-controller.ts";

/** RFC 8292 `sub` contact URI a push service may use if this server's VAPID
 * key ever misbehaves. Not user-facing and not configurable yet: any valid
 * URI satisfies the RFC, and pi-ui has no notion of an operator email. */
const vapidSubject = "mailto:pi-ui@localhost";

export async function createApp() {
	const fdReady = ensureTool("fd", ({ message }) => console.error(message));
	const staticAssets = await createStaticAssetServer(staticRoot);
	const appConfig = await ensureAppConfig();
	setActiveKeybinds(parseKeybindOverrides(appConfig.keybinds));
	const codeTheme = validCodeThemes(appConfig.codeTheme) ?? defaultCodeThemes();
	const fonts = validFonts(appConfig.fonts) ?? defaultFonts();
	const autoTitle = parseAutoTitleConfig(appConfig.autoTitle);
	const extensions = parseExtensionsConfig(appConfig.extensions);
	const voiceConfig = parseVoiceConfig(appConfig.voice);
	const voiceService = createVoiceService({
		config: voiceConfig,
		resolveKey: () => resolveGroqApiKey(),
		transcriber: createGroqTranscriber({ appVersion: staticAssets.version }),
	});
	// Must run before the first `RuntimeController.create()` below, which loads
	// extensions synchronously with session creation.
	applyExtensionsHostMarker(extensions);
	const workspaceReviewPreferences = normalizeWorkspaceReviewPreferences(
		appConfig.gitView,
	);
	const rawLiveWorkspacePreferences = normalizeLiveWorkspacePreferences(
		appConfig.liveWorkspace,
	);
	const sessionSidebar = normalizeSessionSidebarPreferences(appConfig.sessionSidebar);
	// Sessions and Live Workspace share the right-hand area and are mutually exclusive; an old
	// config saved before that rule existed can have both `open: true` (see
	// `right-pane-preferences.ts`).
	const { sessionSidebarOpen, liveWorkspaceOpen } = resolveExclusiveRightPane(
		sessionSidebar.open !== false,
		rawLiveWorkspacePreferences.open === true,
	);
	const liveWorkspacePreferences = {
		...rawLiveWorkspacePreferences,
		open: liveWorkspaceOpen,
	};
	setActiveCodeTheme(codeTheme);
	setActiveFonts(fonts);
	const preloadShellHighlighterPromise = loadPierreLanguage("bash");
	const store = new AppStore();
	// Opt-in: this fork doesn't publish releases, and the upstream notice would offer
	// an installer that replaces this build with @hyperpuncher/pi-ui.
	if (appConfig.updateCheck === true && process.env.PI_UI_NO_UPDATE_CHECK !== "1") {
		void checkForUpdate().then((update) => {
			if (update) store.setUpdateAvailable(update);
		});
	}
	store.setWorkspaceReviewPreferences(workspaceReviewPreferences);
	store.setLiveWorkspacePreferences(liveWorkspacePreferences);
	const sessionImages = new SessionImageStore();
	const hub = new DatastarClientHub();
	const renderer = new UiRenderer(store, hub, {
		registerImage: (image) => sessionImages.register(image),
		clearImages: () => sessionImages.clear(),
	});
	const transitions = new SessionTransitionController((transition) =>
		store.setSessionTransition(transition),
	);
	const vapidKeys = await loadOrCreateVapidKeys();
	const pushSubscriptions = new PushSubscriptionStore();
	const pushService = new PushService({
		vapidKeys,
		vapidSubject,
		subscriptions: pushSubscriptions,
		hub,
		isOptedIn: () => store.liveWorkspacePreferences.notifications === true,
	});
	const host = await RuntimeController.create(store, undefined, {
		autoTitle,
		extensionsMode: extensions.mode,
		extensionsTerminalChrome: extensions.terminalChrome,
		extensionsActivityTracking: extensions.activityTracking,
		extensionsActivityPersist: extensions.activityPersist,
		transitionController: transitions,
		sendWebPush: (details, background) =>
			pushService.notifySessionFinished(details, background),
	}).catch((error: ErrorOptions["cause"]) => {
		console.error("Failed to start pi SDK runtime", error);
		return undefined;
	});
	if (!(await preloadShellHighlighterPromise)) {
		console.error("Failed to preload shell highlighter");
	}
	const workspaceReview = new WorkspaceReviewController(store);
	workspaceReview.open(store.workspacePath);
	const fdPath = await fdReady;
	const resources: RouteResources = { host, sessionImages, fdPath };
	const transferredFiles = await TransferredFileStore.create();
	const context: RouteContext = {
		store,
		renderer,
		resources,
		transferredFiles,
		pushPublicKey: vapidKeys.publicKeyRaw.toString("base64url"),
		pushSubscriptions,
		voice: voiceService,
		appVersion: staticAssets.version,
		keybindHints: appConfig.keybindHints !== false,
		minimalMode: appConfig.minimalMode === true,
		sessionSidebarOpen,
		sessionSidebarWidth: sessionSidebar.width ?? sessionSidebarWidthDefault,
		toolOutputHidden: appConfig.toolOutputHidden === true,
		toolbarHidden: appConfig.toolbarHidden === true,
		themeLab: process.env.PI_UI_THEME_LAB === "1",
		serveStatic: (request) => staticAssets.serve(request),
		openWorkspace: (path) =>
			openWorkspace(path, store, resources, transitions, autoTitle, extensions),
	};
	let disposal: Promise<void> | undefined;
	return {
		context,
		dispose: () => {
			disposal ??= (async () => {
				workspaceReview.dispose();
				// Stops the SSE heartbeat timer.
				hub.dispose();
				await Promise.allSettled([
					transferredFiles.dispose(),
					resources.host?.dispose(),
				]);
			})();
			return disposal;
		},
	};
}

async function openWorkspace(
	workspacePath: string,
	store: AppStore,
	resources: RouteResources,
	transitions: SessionTransitionController,
	autoTitle: AutoTitleConfig,
	extensions: ExtensionsConfig,
): Promise<boolean> {
	const requestedPath = workspacePath.trim();
	const transition = await transitions.run(
		requestedPath,
		async () => {
			const realPath = await realpath(expandHomePath(requestedPath));
			if (!(await stat(realPath)).isDirectory()) {
				throw new Error("Not a directory");
			}
			if (!resources.host) {
				resources.host = await RuntimeController.create(store, realPath, {
					autoTitle,
					extensionsMode: extensions.mode,
					extensionsTerminalChrome: extensions.terminalChrome,
					extensionsActivityTracking: extensions.activityTracking,
					extensionsActivityPersist: extensions.activityPersist,
					refreshWorkspaces: false,
					transitionController: transitions,
				});
				return true;
			}
			return await resources.host.openWorkspace(realPath);
		},
		{ overlay: false },
	);
	return transition.status === "success";
}

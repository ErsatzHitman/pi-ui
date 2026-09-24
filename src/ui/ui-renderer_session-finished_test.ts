import { test } from "bun:test";

import { assertStringIncludes } from "#testing/assertions";

import { DatastarClientHub } from "../server/datastar-client-hub.ts";
import { AppStore } from "../state/app-store.ts";
import { UiRenderer } from "./ui-renderer.ts";

test("a session-finished effect executes a client script on every connected client", async () => {
	const store = new AppStore();
	const hub = new DatastarClientHub();
	new UiRenderer(store, hub);
	const controller = new AbortController();
	const response = hub.createStream(controller.signal, () => ({
		elements: "",
		signals: "{}",
	}));

	store.notifySessionFinished({
		workspace: "/workspace",
		sessionPath: "/sessions/a.jsonl",
	});
	await Promise.resolve();
	await Promise.resolve();
	controller.abort();

	const body = await response.text();
	assertStringIncludes(body, "window.piUi.notifications");
	assertStringIncludes(body, "sessionFinished");
	assertStringIncludes(body, "/sessions/a.jsonl");
	assertStringIncludes(body, "/workspace");
});

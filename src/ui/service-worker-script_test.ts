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

/** Runs the rendered worker against a fake `self`, collecting its listeners. */
function loadWorker(
	network: (request: unknown) => Promise<Response> = () =>
		Promise.reject(new TypeError("offline")),
) {
	const listeners = new Map<string, (event: unknown) => void>();
	const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
	const opened: string[] = [];
	const focused: string[] = [];
	const windows: Array<{
		url: string;
		focused: boolean;
		visibilityState: string;
		focus: () => Promise<unknown>;
	}> = [];
	const self = {
		location: { origin: "https://pi.example" },
		addEventListener: (type: string, listener: (event: unknown) => void) => {
			listeners.set(type, listener);
		},
		registration: {
			showNotification: (title: string, options: Record<string, unknown>) => {
				shown.push({ title, options });
				return Promise.resolve();
			},
		},
		clients: {
			matchAll: () => Promise.resolve(windows),
			openWindow: (url: string) => {
				opened.push(url);
				return Promise.resolve(undefined);
			},
		},
	};
	// eslint-disable-next-line no-new-func
	const offlinePage = new Response("offline page", { status: 200 });
	const caches = { match: () => Promise.resolve(offlinePage) };
	new Function("self", "caches", "fetch", renderServiceWorkerScript("abc123"))(
		self,
		caches,
		network,
	);
	async function dispatch(type: string, event: Record<string, unknown>) {
		let pending: Promise<unknown> = Promise.resolve();
		listeners.get(type)?.({
			...event,
			waitUntil: (promise: Promise<unknown>) => {
				pending = promise;
			},
			respondWith: (promise: Promise<unknown>) => {
				pending = promise;
			},
		});
		return pending;
	}
	function addWindow(url: string, isFocused = false, visibilityState = "hidden") {
		windows.push({
			url,
			focused: isFocused,
			visibilityState,
			focus: () => {
				focused.push(url);
				return Promise.resolve();
			},
		});
	}
	return { dispatch, shown, opened, focused, addWindow };
}

test("shows every push as a notification (userVisibleOnly), from its JSON payload", async () => {
	const worker = loadWorker();
	await worker.dispatch("push", {
		data: {
			json: () => ({
				title: "Turn finished",
				body: "~/work",
				tag: "/sessions/x.jsonl",
				sessionPath: "/sessions/x.jsonl",
			}),
		},
	});
	assertEquals(worker.shown, [
		{
			title: "Turn finished",
			options: {
				body: "~/work",
				tag: "/sessions/x.jsonl",
				icon: "/notification-icon.png",
				data: { sessionPath: "/sessions/x.jsonl" },
			},
		},
	]);
});

test("still shows a notification for a push with no or unreadable payload", async () => {
	const worker = loadWorker();
	await worker.dispatch("push", { data: null });
	await worker.dispatch("push", {
		data: {
			json: () => {
				throw new SyntaxError("bad json");
			},
		},
	});
	assertEquals(
		worker.shown.map((entry) => entry.title),
		["pi-ui", "pi-ui"],
	);
});

test("a notification click focuses an open pi-ui window, else opens the app", async () => {
	const close = () => {};
	const worker = loadWorker();
	await worker.dispatch("notificationclick", { notification: { close } });
	assertEquals(worker.opened, ["/"]);

	worker.addWindow("https://pi.example/");
	await worker.dispatch("notificationclick", { notification: { close } });
	assertEquals(worker.focused, ["https://pi.example/"]);
	assertEquals(worker.opened, ["/"]);
});

test("is syntactically valid JavaScript", () => {
	// `new Function` throws a SyntaxError for anything that doesn't parse. `self`,
	// `caches`, `fetch` etc. are unresolved identifiers here, which is fine —
	// this only checks the syntax, never executes the body.
	// eslint-disable-next-line no-new-func
	new Function(renderServiceWorkerScript("abc123"));
});

test("a push arriving while a pi-ui window is focused and visible shows nothing (someone is looking)", async () => {
	// The server only pushes while no tab reports itself visible, but a report can be
	// late or lost; Chrome requires no notification while the origin is in the foreground.
	const worker = loadWorker();
	worker.addWindow("https://pi.example/", true, "visible");
	await worker.dispatch("push", {
		data: { json: () => ({ title: "Turn finished", body: "~/work" }) },
	});
	assertEquals(worker.shown, []);

	const background = loadWorker();
	background.addWindow("https://pi.example/", false, "hidden");
	await background.dispatch("push", {
		data: { json: () => ({ title: "Turn finished", body: "~/work" }) },
	});
	assertEquals(background.shown.length, 1);
});

test("a navigation the proxy answers with 502/503/504 (pi-ui itself down) gets the offline page too", async () => {
	for (const status of [502, 503, 504]) {
		const worker = loadWorker(() =>
			Promise.resolve(new Response("bad gateway", { status })),
		);
		const response = (await worker.dispatch("fetch", {
			request: { mode: "navigate" },
		})) as Response;
		assertEquals(await response.text(), "offline page");
	}
	const ok = loadWorker(() => Promise.resolve(new Response("app", { status: 200 })));
	assertEquals(
		await (
			(await ok.dispatch("fetch", { request: { mode: "navigate" } })) as Response
		).text(),
		"app",
	);
	const unauthorized = loadWorker(() =>
		Promise.resolve(new Response("login", { status: 401 })),
	);
	assertEquals(
		await (
			(await unauthorized.dispatch("fetch", {
				request: { mode: "navigate" },
			})) as Response
		).text(),
		"login",
	);
	const unreachable = loadWorker();
	assertEquals(
		await (
			(await unreachable.dispatch("fetch", {
				request: { mode: "navigate" },
			})) as Response
		).text(),
		"offline page",
	);
});

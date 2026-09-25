#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Standalone CDP browser validation for DESIGN-ext-activity.md §5.4 — NOT matched by
// `bun test`. Run directly: `bun run src/e2e-browser/extension-activity.cdp.ts`.
//
// Spawns a REAL `pi-ui` server (this repo's own `src/server-main.ts`) against a throwaway
// `PI_CODING_AGENT_DIR`/workspace/cache/data directory holding the fake stream provider and
// the fake activity extensions (`#testing/fake-stream-provider`, `#testing/fake-activity-extensions`)
// — never the user's real `~/.pi/agent` and never a real model — and drives it with a real
// headless Chrome over the DevTools Protocol (raw HTTP + WebSocket JSON-RPC; no
// puppeteer/playwright dependency). It proves, against real rendered pixels and real CSS:
//
//   1. Called -> Currently working (pink, `.status-dot-active` resolves to `--status-active`)
//      -> Output/result -> Completed, and the finished card and its hidden payload STAY
//      visible after the fake extension clears its own status/widget.
//   2. The card survives a page reload, a second browser tab, and a full server restart +
//      `/sessions/resume` (replayed from the persisted `pi-ui.extension-activity` entries).
//   3. No horizontal overflow at 390px.
//   4. Screenshots: light/dark x 390/768/1280, for both the "working" and "done" moments,
//      saved to `<screenshotsDir>/{state}-{scheme}-{width}.png` (default: this file's
//      `../../.cdp-shots`; override with `EXT_ACTIVITY_SHOTS_DIR`).
//
// Everything it starts (Chrome, the pi-ui server) is killed before the process exits, on
// both success and failure.
import { spawn, type NullSubprocess, type ReadableSubprocess } from "bun";

import {
	fakeActivityMarkers,
	writeFakeActivityExtensionFiles,
} from "../testing/fake-activity-extensions.ts";
import {
	fakeStreamModelRef,
	writeFakeStreamProviderExtensionFile,
} from "../testing/fake-stream-provider.ts";
import type { JsonObject, JsonValue } from "../utils/json-types.ts";
import { isNumber, isRecord, isString } from "../utils/type-guards.ts";

const serverPort = Number(process.env.EXT_ACTIVITY_SERVER_PORT ?? 46100);
const cdpPort = Number(process.env.EXT_ACTIVITY_CDP_PORT ?? 9463);
const serverHost = "127.0.0.1";
const serverUrl = `http://${serverHost}:${serverPort}`;
const shotsDir =
	process.env.EXT_ACTIVITY_SHOTS_DIR ?? join(import.meta.dir, "..", "..", ".cdp-shots");

const widths = [390, 768, 1280] as const;
const viewportHeight = { 390: 844, 768: 1024, 1280: 800 } as const;
const schemes = ["light", "dark"] as const;

const scriptStart = Date.now();

function log(message: string): void {
	console.log(
		`[extension-activity.cdp +${((Date.now() - scriptStart) / 1000).toFixed(1)}s] ${message}`,
	);
}

function fail(message: string): never {
	throw new Error(message);
}

// ---------------------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------------------

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	for (;;) {
		try {
			const response = await fetch(url);
			if (response.ok || response.status < 500) {
				await response.body?.cancel();
				return;
			}
		} catch (error) {
			lastError = error;
		}
		if (Date.now() >= deadline) {
			fail(`Timed out waiting for ${url}: ${String(lastError ?? "no response")}`);
		}
		await Bun.sleep(100);
	}
}

async function killProcess(
	child: ReadableSubprocess | NullSubprocess | undefined,
	label: string,
): Promise<void> {
	if (!child) return;
	if (child.killed) return;
	try {
		child.kill();
		await child.exited;
	} catch (error) {
		log(`Failed to stop ${label} cleanly: ${String(error)}`);
	}
}

function findChromeExecutable(): string {
	const override = process.env.EXT_ACTIVITY_CHROME_PATH ?? process.env.CHROME_PATH;
	if (override) return override;
	const candidates =
		process.platform === "win32"
			? [
					"C:/Program Files/Google/Chrome/Application/chrome.exe",
					"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
					`${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
					"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
					"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
				]
			: process.platform === "darwin"
				? [
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Chromium.app/Contents/MacOS/Chromium",
					]
				: [
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium",
						"/usr/bin/chromium-browser",
					];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	fail(
		"No Chrome/Edge/Chromium executable found. Set EXT_ACTIVITY_CHROME_PATH to override.",
	);
}

// ---------------------------------------------------------------------------------------
// Minimal Chrome DevTools Protocol client: raw HTTP (`/json/*`) + one JSON-RPC WebSocket
// per target. No puppeteer/playwright — this repo has neither as a dependency, and the
// protocol surface this script needs (Page, Runtime, Emulation) is small.
// ---------------------------------------------------------------------------------------

type CdpTarget = { id: string; webSocketDebuggerUrl: string };

/** A CDP command's params, or a JSON-RPC `result`/`Runtime.evaluate` return value: any
 * JSON-serializable shape (`../utils/json-types.ts`'s own recursive JSON type), since this
 * thin client stays generic over the whole protocol rather than typing each of the handful
 * of domains (Page/Runtime/Emulation) it uses. Each call site narrows it to its own
 * concrete, documented response shape (see `evaluate`, `openTarget`, `screenshot`) with the
 * repo's own `isRecord`/`isString`/`isNumber` guards, rather than passing it around loosely
 * typed or reaching for a raw `typeof` check outside one of those guards. */
type CdpParams = Readonly<Record<string, JsonValue>>;

async function openTarget(url: string): Promise<CdpTarget> {
	const response = await fetch(
		`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`,
		{ method: "PUT" },
	);
	if (!response.ok) fail(`Chrome /json/new failed: ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || !isString(body.id) || !isString(body.webSocketDebuggerUrl)) {
		fail(`Chrome /json/new returned an unexpected shape: ${JSON.stringify(body)}`);
	}
	return { id: body.id, webSocketDebuggerUrl: body.webSocketDebuggerUrl };
}

async function closeTarget(targetId: string): Promise<void> {
	await fetch(`http://127.0.0.1:${cdpPort}/json/close/${targetId}`, {
		method: "PUT",
	}).catch(() => {});
}

type PendingCdpCall = Readonly<{
	resolve: (value: JsonValue) => void;
	reject: (error: Error) => void;
}>;

class CdpSession {
	#ws: WebSocket;
	#nextId = 1;
	#pending = new Map<number, PendingCdpCall>();
	#ready: Promise<void>;

	constructor(webSocketDebuggerUrl: string) {
		this.#ws = new WebSocket(webSocketDebuggerUrl);
		this.#ready = new Promise((resolve, reject) => {
			this.#ws.addEventListener("open", () => resolve());
			this.#ws.addEventListener("error", () =>
				reject(
					new Error(`WebSocket connection to ${webSocketDebuggerUrl} failed`),
				),
			);
		});
		this.#ws.addEventListener("message", (event) => {
			const parsed: unknown = JSON.parse(String(event.data));
			if (!isRecord(parsed) || !isNumber(parsed.id)) return; // an unsolicited event; ignored
			const pending = this.#pending.get(parsed.id);
			if (!pending) return;
			this.#pending.delete(parsed.id);
			const cdpError = isRecord(parsed.error) ? parsed.error : undefined;
			if (cdpError && isString(cdpError.message)) {
				pending.reject(new Error(cdpError.message));
				return;
			}
			// SAFETY: every CDP command response's `result` field is itself
			// JSON-serializable (it came from `JSON.parse` on a WebSocket text frame),
			// so it is a `JsonValue` by construction; this class's own contract (see
			// `send`) is that each call site further narrows it to that method's
			// documented, concrete response shape.
			pending.resolve((parsed.result ?? null) as JsonValue);
		});
	}

	async ready(): Promise<void> {
		await this.#ready;
	}

	send(method: string, params: CdpParams = {}): Promise<JsonValue> {
		const id = this.#nextId++;
		const call = new Promise<JsonValue>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#ws.send(JSON.stringify({ id, method, params }));
		});
		return call.catch((error: Error) => {
			throw new Error(`CDP ${method} failed: ${error.message}`);
		});
	}

	close(): void {
		this.#ws.close();
	}
}

type EvaluateResult = Readonly<{
	result: Readonly<JsonObject>;
	exceptionDetails?: Readonly<JsonObject>;
}>;

function isEvaluateResult(value: JsonValue): value is EvaluateResult {
	return isRecord(value) && isRecord(value.result);
}

/** Evaluates `expression` in the page and returns its (JSON-serializable) value, awaiting
 * a returned promise. Throws with the page-side error message if it rejects/throws. */
async function evaluate<Value extends JsonValue>(
	session: CdpSession,
	expression: string,
): Promise<Value> {
	const raw = await session.send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (!isEvaluateResult(raw)) {
		fail(`Unexpected Runtime.evaluate response: ${JSON.stringify(raw)}`);
	}
	const exceptionDetails = raw.exceptionDetails;
	if (exceptionDetails && isRecord(exceptionDetails)) {
		const exception = isRecord(exceptionDetails.exception)
			? exceptionDetails.exception
			: undefined;
		const description =
			exception && isString(exception.description)
				? exception.description
				: undefined;
		const text = isString(exceptionDetails.text)
			? exceptionDetails.text
			: "unknown error";
		fail(`Page evaluation threw: ${description ?? text}`);
	}
	// SAFETY: `Value` is the type this call site's own `expression` is written to produce
	// (declared by the caller, e.g. `evaluate<boolean>(...)`); `Runtime.evaluate` with
	// `returnByValue: true` returns exactly that expression's JSON-serialized result.
	return (raw.result.value ?? null) as Value;
}

async function navigate(session: CdpSession, url: string): Promise<void> {
	await session.send("Page.enable");
	await session.send("Runtime.enable");
	await session.send("Page.navigate", { url });
	// Poll instead of waiting on a one-shot `Page.loadEventFired` event (this client
	// doesn't special-case events vs command responses): a page that has finished loading
	// answers `document.readyState` immediately, which is all this needs.
	await pollUntil(
		() => evaluate<boolean>(session, "document.readyState === 'complete'"),
		{ timeoutMs: 15_000, message: `page never finished loading ${url}` },
	);
}

async function pollUntil(
	predicate: () => Promise<boolean>,
	options: { timeoutMs: number; intervalMs?: number; message: string },
): Promise<void> {
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) fail(`Timed out: ${options.message}`);
		await Bun.sleep(options.intervalMs ?? 100);
	}
}

async function setViewportAndScheme(
	session: CdpSession,
	width: number,
	height: number,
	scheme: "light" | "dark",
): Promise<void> {
	await session.send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: width < 600,
	});
	await session.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: scheme }],
	});
}

async function screenshot(session: CdpSession, path: string): Promise<void> {
	const raw = await session.send("Page.captureScreenshot", { format: "png" });
	if (!isRecord(raw) || !isString(raw.data)) {
		fail(`Unexpected Page.captureScreenshot response: ${JSON.stringify(raw)}`);
	}
	await Bun.write(path, Buffer.from(raw.data, "base64"));
}

// ---------------------------------------------------------------------------------------
// pi-ui-specific driving helpers
// ---------------------------------------------------------------------------------------

async function selectFakeModel(session: CdpSession): Promise<void> {
	const ok = await evaluate<boolean>(
		session,
		`fetch(${JSON.stringify("/model")}, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: ${JSON.stringify(fakeStreamModelRef)} }),
		}).then((r) => r.ok)`,
	);
	if (!ok) fail("Selecting the fake stream model failed.");
}

/** Fires the `/prompt` POST without awaiting its response: the route only responds once
 * the whole turn has finished (`context.host.prompt()`'s own contract — the same reason
 * `RuntimeController.prompt()` isn't awaited directly in `e2e-streaming` tests either), so
 * awaiting it here would block this script past the entire "working" window it needs to
 * screenshot. Progress is instead observed the same way a real browser tab would see it:
 * polling the DOM for the SSE-patched activity card. A later failure is still caught by
 * `window.__extActivityPromptError`, checked by `checkPromptDelivered`. */
async function submitPrompt(session: CdpSession, prompt: string): Promise<void> {
	await evaluate<boolean>(
		session,
		`(() => {
			window.__extActivityPromptError = null;
			fetch(${JSON.stringify("/prompt")}, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: ${JSON.stringify(prompt)} }),
			})
				.then((r) => { if (!r.ok) window.__extActivityPromptError = "HTTP " + r.status; })
				.catch((e) => { window.__extActivityPromptError = String(e); });
			return true;
		})()`,
	);
}

async function checkPromptDelivered(session: CdpSession): Promise<void> {
	const error = await evaluate<string | null>(
		session,
		"window.__extActivityPromptError ?? null",
	);
	if (error) fail(`Submitting the prompt failed: ${error}`);
}

async function resumeSession(session: CdpSession, sessionPath: string): Promise<void> {
	const ok = await evaluate<boolean>(
		session,
		`fetch(${JSON.stringify("/sessions/resume")}, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionPath: ${JSON.stringify(sessionPath)} }),
		}).then((r) => r.ok)`,
	);
	if (!ok) fail(`Resuming session ${sessionPath} failed.`);
}

async function hasActivityCard(
	session: CdpSession,
	extensionId: string,
	state: string,
): Promise<boolean> {
	return evaluate<boolean>(
		session,
		`Array.from(document.querySelectorAll('[data-activity-extension="${extensionId}"][data-activity-state="${state}"]')).length > 0`,
	);
}

/** Finds the newest `.jsonl` session file under `<agentDir>/sessions/**`. */
async function findNewestSessionFile(agentDir: string): Promise<string> {
	const sessionsRoot = join(agentDir, "sessions");
	const found: { path: string; mtimeMs: number }[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
			} else if (entry.name.endsWith(".jsonl")) {
				const stat = await Bun.file(entryPath).stat();
				found.push({ path: entryPath, mtimeMs: stat?.mtime?.getTime() ?? 0 });
			}
		}
	}
	await walk(sessionsRoot);
	if (found.length === 0) fail(`No session .jsonl file found under ${sessionsRoot}`);
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	// SAFETY: `found.length === 0` already returned above.
	return found[0]!.path;
}

/** `.status-dot-active`'s computed `color` must equal `--status-active` resolved the same
 * way (a fresh element styled directly with `color: var(--status-active)`), and must clear
 * a 3:1 contrast ratio against `--surface-base` (§4.4's accessibility contrast target). */
async function checkActiveDotColor(session: CdpSession): Promise<void> {
	const report = await evaluate<{
		dotColor: string;
		tokenColor: string;
		contrastRatio: number;
	}>(
		session,
		`(() => {
			const dot = document.querySelector('.status-dot-active');
			if (!dot) throw new Error('no .status-dot-active element found');
			const dotColor = getComputedStyle(dot).color;
			const probe = document.createElement('span');
			probe.style.color = 'var(--status-active)';
			document.body.appendChild(probe);
			const tokenColor = getComputedStyle(probe).color;
			const bg = document.createElement('span');
			bg.style.color = 'var(--surface-base)';
			document.body.appendChild(bg);
			const bgColor = getComputedStyle(bg).color;
			probe.remove();
			bg.remove();
			function toRgbBytes(colorString) {
				// getComputedStyle can answer in oklch()/oklab(), which a plain regex
				// can't parse (negative a/b components, no rgb() wrapper) — render one
				// pixel on a canvas and read it back, which forces the browser's own
				// color pipeline to resolve it to concrete sRGB bytes.
				const canvas = document.createElement('canvas');
				canvas.width = 1;
				canvas.height = 1;
				const ctx = canvas.getContext('2d');
				ctx.fillStyle = colorString;
				ctx.fillRect(0, 0, 1, 1);
				return ctx.getImageData(0, 0, 1, 1).data;
			}
			function luminance(colorString) {
				const [r, g, b] = toRgbBytes(colorString);
				const [rs, gs, bs] = [r, g, b].map((c) => {
					const s = c / 255;
					return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
				});
				return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
			}
			const l1 = luminance(dotColor);
			const l2 = luminance(bgColor);
			const lighter = Math.max(l1, l2);
			const darker = Math.min(l1, l2);
			const contrastRatio = (lighter + 0.05) / (darker + 0.05);
			return { dotColor, tokenColor, contrastRatio };
		})()`,
	);
	log(
		`dotColor=${report.dotColor} tokenColor=${report.tokenColor} contrastRatio=${report.contrastRatio}`,
	);
	if (report.dotColor !== report.tokenColor) {
		fail(
			`.status-dot-active color (${report.dotColor}) does not resolve to --status-active (${report.tokenColor})`,
		);
	}
	if (report.contrastRatio < 3) {
		fail(
			`--status-active contrast against --surface-base is only ${report.contrastRatio.toFixed(2)}:1 (need >= 3:1)`,
		);
	}
	log(
		`--status-active resolves to ${report.dotColor}, contrast ${report.contrastRatio.toFixed(2)}:1`,
	);
}

async function checkNoHorizontalOverflow(session: CdpSession): Promise<void> {
	const overflow = await evaluate<boolean>(
		session,
		"document.documentElement.scrollWidth > window.innerWidth",
	);
	if (overflow) fail("Page overflows horizontally at 390px width.");
}

async function captureStateScreenshots(
	session: CdpSession,
	label: "working" | "done",
): Promise<void> {
	for (const scheme of schemes) {
		for (const width of widths) {
			await setViewportAndScheme(session, width, viewportHeight[width], scheme);
			if (width === 390) await checkNoHorizontalOverflow(session);
			await screenshot(session, join(shotsDir, `${label}-${scheme}-${width}.png`));
			log(`  shot ${label}-${scheme}-${width} done`);
		}
	}
	// Restore a normal desktop viewport for whatever runs next.
	await setViewportAndScheme(session, 1280, 800, "light");
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

async function pipeToParent(
	stream: ReadableStream<Uint8Array>,
	sink: (text: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		sink(`[pi-ui server] ${decoder.decode(chunk)}`);
	}
}

async function spawnServer(
	agentDir: string,
	cwd: string,
	cacheDir: string,
	dataDir: string,
): Promise<ReadableSubprocess> {
	const child = spawn({
		cmd: [
			process.execPath,
			"run",
			join(import.meta.dir, "..", "server-main.ts"),
			"--host",
			serverHost,
			"--port",
			String(serverPort),
			"--workspace",
			cwd,
		],
		cwd: join(import.meta.dir, "..", ".."),
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_UI_CACHE_DIR: cacheDir,
			PI_UI_DATA_DIR: dataDir,
			// Generous: long enough for `captureStateScreenshots` to get through every
			// viewport/scheme combination (viewport switch + screenshot round trip over
			// CDP, x6) while the card is still "working" — see fake-activity-extensions.ts.
			FAKE_VISION_WORKING_MS: "8000",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	void pipeToParent(child.stdout, (text) => process.stdout.write(text));
	void pipeToParent(child.stderr, (text) => process.stderr.write(text));
	await waitForHttpOk(serverUrl, 20_000);
	return child;
}

async function main(): Promise<void> {
	await mkdir(shotsDir, { recursive: true });
	const root = await mkdtemp(join(tmpdir(), "pi-ui-ext-activity-cdp-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const cacheDir = join(root, "cache");
	const dataDir = join(root, "data");
	const userDataDir = join(root, "chrome-profile");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await mkdir(cacheDir, { recursive: true });
	await mkdir(dataDir, { recursive: true });
	await writeFakeStreamProviderExtensionFile(agentDir);
	await writeFakeActivityExtensionFiles(agentDir);

	let server: ReadableSubprocess | undefined;
	let chrome: NullSubprocess | undefined;
	let session: CdpSession | undefined;
	let secondSession: CdpSession | undefined;
	let target: CdpTarget | undefined;
	let secondTarget: CdpTarget | undefined;

	try {
		log(`Starting pi-ui server on ${serverUrl} (PI_CODING_AGENT_DIR=${agentDir})`);
		server = await spawnServer(agentDir, cwd, cacheDir, dataDir);

		log(`Launching headless Chrome (CDP port ${cdpPort})`);
		chrome = spawn({
			cmd: [
				findChromeExecutable(),
				"--headless=new",
				`--remote-debugging-port=${cdpPort}`,
				`--user-data-dir=${userDataDir}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-gpu",
				"--disable-extensions",
				"--hide-scrollbars",
				"about:blank",
			],
			stdout: "ignore",
			stderr: "ignore",
		});
		await waitForHttpOk(`http://127.0.0.1:${cdpPort}/json/version`, 15_000);

		target = await openTarget(serverUrl);
		session = new CdpSession(target.webSocketDebuggerUrl);
		await session.ready();
		await navigate(session, serverUrl);
		await selectFakeModel(session);

		log("Submitting the Vision-Proxy-style prompt (a slow status-only hook)");
		await submitPrompt(session, fakeDirectivesText(fakeActivityMarkers.visionHook));

		log("Waiting for the card to reach working (pink, pulsing)");
		await pollUntil(() => hasActivityCard(session!, "fake-vision", "working"), {
			timeoutMs: 10_000,
			message:
				'[data-activity-extension="fake-vision"][data-activity-state="working"] never appeared',
		});
		await checkPromptDelivered(session);
		await checkActiveDotColor(session);
		log("Capturing 'working' screenshots (light/dark x 390/768/1280)");
		await captureStateScreenshots(session, "working");

		log("Waiting for the fake-vision status chip to clear...");
		await pollUntil(
			async () =>
				evaluate<boolean>(
					session!,
					`document.querySelector('[data-extension-status="fake-vision"]') === null`,
				),
			{ timeoutMs: 10_000, message: "the fake-vision status chip never cleared" },
		);
		log(
			"Waiting for the card to finish (done) and confirming it OUTLIVES the cleared status",
		);
		await pollUntil(() => hasActivityCard(session!, "fake-vision", "done"), {
			timeoutMs: 10_000,
			message:
				'[data-activity-extension="fake-vision"][data-activity-state="done"] never appeared',
		});
		// Re-check 5s later: the card must still be there, not swept away once the
		// extension's own signal cleared.
		await Bun.sleep(5_000);
		if (!(await hasActivityCard(session, "fake-vision", "done"))) {
			fail("The finished fake-vision card disappeared after its status cleared.");
		}
		// The hidden-payload section sits inside a `<details>`, collapsed by default
		// (DESIGN-ext-activity.md §4.2) — present in the DOM, but excluded from
		// `.innerText` while collapsed, so this checks the raw markup instead.
		const hiddenPayloadShown = await evaluate<boolean>(
			session,
			`document.body.innerHTML.includes('A red square.') && document.body.innerHTML.includes('hidden in terminal')`,
		);
		if (!hiddenPayloadShown) {
			fail(
				"The display:false payload ('A red square.') is not shown, collapsed, in the card.",
			);
		}
		log("Capturing 'done' screenshots (light/dark x 390/768/1280)");
		await captureStateScreenshots(session, "done");

		log("Reloading the page: the card must persist");
		await session.send("Page.reload");
		await pollUntil(
			() => evaluate<boolean>(session!, "document.readyState === 'complete'"),
			{
				timeoutMs: 15_000,
				message: "page never finished reloading",
			},
		);
		if (!(await hasActivityCard(session, "fake-vision", "done"))) {
			fail("The finished card did not survive a page reload.");
		}

		log("Opening a second tab: the card must be visible there too");
		secondTarget = await openTarget(serverUrl);
		secondSession = new CdpSession(secondTarget.webSocketDebuggerUrl);
		await secondSession.ready();
		await navigate(secondSession, serverUrl);
		if (!(await hasActivityCard(secondSession, "fake-vision", "done"))) {
			fail(
				"The finished card is not visible in a second, independently opened tab.",
			);
		}
		secondSession.close();
		await closeTarget(secondTarget.id);
		secondSession = undefined;
		secondTarget = undefined;

		const sessionPath = await findNewestSessionFile(agentDir);
		log(`Restarting the pi-ui server and resuming session ${sessionPath}`);
		session.close();
		await closeTarget(target.id);
		session = undefined;
		target = undefined;
		await killProcess(server, "pi-ui server");
		server = await spawnServer(agentDir, cwd, cacheDir, dataDir);

		target = await openTarget(serverUrl);
		session = new CdpSession(target.webSocketDebuggerUrl);
		await session.ready();
		await navigate(session, serverUrl);
		await resumeSession(session, sessionPath);
		await pollUntil(() => hasActivityCard(session!, "fake-vision", "done"), {
			timeoutMs: 10_000,
			message:
				"the finished card did not reappear after a server restart + session resume",
		});

		log("All checks passed.");
		log(`Screenshots saved under ${shotsDir}`);
	} finally {
		if (session) session.close();
		if (secondSession) secondSession.close();
		if (target) await closeTarget(target.id);
		if (secondTarget) await closeTarget(secondTarget.id);
		await killProcess(chrome, "headless Chrome");
		await killProcess(server, "pi-ui server");
		await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
	}
}

/** Mirrors `fakeDirectives.text` (`fake-stream-provider.ts`) without importing it just for
 * this one string, since only the marker constant is shared here. */
function fakeDirectivesText(note: string): string {
	return `Say hello. [[TEXT:${note}]]`;
}

main().catch((error) => {
	console.error(
		`[extension-activity.cdp] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
	);
	process.exitCode = 1;
});

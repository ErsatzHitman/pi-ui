// Disk-loadable stand-ins for JEV, Vision Proxy, Advisor, an LSP-style status tool, a
// `pi.events` fleet emitter, and standing (never-an-activity) chrome — see
// `DESIGN-ext-activity.md` §5.1. Each one reproduces the *signal shape* the real
// extension makes (a timed hook, a widget, a status, a `pi.events` channel publish,
// a `display:false` custom message, ...), not its actual behavior, so
// `src/e2e-streaming/extension-activity_test.ts` and `src/e2e-browser/extension-activity.cdp.ts`
// can drive a real `ExtensionActivity` end to end (RuntimeController's real
// instrumentation -> ledger -> AppStore -> UiRenderer -> DatastarClientHub) without ever
// touching the user's real `~/.pi/agent` extensions or a real model. Written to disk (like
// `writeFakeStreamProviderExtensionFile` in `fake-stream-provider.ts`) rather than passed as
// `InlineExtension`s, so the real SDK loader discovers and instruments them exactly the way
// it discovers a real extension — that discovery path is itself part of what this is testing.
//
// This module does NOT edit `fake-stream-provider.ts`: it only reads the prompt markers a
// test drives through `fakeDirectives.text(...)`/`fakeDirectives.tool(...)`.
import { mkdir } from "node:fs/promises";

/** Prompt markers each fake extension's hook watches for, analogous to
 * `fakeDirectives`'s own `[[...]]` markers but matched as plain substrings so they can
 * ride inside a `fakeDirectives.text(...)` note without colliding with the directive
 * parser (which only recognizes its own known directive names). */
export const fakeActivityMarkers = {
	jevHook: "fake-jev-please",
	visionHook: "fake-vision-please",
	advisorAuto: "fake-advisor-please",
} as const;

/** Tool names the fake extensions register — pass to `fakeDirectives.tool(name, args)`. */
export const fakeActivityTools = {
	jevConsult: "fake_jev_consult",
	advisorReview: "fake_advisor_review",
	lspCheck: "fake_lsp_check",
	fleetPublish: "fake_fleet_publish",
} as const;

/** JEV stand-in: a directory extension (`fake-jev/index.js`, slug `fake-jev`), matching
 * JEV's own directory layout. `fake_jev_consult` mounts a widget, updates it three times,
 * and returns text. `before_agent_start` mounts a widget for the duration of a slow hook
 * and appends a system-prompt section — JEV's own shape (`card.ts`, `index.ts`). */
const fakeJevSource = `
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi) {
	pi.registerTool({
		name: "fake_jev_consult",
		label: "Fake JEV consult",
		description: "Consults the fake JEV agent",
		parameters: { type: "object", properties: {} },
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			for (let step = 1; step <= 3; step += 1) {
				ctx.ui.setWidget("fake-jev", [\`consulting jev (\${step}/3)\`]);
				await sleep(60);
			}
			// JEV's own card lingers after the tool returns, closed later through the
			// captured ctx (card.ts's CARD_LINGER_MS) — the ledger must keep the step
			// as "done" and only refresh its output when this later close arrives.
			setTimeout(() => {
				ctx.ui.setWidget("fake-jev", undefined);
			}, 200);
			return { content: [{ type: "text", text: "jev: use 2 agents" }], details: {} };
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!String(event.prompt).includes("fake-jev-please")) return;
		ctx.ui.setWidget("fake-jev-hook", ["consulting jev"]);
		await sleep(900);
		ctx.ui.setWidget("fake-jev-hook", undefined);
		return {
			systemPrompt: \`\${event.systemPrompt}\\n## Fake JEV\\nuse 2 agents\`,
		};
	});
}
`;

/** Vision Proxy stand-in (single file, slug `fake-vision`): a slow `before_agent_start`
 * hook that shows a status while it "describes" an image and returns a `display:false`
 * message the terminal never shows (vision-proxy.ts's own shape), plus a `tool_result`
 * hook that rewrites a `read` of a `.png` path — Vision Proxy's other real trigger. The
 * "working" duration is configurable (`FAKE_VISION_WORKING_MS`, default 1200ms): long
 * enough for an in-process test's `waitForCondition` polling, but short enough to keep
 * `bun test` fast. `extension-activity.cdp.ts` sets it much higher, so a real browser has
 * time to screenshot the "working" moment across several viewport/scheme combinations
 * before it settles to "done". */
const fakeVisionSource = `
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const workingMs = Number(process.env.FAKE_VISION_WORKING_MS) > 0
	? Number(process.env.FAKE_VISION_WORKING_MS)
	: 1200;

export default function (pi) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!String(event.prompt).includes("fake-vision-please")) return;
		ctx.ui.setStatus("fake-vision", "describing 1 image");
		await sleep(workingMs);
		ctx.ui.setStatus("fake-vision", undefined);
		return {
			message: { customType: "fake-vision", content: "A red square.", display: false },
		};
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "read") return;
		const path = typeof event.input?.path === "string" ? event.input.path : "";
		if (!path.endsWith(".png")) return;
		return {
			content: [{ type: "text", text: "[fake vision] a red square, 64x64" }],
		};
	});
}
`;

/** Advisor stand-in (directory extension, slug `fake-advisor`): a manual tool
 * (`fake_advisor_review`) that streams a widget and returns a result, plus an
 * `agent_settled` auto-review path — gated by a flag its own `before_agent_start` sets,
 * since `agent_settled` carries no prompt text — that streams the same widget and then
 * posts a `display:true` custom message, matching advisor/index.ts's two entry points. */
const fakeAdvisorSource = `
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi) {
	let autoReviewPending = false;

	pi.registerTool({
		name: "fake_advisor_review",
		label: "Fake advisor review",
		description: "Reviews the fake diff",
		parameters: { type: "object", properties: {} },
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			for (let line = 1; line <= 5; line += 1) {
				ctx.ui.setWidget("fake-advisor", [\`reviewing… (\${line}/5)\`]);
				await sleep(80);
			}
			ctx.ui.setWidget("fake-advisor", undefined);
			return { content: [{ type: "text", text: "## Review\\nLGTM" }], details: {} };
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (String(event.prompt).includes("fake-advisor-please")) autoReviewPending = true;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!autoReviewPending) return;
		autoReviewPending = false;
		// Runs past the timed-hook promotion threshold (750ms) on purpose, so the
		// card is observably "working" before it finishes, instead of only ever
		// appearing retroactively as "done" (a hook faster than the threshold
		// still shows once it has raised a UI signal, per the ledger's
		// endTimedScope rule, but never passes through a visible working moment).
		for (let line = 1; line <= 9; line += 1) {
			ctx.ui.setWidget("fake-advisor-auto", [\`reviewing… (\${line}/9)\`]);
			await sleep(110);
		}
		pi.sendMessage({
			customType: "fake-advisor-review",
			content: "## Review\\nLGTM",
			display: true,
		});
		await sleep(150);
		ctx.ui.setWidget("fake-advisor-auto", undefined);
	});
}
`;

/** An LSP-style tool (single file, slug `fake-lsp`): `setStatus` in a `try`/`finally`
 * around the work, `@narumitw/pi-lsp`'s own shape, so the status clears even on error. */
const fakeLspSource = `
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi) {
	pi.registerTool({
		name: "fake_lsp_check",
		label: "Fake LSP check",
		description: "Checks the fake file for diagnostics",
		parameters: { type: "object", properties: {} },
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			ctx.ui.setStatus("fake-lsp", "pyright checking");
			try {
				await sleep(300);
				return { content: [{ type: "text", text: "0 diagnostics" }], details: {} };
			} finally {
				ctx.ui.setStatus("fake-lsp", undefined);
			}
		},
	});
}
`;

/** A `pi.events` fleet emitter (single file, slug `fake-fleet`): publishes on the
 * already-tapped \`subagents:fleet\` channel (\`live-workspace-host-extension.ts\`), the
 * same channel real sub-agent and background-bash fleets use, so the tracker's
 * channel-carrier fold (\`tracker.ts\`'s \`observeChannel\`) shows the same pink "N
 * subagent(s) running" activity a real fleet would, with no \`ctx.ui\` call at all. */
const fakeFleetSource = `
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi) {
	pi.registerTool({
		name: "fake_fleet_publish",
		label: "Fake fleet publish",
		description: "Publishes a scripted subagents:fleet burst",
		parameters: { type: "object", properties: {} },
		execute: async (_toolCallId, _params, signal) => {
			pi.events.emit("subagents:fleet", {
				entries: [
					{ key: "fake-scout", name: "fake-scout-1", state: "running", depth: 0 },
					{ key: "fake-scout-2", name: "fake-scout-2", state: "running", depth: 0 },
				],
			});
			await sleep(400);
			if (!signal?.aborted) {
				pi.events.emit("subagents:fleet", { entries: [] });
			}
			return { content: [{ type: "text", text: "published 2 fake fleet entries" }], details: {} };
		},
	});
}
`;

/** Standing chrome (single file, slug `fake-standing`): mounts at `session_start`,
 * before any run is active, so per §2.3's carrier-scope rule it must never become an
 * activity — the same reason `todo`/`plan-mode` never do, without needing to be added to
 * `policy.ts`'s deny list. It never clears, matching a real standing widget. */
const fakeStandingSource = `
export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget("fake-standing", ["always here"]);
		ctx.ui.setStatus("fake-standing-mode", "build");
	});
}
`;

const fakeActivityFiles: ReadonlyArray<readonly [string, string]> = [
	["fake-jev/index.js", fakeJevSource],
	["fake-vision.js", fakeVisionSource],
	["fake-advisor/index.js", fakeAdvisorSource],
	["fake-lsp.js", fakeLspSource],
	["fake-fleet.js", fakeFleetSource],
	["fake-standing.js", fakeStandingSource],
];

/**
 * Writes every fake activity extension into `${agentDir}/extensions/`, so the real SDK
 * loader discovers and instruments them exactly like a user's real extensions. Pass as
 * `StreamingHarnessOptions.beforeCreate` (in-process e2e) or call directly before spawning
 * a real `pi-ui` server with `PI_CODING_AGENT_DIR=<agentDir>` (CDP browser e2e).
 */
export async function writeFakeActivityExtensionFiles(agentDir: string): Promise<void> {
	const extensionsDir = `${agentDir}/extensions`;
	for (const [relativePath, source] of fakeActivityFiles) {
		const target = `${extensionsDir}/${relativePath}`;
		const slash = target.lastIndexOf("/");
		if (slash !== -1) await mkdir(target.slice(0, slash), { recursive: true });
		await Bun.write(target, source);
	}
}

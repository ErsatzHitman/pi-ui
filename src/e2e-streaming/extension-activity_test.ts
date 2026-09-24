// End-to-end: a disk-loaded extension, instrumented by the real `RuntimeController`
// wiring, drives an `ExtensionActivity` through ledger → AppStore → renderer → SSE,
// and the finished card and its `pi-ui.extension-activity` entry outlive the
// extension clearing its own status (DESIGN-ext-activity.md §5.3). The model is the
// scripted faux provider; nothing here reaches a real model.
import { test } from "bun:test";

import { assertEquals, assertExists, assertStringIncludes } from "#testing/assertions";
import { createStreamingHarness, waitForCondition } from "#testing/e2e-streaming-harness";
import { fakeDirectives } from "#testing/fake-stream-provider";
import { readUntil, responseReader } from "#testing/streams";

import { extensionActivityEntryType } from "../extension-activity-types.ts";
import type { TranscriptMessage } from "../state/transcript-state.ts";

/** Vision Proxy stand-in: a slow `before_agent_start` hook that shows a status
 * while it works and returns a `display:false` message the terminal never shows. */
const fakeVisionSource = `
export default function (pi) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!String(event.prompt).includes("fake-vision-please")) return;
		ctx.ui.setStatus("fake-vision", "describing 1 image");
		await new Promise((resolve) => setTimeout(resolve, 1200));
		ctx.ui.setStatus("fake-vision", undefined);
		return {
			message: { customType: "fake-vision", content: "A red square.", display: false },
		};
	});
}
`;

/** An extension-registered tool that reports progress through a status line. */
const fakeProbeSource = `
export default function (pi) {
	pi.registerTool({
		name: "fake_probe",
		label: "Fake probe",
		description: "Probes slowly",
		parameters: { type: "object", properties: {} },
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			ctx.ui.setStatus("fake-probe", "probing");
			await new Promise((resolve) => setTimeout(resolve, 900));
			ctx.ui.setStatus("fake-probe", undefined);
			return { content: [{ type: "text", text: "probe ok" }], details: {} };
		},
	});
}
`;

async function writeFakeActivityExtensions(agentDir: string): Promise<void> {
	await Bun.write(`${agentDir}/extensions/fake-vision.js`, fakeVisionSource);
	await Bun.write(`${agentDir}/extensions/fake-probe.js`, fakeProbeSource);
}

function activityCard(
	messages: readonly TranscriptMessage[],
	extensionId: string,
): TranscriptMessage | undefined {
	return messages.find(
		(message) =>
			message.role === "extension-activity" &&
			message.activities?.[0]?.extension.id === extensionId,
	);
}

test("a slow extension hook shows a pink working card and chip, then keeps its result after the status clears", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensions,
	});
	try {
		const tab = new AbortController();
		const reader = responseReader(harness.openStream(tab.signal));
		await readUntil(reader, (text) => text.includes("event: datastar-patch-signals"));

		// `prompt()` resolves only after `before_agent_start` handlers return, so
		// observe the working state while it is still pending.
		const prompted = harness.controller.prompt(
			fakeDirectives.text("fake-vision-please"),
		);

		// Called → Currently working: promoted card, pink chip, and the status the
		// hook set is bound to the activity instead of shown as a second chip.
		await waitForCondition(
			() =>
				activityCard(harness.store.messages, "fake-vision")?.activities?.[0]
					?.state === "working",
			{ message: "fake-vision card never reached working" },
		);
		const chip = harness.store.extensionActivityChips.find(
			(candidate) => candidate.extensionLabel === "Fake Vision",
		);
		assertExists(chip);
		assertEquals(chip.state, "working");
		const workingCard = activityCard(harness.store.messages, "fake-vision");
		assertExists(workingCard);
		assertEquals(chip.anchorMessageId, workingCard.id);
		const status = harness.store.extensionStatuses.find(
			(candidate) => candidate.key === "fake-vision",
		);
		assertEquals(status?.activityId, chip.id);
		const workingHtml = await readUntil(reader, (text) =>
			text.includes('data-activity-state="working"'),
		);
		assertStringIncludes(workingHtml, "status-dot-active");
		await readUntil(reader, (text) => text.includes("ext-activity-chip"));

		// Output/result → Completed: the status is gone, the card stays with the
		// hidden payload the terminal never shows.
		await waitForCondition(
			() =>
				activityCard(harness.store.messages, "fake-vision")?.activities?.[0]
					?.state === "done",
			{ message: "fake-vision card never finished" },
		);
		assertEquals(
			harness.store.extensionStatuses.some((entry) => entry.key === "fake-vision"),
			false,
		);
		assertEquals(harness.store.extensionActivityChips.length, 0);
		const doneCard = activityCard(harness.store.messages, "fake-vision");
		assertExists(doneCard);
		assertEquals(doneCard.id, workingCard.id);
		const output = doneCard.activities?.[0]?.output ?? [];
		const hidden = output.find((section) => section.text.includes("A red square."));
		assertExists(hidden);
		assertEquals(hidden.hidden, true);
		assertExists(doneCard.activities?.[0]?.durationText);
		const doneHtml = await readUntil(reader, (text) =>
			text.includes('data-activity-state="done"'),
		);
		assertStringIncludes(doneHtml, "hidden in terminal");
		assertEquals(await prompted, true);

		// Durable: the finished activity is in the session file for replay.
		await waitForCondition(
			() =>
				harness.store.messages.some((message) =>
					message.text.includes("Fake reply: fake-vision-please"),
				),
			{ message: "assistant reply did not arrive" },
		);
		const sessionPath = harness.store.currentSessionPath;
		assertExists(sessionPath);
		const lines = (await Bun.file(sessionPath).text())
			.split("\n")
			.filter((line) => line.includes(extensionActivityEntryType));
		assertStringIncludes(lines.join("\n"), '"phase":"start"');
		assertStringIncludes(lines.join("\n"), '"phase":"finish"');
		tab.abort();
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("an extension-owned tool card is labelled, pink while running, and keeps its activity step", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensions,
	});
	try {
		assertEquals(
			await harness.controller.prompt(fakeDirectives.tool("fake_probe", {})),
			true,
		);
		const probeTool = () =>
			harness.store.messages.find(
				(message) =>
					message.role === "tool" && message.extension?.id === "fake-probe",
			);
		await waitForCondition(() => probeTool()?.state === "running", {
			message: "fake_probe tool card never ran with its extension stamped",
		});
		await waitForCondition(
			() => probeTool()?.activities?.some((step) => step.state === "done") ?? false,
			{ message: "fake_probe activity step never finished" },
		);
		const tool = probeTool();
		assertExists(tool);
		assertEquals(tool.state, "success");
		assertEquals(activityCard(harness.store.messages, "fake-probe"), undefined);
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("an activity that finishes while its session is backgrounded is recorded in that session and shown on return", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensions,
	});
	try {
		assertEquals(
			await harness.controller.prompt(fakeDirectives.tool("fake_probe", {})),
			true,
		);
		await waitForCondition(
			() =>
				harness.store.messages.some(
					(message) =>
						message.role === "tool" &&
						message.extension?.id === "fake-probe" &&
						message.state === "running",
				),
			{ message: "fake_probe never started" },
		);
		const sessionPath = harness.store.currentSessionPath;
		assertExists(sessionPath);

		// Background the session while the extension tool is still working.
		assertEquals((await harness.controller.newSession()).status, "success");
		assertEquals(
			harness.store.messages.some(
				(message) => message.extension?.id === "fake-probe",
			),
			false,
		);

		// The finish lands in the backgrounded session's own file...
		let persisted = "";
		await waitForCondition(
			() => {
				void Bun.file(sessionPath)
					.text()
					.then(
						(text) => {
							persisted = text;
						},
						() => {},
					);
				return persisted.includes('"phase":"finish"');
			},
			{ message: "the backgrounded activity's finish entry was never persisted" },
		);

		// ...and its tool card shows the finished step once it is foreground again.
		assertEquals(
			(await harness.controller.resumeSession(sessionPath)).status,
			"success",
		);
		await waitForCondition(
			() =>
				harness.store.messages.some(
					(message) =>
						message.role === "tool" &&
						message.extension?.id === "fake-probe" &&
						(message.activities?.some((step) => step.state === "done") ??
							false),
				),
			{ message: "the finished step is missing after returning to the session" },
		);
	} finally {
		await harness.dispose();
	}
}, 30_000);

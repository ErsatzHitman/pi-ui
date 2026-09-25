// End-to-end: disk-loaded extensions, instrumented by the real `RuntimeController`
// wiring, drive `ExtensionActivity` records through ledger → AppStore → renderer → SSE,
// and a finished card (or step) outlives the extension clearing its own status or widget
// (DESIGN-ext-activity.md §5.3). Every fake extension lives in the shared
// `#testing/fake-activity-extensions` module so `src/e2e-browser/extension-activity.cdp.ts`
// drives the exact same signals against a real browser. The model is the scripted faux
// provider; nothing here reaches a real model.
import { test } from "bun:test";
import { readFileSync } from "node:fs";

import { assertEquals, assertExists, assertStringIncludes } from "#testing/assertions";
import { createStreamingHarness, waitForCondition } from "#testing/e2e-streaming-harness";
import {
	fakeActivityMarkers,
	fakeActivityTools,
	writeFakeActivityExtensionFiles,
} from "#testing/fake-activity-extensions";
import { fakeDirectives, fakeStreamProviderId } from "#testing/fake-stream-provider";
import { readUntil, responseReader } from "#testing/streams";

import { extensionActivityEntryType } from "../extension-activity-types.ts";
import type { TranscriptMessage } from "../state/transcript-state.ts";

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
		beforeCreate: writeFakeActivityExtensionFiles,
	});
	try {
		const tab = new AbortController();
		const reader = responseReader(harness.openStream(tab.signal));
		await readUntil(reader, (text) => text.includes("event: datastar-patch-signals"));

		// The faux provider is the only model this harness has to pick from — every
		// activity card in this file comes from a scripted turn, never a real one.
		assertEquals(
			harness.store.models.filter((model) => model.configured),
			harness.store.models.filter(
				(model) => model.configured && model.provider === fakeStreamProviderId,
			),
		);

		// `prompt()` resolves only after `before_agent_start` handlers return, so
		// observe the working state while it is still pending.
		const prompted = harness.controller.prompt(
			fakeDirectives.text(fakeActivityMarkers.visionHook),
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
					message.text.includes(
						`Fake reply: ${fakeActivityMarkers.visionHook}`,
					),
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

		// Standing chrome mounted at session_start (`fake-standing`) is never an
		// activity, however long it stays open.
		assertEquals(activityCard(harness.store.messages, "fake-standing"), undefined);
		assertEquals(
			harness.store.extensionActivityChips.some(
				(candidate) => candidate.extensionLabel === "Fake Standing",
			),
			false,
		);
		tab.abort();
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("an extension-owned tool card is labelled, pink while running, and keeps its activity step", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensionFiles,
	});
	try {
		assertEquals(
			await harness.controller.prompt(
				fakeDirectives.tool(fakeActivityTools.lspCheck, {}),
			),
			true,
		);
		const lspTool = () =>
			harness.store.messages.find(
				(message) =>
					message.role === "tool" && message.extension?.id === "fake-lsp",
			);
		await waitForCondition(() => lspTool()?.state === "running", {
			message: "fake_lsp_check tool card never ran with its extension stamped",
		});
		await waitForCondition(
			() => lspTool()?.activities?.some((step) => step.state === "done") ?? false,
			{ message: "fake_lsp_check activity step never finished" },
		);
		const tool = lspTool();
		assertExists(tool);
		assertEquals(tool.state, "success");
		assertEquals(activityCard(harness.store.messages, "fake-lsp"), undefined);
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("a JEV-style tool step keeps its panel output after the widget closes on a delay", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensionFiles,
	});
	try {
		assertEquals(
			await harness.controller.prompt(
				fakeDirectives.tool(fakeActivityTools.jevConsult, {}),
			),
			true,
		);
		const jevTool = () =>
			harness.store.messages.find(
				(message) =>
					message.role === "tool" && message.extension?.id === "fake-jev",
			);
		await waitForCondition(
			() => jevTool()?.activities?.some((step) => step.state === "done") ?? false,
			{ message: "fake_jev_consult activity step never finished" },
		);
		const doneTool = jevTool();
		assertExists(doneTool);
		assertEquals(doneTool.state, "success");

		// The card is a `(tui, theme) => Component` factory (JEV's real shape): its
		// rendered frames drove the step's live progress…
		assertStringIncludes(doneTool.activities?.[0]?.progress ?? "", "consulting jev");
		// …and it closes 200ms after the tool returns (JEV's lingering card) — the
		// step must still be "done", and its output must pick up the final rendered
		// frame instead of losing it.
		await waitForCondition(
			() => {
				const step = jevTool()?.activities?.[0];
				return (
					step?.state === "done" &&
					(step.output ?? []).some(
						(section) =>
							section.kind === "panel" &&
							section.text.includes("recommendation: use 2 agents"),
					)
				);
			},
			{ message: "fake_jev_consult step never picked up the final panel frame" },
		);
		// That late panel is persisted too (a re-written "finish" entry), so it
		// survives a reload or resume, not just the live transcript.
		const sessionPath = harness.store.currentSessionPath;
		assertExists(sessionPath);
		await waitForCondition(
			() =>
				readFileSync(sessionPath, "utf8")
					.split("\n")
					.some(
						(line) =>
							line.includes(extensionActivityEntryType) &&
							line.includes('"phase":"finish"') &&
							line.includes("recommendation: use 2 agents"),
					),
			{ message: "the late panel frame was never persisted" },
		);
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("an Advisor-style auto-review shows a standalone card and the display:true row it posts", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensionFiles,
	});
	try {
		const prompted = harness.controller.prompt(
			fakeDirectives.text(fakeActivityMarkers.advisorAuto),
		);
		await waitForCondition(
			() =>
				activityCard(harness.store.messages, "fake-advisor")?.activities?.[0]
					?.state === "working",
			{ message: "fake-advisor auto-review card never reached working" },
		);
		await waitForCondition(
			() =>
				activityCard(harness.store.messages, "fake-advisor")?.activities?.[0]
					?.state === "done",
			{ message: "fake-advisor auto-review card never finished" },
		);
		const card = activityCard(harness.store.messages, "fake-advisor");
		assertExists(card);
		const progress = card.activities?.[0]?.progress ?? card.activities?.[0]?.summary;
		assertStringIncludes(progress ?? "", "reviewing");
		// The live panel is a component factory (Advisor's real shape): its last
		// rendered frame is kept as the card's output after the widget closes.
		await waitForCondition(
			() =>
				(
					activityCard(harness.store.messages, "fake-advisor")?.activities?.[0]
						?.output ?? []
				).some(
					(section) =>
						section.kind === "panel" &&
						section.text.includes("reviewing… (9/9)"),
				),
			{ message: "the advisor panel's final frame was never kept" },
		);

		// `display:true` custom messages still render as their own row, unchanged.
		await waitForCondition(
			() =>
				harness.store.messages.some(
					(message) =>
						message.role === "custom" && message.text.includes("LGTM"),
				),
			{ message: "the fake-advisor-review row never arrived" },
		);
		assertEquals(await prompted, true);
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("a pi.events fleet publish shows the same pink channel activity a real fleet would", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensionFiles,
	});
	try {
		const prompted = harness.controller.prompt(
			fakeDirectives.tool(fakeActivityTools.fleetPublish, {}),
		);
		await waitForCondition(
			() =>
				activityCard(harness.store.messages, "subagents")?.activities?.[0]
					?.state === "working",
			{ message: "the fleet channel activity never reached working" },
		);
		assertEquals(await prompted, true);
		await waitForCondition(
			() =>
				activityCard(harness.store.messages, "subagents")?.activities?.[0]
					?.state === "done",
			{ message: "the fleet channel activity never finished" },
		);
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("an activity that finishes while its session is backgrounded is recorded in that session and shown on return", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensionFiles,
	});
	try {
		assertEquals(
			await harness.controller.prompt(
				fakeDirectives.tool(fakeActivityTools.lspCheck, {}),
			),
			true,
		);
		await waitForCondition(
			() =>
				harness.store.messages.some(
					(message) =>
						message.role === "tool" &&
						message.extension?.id === "fake-lsp" &&
						message.state === "running",
				),
			{ message: "fake_lsp_check never started" },
		);
		const sessionPath = harness.store.currentSessionPath;
		assertExists(sessionPath);

		// Background the session while the extension tool is still working.
		assertEquals((await harness.controller.newSession()).status, "success");
		assertEquals(
			harness.store.messages.some(
				(message) => message.extension?.id === "fake-lsp",
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
						message.extension?.id === "fake-lsp" &&
						(message.activities?.some((step) => step.state === "done") ??
							false),
				),
			{ message: "the finished step is missing after returning to the session" },
		);
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("extensions.activityPersist=false keeps the live card but writes no activity entry", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensionFiles,
		controllerOptions: { extensionsActivityPersist: false },
	});
	try {
		assertEquals(
			await harness.controller.prompt(
				fakeDirectives.text(fakeActivityMarkers.visionHook),
			),
			true,
		);
		await waitForCondition(
			() =>
				activityCard(harness.store.messages, "fake-vision")?.activities?.[0]
					?.state === "done",
			{ message: "fake-vision card never finished" },
		);
		await waitForCondition(
			() =>
				harness.store.messages.some((message) =>
					message.text.includes(
						`Fake reply: ${fakeActivityMarkers.visionHook}`,
					),
				),
			{ message: "assistant reply did not arrive" },
		);
		const sessionPath = harness.store.currentSessionPath;
		assertExists(sessionPath);
		assertEquals(
			readFileSync(sessionPath, "utf8").includes(extensionActivityEntryType),
			false,
		);
	} finally {
		await harness.dispose();
	}
}, 30_000);

test("extensions.activityTracking=false leaves every extension exactly as loaded: no cards, no chips", async () => {
	const harness = await createStreamingHarness({
		beforeCreate: writeFakeActivityExtensionFiles,
		controllerOptions: { extensionsActivityTracking: false },
	});
	try {
		assertEquals(
			await harness.controller.prompt(
				fakeDirectives.text(fakeActivityMarkers.visionHook),
			),
			true,
		);
		await waitForCondition(
			() =>
				harness.store.messages.some((message) =>
					message.text.includes(
						`Fake reply: ${fakeActivityMarkers.visionHook}`,
					),
				),
			{ message: "assistant reply did not arrive" },
		);
		assertEquals(
			harness.store.messages.some(
				(message) => message.role === "extension-activity" || message.extension,
			),
			false,
		);
		assertEquals(harness.store.extensionActivityChips, []);
	} finally {
		await harness.dispose();
	}
}, 30_000);

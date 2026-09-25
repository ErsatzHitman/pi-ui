import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";
import { createStreamingHarness, waitForCondition } from "#testing/e2e-streaming-harness";
import { fakeDirectives } from "#testing/fake-stream-provider";

// ask-user-native round: ask_user (an extension-registered tool the fixture doesn't
// know about) needs a scripted turn that can call it. The fixture had no generic
// tool-call directive — only named ones (bash/read/bigOutput/fleet) — so this adds
// `[[TOOL:<name>:<json args>]]` and proves it drives an arbitrary tool call through
// the real pi SDK session machinery, the same way the named directives do.
test("the generic [[TOOL:name:json]] directive drives an arbitrary tool call end to end, including a `]` inside a JSON string argument", async () => {
	const harness = await createStreamingHarness();
	try {
		// Routed through the real `bash` tool (already exercised by fakeDirectives.bash)
		// so this needs no extra fixture tool registration, while still proving the
		// directive parses an arbitrary tool name + JSON args — including a `]`
		// inside a string value, which a naive "stop at the first `]`" parse would
		// truncate before the JSON closes.
		assertEquals(
			await harness.controller.prompt(
				fakeDirectives.tool("bash", { command: "echo [ok]" }),
			),
			true,
		);

		await waitForCondition(
			() => harness.store.messages.some((message) => message.text.includes("[ok]")),
			{
				message:
					"the generic TOOL directive's bash call output never reached the transcript",
			},
		);
		await waitForCondition(
			() =>
				harness.store.messages.some((message) =>
					message.text.includes("bash finished (ok)"),
				),
			{
				message:
					"wrap-up reply after the generic TOOL directive's result never arrived",
			},
		);
	} finally {
		await harness.dispose();
	}
}, 15_000);

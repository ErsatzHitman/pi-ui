import { test } from "bun:test";

import { assertEquals, assertFalse } from "#testing/assertions";

import type {
	ExtensionActivityOutput,
	ExtensionRef,
} from "../extension-activity-types.ts";
import {
	capOutputSections,
	capOutputText,
	capProgressLine,
	extensionActivityCaps,
	isStandingSignal,
	isTimedHookEvent,
} from "./policy.ts";

function ref(id: string, source = "local"): ExtensionRef {
	return { id, label: id, path: `/x/${id}`, source };
}

test("isTimedHookEvent matches exactly the §2.3 timed-hook list", () => {
	for (const event of [
		"before_agent_start",
		"context",
		"context_with_system",
		"tool_call",
		"tool_result",
		"input",
		"user_bash",
		"turn_start",
		"turn_end",
		"agent_end",
		"agent_settled",
		"message_end",
		"session_compact",
		"before_provider_request",
	]) {
		assertEquals(isTimedHookEvent(event), true, event);
	}
	for (const event of [
		"session_start",
		"session_shutdown",
		"resources_discover",
		"project_trust",
		"message_start",
		"message_update",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
	]) {
		assertFalse(isTimedHookEvent(event), event);
	}
});

test("isStandingSignal matches the deny-listed extensions and keys", () => {
	assertEquals(isStandingSignal(ref("todo"), "anything"), true);
	assertEquals(isStandingSignal(ref("minimal-status"), "footer"), true);
	assertEquals(isStandingSignal(ref("pi-fff"), "session-status"), true);
	assertEquals(isStandingSignal(ref("btw"), "sheet"), true);

	assertEquals(isStandingSignal(ref("plan-mode"), "!mode"), true);
	assertFalse(isStandingSignal(ref("plan-mode"), "other-key"));

	assertEquals(
		isStandingSignal(ref("core", "npm:@pi-archimedes/core"), "header"),
		true,
	);
	assertEquals(
		isStandingSignal(ref("footer", "npm:@pi-archimedes/footer"), "footer"),
		true,
	);

	assertFalse(isStandingSignal(ref("jev"), "jev-decompose"));
	assertFalse(isStandingSignal(ref("vision-proxy"), "anything"));
});

test("capProgressLine collapses newlines and caps length with an ellipsis", () => {
	assertEquals(capProgressLine("consulting jev"), "consulting jev");
	assertEquals(capProgressLine("line one\n  line two"), "line one line two");
	const long = "x".repeat(250);
	const capped = capProgressLine(long);
	assertEquals(capped.length, extensionActivityCaps.progressCapChars);
	assertEquals(capped.endsWith("…"), true);
});

test("capOutputText caps to outputSectionCapBytes without splitting a surrogate pair", () => {
	const short = capOutputText("hello");
	assertEquals(short, { text: "hello", truncated: false });

	// Two-byte-per-char text well past the cap, ending mid multi-byte run.
	const long = "é".repeat(20000); // 2 bytes per char in UTF-8
	const { text, truncated } = capOutputText(long);
	assertEquals(truncated, true);
	const encoder = new TextEncoder();
	assertEquals(
		encoder.encode(text).byteLength <= extensionActivityCaps.outputSectionCapBytes,
		true,
	);
	// Every char decoded is a real "é", never a half-decoded replacement run.
	assertEquals(
		[...text].every((ch) => ch === "é"),
		true,
	);
});

test("capOutputSections keeps sections under the total budget, cuts the one that crosses it, drops the rest", () => {
	const sectionBytes = 12 * 1024;
	const sections: ExtensionActivityOutput[] = [
		{ kind: "status", title: "a", text: "a".repeat(sectionBytes) },
		{ kind: "status", title: "b", text: "b".repeat(sectionBytes) },
		{ kind: "status", title: "c", text: "c".repeat(sectionBytes) },
		{ kind: "status", title: "d", text: "d".repeat(sectionBytes) },
	];
	const kept = capOutputSections(sections);
	// 32 KiB total budget, 12 KiB sections: a and b fit whole (24 KiB used),
	// c is cut to the remaining 8 KiB, d is dropped entirely.
	assertEquals(kept.length, 3);
	assertEquals(kept[0], sections[0]);
	assertEquals(kept[1], sections[1]);
	assertEquals(kept[2]!.title, "c");
	assertEquals(kept[2]!.truncated, true);
	assertEquals(kept[2]!.text.length < sectionBytes, true);
});

test("capOutputSections passes everything through when well under budget", () => {
	const sections: ExtensionActivityOutput[] = [
		{ kind: "notice", title: "n", text: "small" },
	];
	assertEquals(capOutputSections(sections), sections);
});

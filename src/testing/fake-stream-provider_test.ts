import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { currentTurnPrompt, currentTurnToolResult } from "./fake-stream-provider.ts";

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const assistant = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 0,
});

// A real extension set (memory injection, time-sense, ...) appends its own user-role
// context messages AFTER the user's prompt through the `context` event, so the model's
// last user message is often not the prompt that carries the scripted directive.
test("the scripted turn reads its directive from the current turn's prompt, not an injected context message after it", () => {
	const prompt = 'Call a tool. [[TOOL:ask_user:{"question":"Q?"}]]';
	assertEquals(
		currentTurnPrompt({
			messages: [user(prompt), user("<memory>Injected By An Extension</memory>")],
		} as never),
		prompt,
	);
});

test("a directive from an earlier, already-answered turn is never replayed", () => {
	assertEquals(
		currentTurnPrompt({
			messages: [
				user("Say hello. [[TEXT:old]]"),
				assistant("Fake reply: old"),
				user("plain"),
			],
		} as never),
		"plain",
	);
});

test("a tool result followed by an injected context message still gets the wrap-up reply", () => {
	const toolResult = {
		role: "toolResult" as const,
		toolCallId: "t1",
		toolName: "ask_user",
		content: [{ type: "text" as const, text: "User answered: Health" }],
		isError: false,
		timestamp: 0,
	};
	assertEquals(
		currentTurnToolResult({
			messages: [
				user("[[TOOL:ask_user:{}]]"),
				assistant("calling"),
				toolResult,
				user("Current Time: 01:00"),
			],
		} as never)?.toolName,
		"ask_user",
	);
	assertEquals(
		currentTurnToolResult({
			messages: [toolResult, assistant("done"), user("next")],
		} as never),
		undefined,
	);
});

test("a steering prompt queued after a tool result is answered rather than the result", () => {
	const toolResult = {
		role: "toolResult" as const,
		toolCallId: "t1",
		toolName: "bash",
		content: [{ type: "text" as const, text: "ok" }],
		isError: false,
		timestamp: 0,
	};
	assertEquals(
		currentTurnToolResult({
			messages: [
				assistant("calling"),
				toolResult,
				user("Say hello. [[TEXT:steer]]"),
			],
		} as never),
		undefined,
	);
});

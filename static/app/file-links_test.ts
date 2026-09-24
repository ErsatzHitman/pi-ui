import { afterEach, mock, test } from "bun:test";

import { assertEquals } from "#testing/assertions";

const workspaceReviewSpecifier = "../../src/client/workspace-review.ts";

/** Patches a global via `Object.defineProperty` (see live-workspace-layout_test.ts). */
function patchGlobal(name: string, value: unknown): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
	return () => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	};
}

const restores: (() => void)[] = [];
afterEach(() => {
	while (restores.length > 0) restores.pop()?.();
});

function fakeEndpoint(endpoint: string): void {
	restores.push(
		patchGlobal("document", { body: { dataset: { filesOpenEndpoint: endpoint } } }),
	);
}

function fakeFetch(body: unknown, status = 200): void {
	restores.push(
		patchGlobal("fetch", async () => new Response(JSON.stringify(body), { status })),
	);
}

function trackedAlert(): string[] {
	const messages: string[] = [];
	restores.push(
		patchGlobal("alert", (message: string) => {
			messages.push(message);
		}),
	);
	return messages;
}

test("a directory result reveals it in the Files view and never falls back to a raw alert()", async () => {
	fakeEndpoint("/files/open");
	fakeFetch({ directory: true, path: "notes", workspacePath: "/ws" });
	const alerted = trackedAlert();
	const calls: Array<[string, string]> = [];
	mock.module(workspaceReviewSpecifier, () => ({
		openLinkedWorkspaceDirectory: async (path: string, workspacePath: string) => {
			calls.push([path, workspacePath]);
		},
		openLinkedWorkspaceFile: async () => {
			throw new Error("Expected the directory branch, not the file branch");
		},
	}));

	const { followFileLink } = await import("./file-links.js");
	await followFileLink("file:///ws/notes");

	assertEquals(calls, [["notes", "/ws"]]);
	assertEquals(alerted, []);
});

test("a file result opens it in the editor", async () => {
	fakeEndpoint("/files/open");
	fakeFetch({ path: "notes.md", workspacePath: "/ws" });
	const alerted = trackedAlert();
	const calls: Array<[string, string]> = [];
	mock.module(workspaceReviewSpecifier, () => ({
		openLinkedWorkspaceDirectory: async () => {
			throw new Error("Expected the file branch, not the directory branch");
		},
		openLinkedWorkspaceFile: async (path: string, workspacePath: string) => {
			calls.push([path, workspacePath]);
		},
	}));

	const { followFileLink } = await import("./file-links.js");
	await followFileLink("file:///ws/notes.md");

	assertEquals(calls, [["notes.md", "/ws"]]);
	assertEquals(alerted, []);
});

test("an already-opened result does nothing further", async () => {
	fakeEndpoint("/files/open");
	fakeFetch({ opened: true });
	const alerted = trackedAlert();
	mock.module(workspaceReviewSpecifier, () => ({
		openLinkedWorkspaceDirectory: async () => {
			throw new Error("Should not be called");
		},
		openLinkedWorkspaceFile: async () => {
			throw new Error("Should not be called");
		},
	}));

	const { followFileLink } = await import("./file-links.js");
	await followFileLink("file:///ws/notes.md");

	assertEquals(alerted, []);
});

test("a failed request still falls back to alert() (unchanged pre-existing behavior)", async () => {
	fakeEndpoint("/files/open");
	fakeFetch({ error: "no such file" }, 404);
	const alerted = trackedAlert();

	const { followFileLink } = await import("./file-links.js");
	await followFileLink("file:///ws/missing.md");

	assertEquals(alerted, ["no such file"]);
});

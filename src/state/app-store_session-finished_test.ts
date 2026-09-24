import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { AppStore, type AppStorePresentation } from "./app-store.ts";

function fakePresentation(effects: unknown[]): AppStorePresentation {
	return new Proxy(
		{},
		{
			get: (_target, name) =>
				name === "requestCommit"
					? (effect: unknown) => {
							if (effect) effects.push(effect);
						}
					: () => {},
		},
	) as AppStorePresentation;
}

test("notifySessionFinished commits a session-finished effect with a monotonically increasing id", () => {
	const store = new AppStore();
	const effects: unknown[] = [];
	store.attachPresentation(fakePresentation(effects));

	store.notifySessionFinished({
		workspace: "/workspace",
		sessionPath: "/sessions/a.jsonl",
	});
	store.notifySessionFinished({ workspace: "/workspace-2" });

	assertEquals(effects, [
		{
			type: "session-finished",
			workspace: "/workspace",
			sessionPath: "/sessions/a.jsonl",
			id: 1,
		},
		{
			type: "session-finished",
			workspace: "/workspace-2",
			sessionPath: undefined,
			id: 2,
		},
	]);
});

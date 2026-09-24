import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	createTurnPhaseWatcher,
	turnNotificationWanted,
} from "./live-workspace-turn-phase.ts";

type Notified = { title: string; body: string };

function harness(initialPhase: string | undefined, initialSession: string | undefined) {
	let phase = initialPhase;
	let sessionPath = initialSession;
	const notified: Notified[] = [];
	const watcher = createTurnPhaseWatcher({
		readPhase: () => phase,
		readSessionPath: () => sessionPath,
		notify: (title, body) => notified.push({ title, body }),
	});
	return {
		notified,
		setPhase: (value: string | undefined) => {
			phase = value;
			watcher.check();
		},
		setPhaseAndSession: (value: string | undefined, session: string | undefined) => {
			phase = value;
			sessionPath = session;
			watcher.check();
		},
	};
}

test("notifies 'Turn finished' when a running turn's phase clears on the same session", () => {
	const h = harness("running", "/sessions/a.jsonl");
	h.setPhase(undefined);
	assertEquals(h.notified, [
		{ title: "Turn finished", body: "pi has finished the current turn." },
	]);
});

test("notifies 'Turn finished' from the retrying phase too", () => {
	const h = harness("retrying", "/sessions/a.jsonl");
	h.setPhase(undefined);
	assertEquals(h.notified, [
		{ title: "Turn finished", body: "pi has finished the current turn." },
	]);
});

test("does not notify when the phase clears because the foreground session switched (A#R2/RM1 issue 3)", () => {
	const h = harness("running", "/sessions/a.jsonl");
	// `/new` or switching sessions clears the banner AND changes the session in the same patch.
	h.setPhaseAndSession(undefined, "/sessions/b.jsonl");
	assertEquals(h.notified, []);
});

test("does not notify when the phase clears because the foreground session switched to none", () => {
	const h = harness("running", "/sessions/a.jsonl");
	h.setPhaseAndSession(undefined, undefined);
	assertEquals(h.notified, []);
});

test("still notifies a real finish that happens to land right after a session switch", () => {
	const h = harness("running", "/sessions/a.jsonl");
	// Switch away mid-run: no notification for the old session's banner clearing...
	h.setPhaseAndSession(undefined, "/sessions/b.jsonl");
	// ...then the new foreground session starts and finishes its own turn.
	h.setPhase("running");
	h.setPhase(undefined);
	assertEquals(h.notified, [
		{ title: "Turn finished", body: "pi has finished the current turn." },
	]);
});

test("notifies 'waiting for input' when a turn starts waiting on extension input", () => {
	const h = harness("running", "/sessions/a.jsonl");
	h.setPhase("waiting-for-extension");
	assertEquals(h.notified, [
		{ title: "pi is waiting for input", body: "Open pi-ui to respond." },
	]);
});

test("does not notify when the phase is unchanged", () => {
	const h = harness("running", "/sessions/a.jsonl");
	h.setPhase("running");
	assertEquals(h.notified, []);
});

test("does not notify on the initial idle-to-nothing transition", () => {
	const h = harness(undefined, undefined);
	h.setPhase(undefined);
	assertEquals(h.notified, []);
});

test("turnNotificationWanted: only for a hidden, opted-in, granted page; 'Turn finished' is left to Web Push when this browser is subscribed", () => {
	const base = {
		hidden: true,
		optedIn: true,
		permission: "granted",
		pushCovers: false,
	};
	assertEquals(turnNotificationWanted("Turn finished", base), true);
	assertEquals(
		turnNotificationWanted("Turn finished", { ...base, hidden: false }),
		false,
	);
	assertEquals(
		turnNotificationWanted("Turn finished", { ...base, optedIn: false }),
		false,
	);
	assertEquals(
		turnNotificationWanted("Turn finished", { ...base, permission: "default" }),
		false,
	);
	assertEquals(
		turnNotificationWanted("Turn finished", { ...base, pushCovers: true }),
		false,
	);
	// "waiting for input" is never pushed, so it stays in-page.
	assertEquals(
		turnNotificationWanted("pi is waiting for input", { ...base, pushCovers: true }),
		true,
	);
});

import { afterEach, test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { isRemoteMode, resolveRemoteMode, setRemoteMode } from "./remote-mode.ts";

afterEach(() => setRemoteMode(false));

test("remote mode is off for a loopback host without --remote", () => {
	assertEquals(resolveRemoteMode({ hostname: "127.0.0.1" }), false);
	assertEquals(resolveRemoteMode({ hostname: "localhost" }), false);
});

test("remote mode follows --remote or a non-loopback host", () => {
	assertEquals(resolveRemoteMode({ hostname: "127.0.0.1", remote: true }), true);
	assertEquals(resolveRemoteMode({ hostname: "0.0.0.0" }), true);
	assertEquals(resolveRemoteMode({ hostname: "100.64.0.7" }), true);
});

test("remote mode is process-wide state", () => {
	assertEquals(isRemoteMode(), false);
	setRemoteMode(true);
	assertEquals(isRemoteMode(), true);
});

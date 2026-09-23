import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { AppStore } from "./app-store.ts";

test("client color scheme tracks the most recent still-connected client (O4)", () => {
	const store = new AppStore();
	assertEquals(store.clientColorScheme, "dark");

	store.setClientColorScheme("light", "client-a");
	assertEquals(store.clientColorScheme, "light");
	store.setClientColorScheme("dark", "client-b");
	assertEquals(store.clientColorScheme, "dark");

	// A closed tab stops overriding the tabs that are still open.
	store.clearClientColorScheme("client-b");
	assertEquals(store.clientColorScheme, "light");

	// Clearing a client that isn't the current one leaves the current value alone.
	store.setClientColorScheme("dark", "client-c");
	store.clearClientColorScheme("client-a");
	assertEquals(store.clientColorScheme, "dark");

	store.clearClientColorScheme("client-c");
	assertEquals(store.clientColorScheme, "dark");
});

test("client color scheme reports without a client id use the legacy shared slot", () => {
	const store = new AppStore();
	store.setClientColorScheme("light");
	assertEquals(store.clientColorScheme, "light");
	store.clearClientColorScheme(AppStore.legacyClientColorSchemeKey);
	assertEquals(store.clientColorScheme, "dark");
});

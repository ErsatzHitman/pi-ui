import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import {
	resolveExtensionLabel,
	resolveExtensionRef,
	resolveExtensionSlug,
} from "./identity.ts";

test("a directory extension's slug is its directory name", () => {
	assertEquals(
		resolveExtensionSlug({
			resolvedPath: "/home/user/.pi/agent/extensions/jev/index.ts",
			source: "local",
		}),
		"jev",
	);
	assertEquals(
		resolveExtensionSlug({
			resolvedPath: "C:\\Users\\me\\.pi\\agent\\extensions\\jev\\index.ts",
			source: "local",
		}),
		"jev",
	);
});

test("a single-file extension's slug is its own basename", () => {
	assertEquals(
		resolveExtensionSlug({
			resolvedPath: "/home/user/.pi/agent/extensions/vision-proxy.ts",
			source: "local",
		}),
		"vision-proxy",
	);
});

test("a package source strips the npm scope, and any version suffix", () => {
	assertEquals(
		resolveExtensionSlug({
			resolvedPath: "/home/user/.pi/agent/extensions/pi-lsp/index.ts",
			source: "npm:@narumitw/pi-lsp",
		}),
		"pi-lsp",
	);
	assertEquals(
		resolveExtensionSlug({
			resolvedPath: "/x/pi-lsp/index.ts",
			source: "npm:@narumitw/pi-lsp@^1.2.3",
		}),
		"pi-lsp",
	);
	assertEquals(
		resolveExtensionSlug({
			resolvedPath: "/x/rtk/index.ts",
			source: "npm:rtk@1.0.0",
		}),
		"rtk",
	);
});

test("resolveExtensionLabel uses the override map, else title-cases the slug", () => {
	assertEquals(resolveExtensionLabel("jev"), "JEV");
	assertEquals(resolveExtensionLabel("vision-proxy"), "Vision Proxy");
	assertEquals(resolveExtensionLabel("advisor"), "Advisor");
	assertEquals(resolveExtensionLabel("pi-lsp"), "LSP");
	assertEquals(resolveExtensionLabel("pi-goal"), "Goal");
	assertEquals(resolveExtensionLabel("pi-herdr-delegate"), "Delegate");
	assertEquals(resolveExtensionLabel("bash-background"), "Bash Background");
	assertEquals(resolveExtensionLabel("handoff"), "Handoff");
});

test("resolveExtensionRef assembles the full ExtensionRef", () => {
	assertEquals(
		resolveExtensionRef({
			resolvedPath: "/home/user/.pi/agent/extensions/jev/index.ts",
			source: "local",
		}),
		{
			id: "jev",
			label: "JEV",
			path: "/home/user/.pi/agent/extensions/jev/index.ts",
			source: "local",
		},
	);
});

test("an entry-point basename with no parent directory falls back to itself", () => {
	assertEquals(
		resolveExtensionSlug({ resolvedPath: "index.ts", source: "local" }),
		"index",
	);
});

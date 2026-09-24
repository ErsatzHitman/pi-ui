import { afterEach, mock, test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { setRemoteMode } from "../remote-mode.ts";
import { AppStore } from "../state/app-store.ts";
import { AuthController } from "./auth-controller.ts";
import { agentSessionRuntimeStub } from "./test-fixtures.ts";

const openBrowserSpecifier =
	"../../node_modules/@earendil-works/pi-coding-agent/dist/utils/open-browser.js";

afterEach(() => setRemoteMode(false));

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function oauthProvider() {
	return {
		id: "cloud-oauth",
		name: "Cloud OAuth",
		auth: {
			oauth: {
				name: "Cloud OAuth",
				login: async (interaction: {
					notify(event: { type: "auth_url"; url: string }): void;
				}) => {
					interaction.notify({
						type: "auth_url",
						url: "https://example.com/authorize",
					});
					// The oauth flow never resolves in these tests; only the
					// auth_url notification matters.
					return new Promise<never>(() => {});
				},
			},
		},
	};
}

test("provider-owned API key login can request multiple fields and accept empty values", async () => {
	const submitted: string[] = [];
	const provider = {
		id: "custom-cloud",
		name: "Custom Cloud",
		auth: {
			apiKey: {
				name: "Custom Cloud credentials",
				login: async (interaction: {
					prompt(prompt: {
						type: "secret" | "text";
						message: string;
					}): Promise<string>;
				}) => {
					submitted.push(
						await interaction.prompt({
							type: "secret",
							message: "Enter API key",
						}),
					);
					submitted.push(
						await interaction.prompt({
							type: "text",
							message: "Enter account ID",
						}),
					);
					return { type: "api_key" as const, key: submitted[0] };
				},
			},
		},
	};
	const modelRuntime = {
		getProviders: () => [provider],
		getProvider: () => provider,
		login: async (
			_providerId: string,
			_type: string,
			interaction: Parameters<NonNullable<typeof provider.auth.apiKey.login>>[0],
		) => await provider.auth.apiKey.login(interaction),
	};
	const runtime = agentSessionRuntimeStub({
		services: { modelRuntime },
	});
	const state = new AppStore();
	let changed = 0;
	const controller = new AuthController(
		() => runtime,
		state,
		() => changed++,
	);

	controller.openLogin();
	assertEquals(state.authDialog?.providers, [
		{
			id: "custom-cloud",
			name: "Custom Cloud",
			authType: "api_key",
		},
	]);
	assertEquals(controller.startLogin("custom-cloud", "api_key"), true);
	assertEquals(state.authDialog?.prompt, {
		message: "Enter API key",
		placeholder: undefined,
		secret: true,
		options: undefined,
	});

	assertEquals(controller.submitInput("secret"), true);
	await nextTurn();
	assertEquals(state.authDialog?.prompt?.message, "Enter account ID");
	assertEquals(state.authDialog?.prompt?.secret, false);

	assertEquals(controller.submitInput(""), true);
	await nextTurn();
	assertEquals(submitted, ["secret", ""]);
	assertEquals(changed, 1);
	assertEquals(state.authDialog?.phase, "result");
});

test("oauth login opens the auth URL on the host when not in remote mode", async () => {
	const opened: string[] = [];
	mock.module(openBrowserSpecifier, () => ({
		openBrowser: (target: string) => {
			opened.push(target);
		},
	}));
	const provider = oauthProvider();
	const modelRuntime = {
		getProviders: () => [provider],
		getProvider: () => provider,
		login: async (
			_providerId: string,
			_type: string,
			interaction: Parameters<NonNullable<typeof provider.auth.oauth.login>>[0],
		) => await provider.auth.oauth.login(interaction),
	};
	const runtime = agentSessionRuntimeStub({ services: { modelRuntime } });
	const state = new AppStore();
	const controller = new AuthController(
		() => runtime,
		state,
		() => {},
	);

	controller.openLogin();
	assertEquals(controller.startLogin("cloud-oauth", "oauth"), true);
	await nextTurn();

	assertEquals(state.authDialog?.url, "https://example.com/authorize");
	assertEquals(opened, ["https://example.com/authorize"]);
});

test("oauth login shows the auth URL but does not open it on the host in remote mode", async () => {
	const opened: string[] = [];
	mock.module(openBrowserSpecifier, () => ({
		openBrowser: (target: string) => {
			opened.push(target);
		},
	}));
	setRemoteMode(true);
	const provider = oauthProvider();
	const modelRuntime = {
		getProviders: () => [provider],
		getProvider: () => provider,
		login: async (
			_providerId: string,
			_type: string,
			interaction: Parameters<NonNullable<typeof provider.auth.oauth.login>>[0],
		) => await provider.auth.oauth.login(interaction),
	};
	const runtime = agentSessionRuntimeStub({ services: { modelRuntime } });
	const state = new AppStore();
	const controller = new AuthController(
		() => runtime,
		state,
		() => {},
	);

	controller.openLogin();
	assertEquals(controller.startLogin("cloud-oauth", "oauth"), true);
	await nextTurn();

	// A remote client can only act on the URL shown in the dialog: it must
	// still be there even though nothing was opened on the server's host.
	assertEquals(state.authDialog?.url, "https://example.com/authorize");
	assertEquals(opened, []);
});

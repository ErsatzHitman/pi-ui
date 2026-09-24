import { test } from "bun:test";

import { assertEquals, assertExists } from "#testing/assertions";

import {
	AppStore,
	type AppStorePresentation,
	type UiCommitEffect,
} from "../state/app-store.ts";
import { AuthController } from "./auth-controller.ts";
import { agentSessionRuntimeStub } from "./test-fixtures.ts";

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Records every `requestCommit` effect for assertions, same double as
 * `extension-ui-controller_test.ts`'s. */
function presentationRecordingEffects(effects: UiCommitEffect[]): AppStorePresentation {
	return new Proxy(
		{},
		{
			get: (_target, name) =>
				name === "requestCommit"
					? (effect: UiCommitEffect | undefined) => {
							if (effect) effects.push(effect);
						}
					: () => {},
		},
	) as AppStorePresentation;
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

test("submitting an auth prompt answer notifies other clients (RM1 multi-client #1)", async () => {
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
				}) =>
					await interaction
						.prompt({ type: "secret", message: "Enter API key" })
						.then((key) => ({ type: "api_key" as const, key })),
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
	const runtime = agentSessionRuntimeStub({ services: { modelRuntime } });
	const state = new AppStore();
	const effects: UiCommitEffect[] = [];
	state.attachPresentation(presentationRecordingEffects(effects));
	const controller = new AuthController(
		() => runtime,
		state,
		() => {},
	);

	controller.openLogin();
	controller.startLogin("custom-cloud", "api_key");

	assertEquals(controller.submitInput("secret", "client-a"), true);
	await nextTurn();

	const toast = effects.find((effect) => effect.type === "toast");
	assertExists(toast);
	assertEquals(
		toast.type === "toast" ? toast.message : undefined,
		"Answered on another device",
	);
	assertEquals(toast.type === "toast" ? toast.excludeClientId : undefined, "client-a");
});

test("submitting an auth prompt answer without a client id still notifies (older client, shown to everyone)", async () => {
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
				}) =>
					await interaction
						.prompt({ type: "secret", message: "Enter API key" })
						.then((key) => ({ type: "api_key" as const, key })),
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
	const runtime = agentSessionRuntimeStub({ services: { modelRuntime } });
	const state = new AppStore();
	const effects: UiCommitEffect[] = [];
	state.attachPresentation(presentationRecordingEffects(effects));
	const controller = new AuthController(
		() => runtime,
		state,
		() => {},
	);

	controller.openLogin();
	controller.startLogin("custom-cloud", "api_key");

	assertEquals(controller.submitInput("secret"), true);
	await nextTurn();

	const toast = effects.find((effect) => effect.type === "toast");
	assertExists(toast);
	assertEquals(toast.type === "toast" ? toast.excludeClientId : "unset", undefined);
});

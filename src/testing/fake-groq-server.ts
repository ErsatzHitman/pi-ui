/**
 * An ephemeral, in-process stand-in for Groq's `/audio/transcriptions` API
 * (`Bun.serve({ port: 0 })`, the `send-push_integration_test.ts` ephemeral-
 * listener style), so voice-input tests never make a real network call to a
 * real LLM provider. Used by `groq-transcriber_test.ts` (stream A) and the
 * browser e2e harness (stream C).
 */
export interface RecordedGroqRequest {
	/** The request path, e.g. "/openai/v1/audio/transcriptions". */
	path: string;
	authorization: string | null;
	fields: {
		model: string | null;
		language: string | null;
		prompt: string | null;
		response_format: string | null;
		temperature: string | null;
	};
	file: { name: string; type: string; size: number } | null;
	/** Whether the caller (pi-ui's Groq client) abandoned this request before the
	 * fake answered it, e.g. because the browser cancelled mid-transcription. */
	aborted: boolean;
}

export interface FakeGroqRespondOptions {
	status?: number;
	headers?: Record<string, string>;
	/** Delay before responding, in milliseconds. */
	delayMs?: number;
	/** Raw response body. Overrides `json`; use this to send a non-JSON body. */
	body?: string;
	/** JSON response body, serialized for you. Ignored when `body` is set. Defaults
	 * to a permissive success body carrying unknown extra fields, to exercise
	 * `groq-transcriber.ts`'s tolerant parsing. */
	json?: unknown;
}

export type FakeGroqResponder = (
	request: RecordedGroqRequest,
) => FakeGroqRespondOptions | Promise<FakeGroqRespondOptions>;

export interface FakeGroqServer {
	/** Base URL ending in `/openai/v1`, suitable for `voice.baseUrl`. */
	url: string;
	requests: RecordedGroqRequest[];
	/** Scripts the next (and all subsequent, until changed again) responses.
	 * Pass `undefined` to go back to the default 200 success body. */
	respond(responder: FakeGroqResponder | undefined): void;
	stop(): void;
}

const defaultSuccessBody = {
	text: "hello from the fake groq server",
	x_groq: { id: "x" },
	service_tier: "on_demand",
	future_field: 1,
};

export function startFakeGroqServer(
	options: { hostname?: string; port?: number } = {},
): FakeGroqServer {
	const requests: RecordedGroqRequest[] = [];
	let responder: FakeGroqResponder | undefined;

	const server = Bun.serve({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			const formData = await request.formData();
			const file = formData.get("file");
			const recorded: RecordedGroqRequest = {
				path: url.pathname,
				authorization: request.headers.get("authorization"),
				fields: {
					model: fieldAsString(formData.get("model")),
					language: fieldAsString(formData.get("language")),
					prompt: fieldAsString(formData.get("prompt")),
					response_format: fieldAsString(formData.get("response_format")),
					temperature: fieldAsString(formData.get("temperature")),
				},
				file:
					file instanceof File
						? { name: file.name, type: file.type, size: file.size }
						: null,
				aborted: request.signal.aborted,
			};
			request.signal.addEventListener("abort", () => {
				recorded.aborted = true;
			});
			requests.push(recorded);

			const scripted = responder ? await responder(recorded) : undefined;
			if (scripted?.delayMs) {
				await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
			}

			const status = scripted?.status ?? 200;
			const headers = new Headers(scripted?.headers);
			if (scripted?.body !== undefined) {
				if (!headers.has("content-type"))
					headers.set("content-type", "text/plain");
				return new Response(scripted.body, { status, headers });
			}
			if (!headers.has("content-type"))
				headers.set("content-type", "application/json");
			return new Response(JSON.stringify(scripted?.json ?? defaultSuccessBody), {
				status,
				headers,
			});
		},
	});

	return {
		url: `${server.url}openai/v1`,
		requests,
		respond(fn) {
			responder = fn;
		},
		stop() {
			server.stop(true);
		},
	};
}

function fieldAsString(value: FormDataEntryValue | null): string | null {
	return value === null || value instanceof File ? null : value;
}

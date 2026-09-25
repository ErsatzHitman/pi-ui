import type { JsonValue } from "../../utils/json-types.ts";
import { isBoolean, isNumber, isRecord, isString } from "../../utils/type-guards.ts";

/** Voice input (speech-to-text) settings, parsed from `~/.config/pi-ui/config.json`'s
 * `voice` field. See `scripts/generate-config-schema.ts` for the JSON Schema counterpart. */
export type VoiceConfig = Readonly<{
	enabled: boolean;
	model: string;
	/** ISO-639-1 language code, or "" for auto-detect. */
	language: string;
	/** Vocabulary/spelling hint sent with each transcription. */
	prompt: string;
	/** Strip "hmm", "uh", "um"… and 3+ word stutters from transcripts (Handy's filler removal). */
	removeFillerWords: boolean;
	maxSeconds: number;
	baseUrl: string;
}>;

export const defaultVoiceConfig: VoiceConfig = {
	enabled: true,
	model: "whisper-large-v3-turbo",
	language: "",
	prompt: "",
	removeFillerWords: true,
	maxSeconds: 300,
	baseUrl: "https://api.groq.com/openai/v1",
};

export const voiceMaxSecondsMin = 10;
export const voiceMaxSecondsMax = 1800;
export const voicePromptMaxLength = 896;

// ISO-639-1/639-2 primary subtag, optionally followed by a script/region subtag
// (e.g. "en", "zh-Hans"); empty string means auto-detect.
const LANGUAGE_PATTERN = /^([a-z]{2,3}(-[A-Za-z]+)?)?$/;

/**
 * Tolerant parse: never throws, and every field falls back to its default
 * independently of the others (the `auto-title.ts` pattern), so one bad field
 * in a hand-edited config never blanks out the rest.
 */
export function parseVoiceConfig(value: JsonValue | undefined): VoiceConfig {
	if (!isRecord(value)) return defaultVoiceConfig;
	return {
		enabled: isBoolean(value.enabled) ? value.enabled : defaultVoiceConfig.enabled,
		model: isNonEmptyString(value.model)
			? value.model.trim()
			: defaultVoiceConfig.model,
		language:
			isString(value.language) && LANGUAGE_PATTERN.test(value.language.trim())
				? value.language.trim()
				: defaultVoiceConfig.language,
		prompt:
			isString(value.prompt) && value.prompt.length <= voicePromptMaxLength
				? value.prompt
				: defaultVoiceConfig.prompt,
		removeFillerWords: isBoolean(value.removeFillerWords)
			? value.removeFillerWords
			: defaultVoiceConfig.removeFillerWords,
		maxSeconds:
			isNumber(value.maxSeconds) && Number.isInteger(value.maxSeconds)
				? clamp(value.maxSeconds, voiceMaxSecondsMin, voiceMaxSecondsMax)
				: defaultVoiceConfig.maxSeconds,
		baseUrl:
			isString(value.baseUrl) && isHttpUrl(value.baseUrl)
				? value.baseUrl
				: defaultVoiceConfig.baseUrl,
	};
}

function isNonEmptyString<Value>(value: Value): value is Value & string {
	return isString(value) && value.trim().length > 0;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

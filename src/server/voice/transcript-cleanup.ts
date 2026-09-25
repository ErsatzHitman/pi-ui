// Post-transcription cleanup, ported from Handy's `audio_toolkit/text.rs`
// (`remove_filler_words` + `normalize_transcription_output`): Whisper happily
// transcribes the "hmm"s and "uh"s of natural speech, and a dictated prompt
// should not carry them. Two tiers, as in Handy:
//
// - Universal fillers are not a word in any language, so they are removed
//   whatever language the audio was in.
// - Gated fillers are real words somewhere (Portuguese/German "um", Spanish
//   "ha"), so they are removed only with evidence that the output is in the
//   one language where they are fillers: the configured `voice.language`, or
//   the language Whisper itself detected. Unknown language fails closed.
//
// Unlike Handy's exact-word list, each filler is a pattern, so elongated forms
// ("hmmm", "uhhh", "ummm") are caught too.

/** Letters/digits on either side mean the match is inside a real word. */
const WORD_EDGE_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const WORD_EDGE_AFTER = String.raw`(?![\p{L}\p{N}])`;

const UNIVERSAL_FILLERS = [
	"h+m+", // hm, hmm, hmmm
	"m{3,}", // mmm ("mm" is millimetres)
	"u+h+", // uh, uhh
	"u+h+m+", // uhm
	"u+m{2,}", // umm, ummm ("um" is gated)
	"e+h{2,}", // ehh
	"e+h+m+", // ehm
	"a+h+m+", // ahm
	"х+м+", // хм
	"м{3,}", // ммм
];

const GATED_FILLERS = new Map([
	["en", ["u+m", "a+h+", "e+h", "ha", "e+r+m+"]],
	["de", ["ä+h+", "ä+h+m+"]],
	["fr", ["e+u+h+"]],
]);

/** Whisper's `verbose_json` reports the detected language by name. */
const LANGUAGE_NAMES = new Map([
	["english", "en"],
	["german", "de"],
	["french", "fr"],
]);

/** ISO-639-1 code for a configured code ("en", "en-GB") or a Whisper language
 * name ("English"), or undefined when there is no usable evidence. */
export function transcriptLanguageCode(language: string | undefined): string | undefined {
	const normalized = language?.trim().toLowerCase();
	if (!normalized) return undefined;
	const named = LANGUAGE_NAMES.get(normalized);
	if (named) return named;
	const code = normalized.split(/[-_]/, 1)[0];
	return code && /^[a-z]{2,3}$/.test(code) ? code : undefined;
}

function fillerPattern(language: string | undefined): RegExp {
	const gated = (language && GATED_FILLERS.get(language)) ?? [];
	const alternatives = [...UNIVERSAL_FILLERS, ...gated].join("|");
	// A trailing comma or ellipsis belongs to the filler ("so, um, then" -> "so, then",
	// "hmm... fine" -> "fine"); a single "." is left for `tidyPunctuation` so a
	// sentence-final period survives.
	return new RegExp(
		`${WORD_EDGE_BEFORE}(?:${alternatives})${WORD_EDGE_AFTER}(?:,|\\.{2,}|…)?`,
		"giu",
	);
}

/** "I I I I think" -> "I think": 3+ consecutive repeats of one word (Handy's rule). */
function collapseStutters(text: string): string {
	return text.replace(
		new RegExp(
			`${WORD_EDGE_BEFORE}(\\p{L}+)(?:\\s+\\1${WORD_EDGE_AFTER}){2,}`,
			"giu",
		),
		"$1",
	);
}

function tidyPunctuation(text: string): string {
	return (
		text
			// "done. hmm." -> "done. ." -> "done."
			.replace(/([.!?…])\s+\.(?=\s|$)/gu, "$1")
			// "so , then" -> "so, then"
			.replace(/[^\S\n]+([,.!?;:…])/gu, "$1")
			// "so, ." -> "so."
			.replace(/[,;:]+(?=[.!?…])/gu, "")
			// "Hmm. So" -> ". So" -> "So"; also a dangling trailing comma
			.replace(/^[\s,.;:!?…]+/u, "")
			.replace(/[\s,;:]+$/u, "")
			.replace(/[^\S\n]{2,}/gu, " ")
			.trim()
	);
}

export interface TranscriptCleanupOptions {
	removeFillerWords: boolean;
	/** Configured `voice.language` or Whisper's detected language (code or name). */
	language?: string;
}

export function cleanTranscript(text: string, options: TranscriptCleanupOptions): string {
	let cleaned = text;
	if (options.removeFillerWords) {
		cleaned = cleaned.replace(
			fillerPattern(transcriptLanguageCode(options.language)),
			"",
		);
	}
	cleaned = tidyPunctuation(collapseStutters(cleaned));
	// Removing a leading "Hmm," must not leave the prompt starting in lower case.
	const firstOriginal = text.trim().charAt(0);
	if (
		cleaned &&
		firstOriginal !== firstOriginal.toLowerCase() &&
		cleaned.charAt(0) !== cleaned.charAt(0).toUpperCase()
	) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	return cleaned;
}

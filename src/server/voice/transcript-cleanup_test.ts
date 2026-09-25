import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { cleanTranscript, transcriptLanguageCode } from "./transcript-cleanup.ts";

const on = (text: string, language?: string) =>
	cleanTranscript(text, { removeFillerWords: true, language });

test("removes universal fillers, including elongated ones, with no language evidence", () => {
	assertEquals(
		on("Hmm. So I think we should ship it."),
		"So I think we should ship it.",
	);
	assertEquals(
		on("hmmm okay let me check, uhh, the logs"),
		"okay let me check, the logs",
	);
	assertEquals(on("We need, uhm, a test for this, hmm."), "We need, a test for this.");
	assertEquals(on("Mmm, fine. Hmm."), "Fine.");
	assertEquals(on("Хм, давай посмотрим"), "Давай посмотрим");
});

test("a transcript that was only filler becomes empty", () => {
	assertEquals(on("Hmm."), "");
	assertEquals(on("Uh, hmm... hmmm."), "");
});

test("gated fillers are removed only with evidence the output is in that language", () => {
	assertEquals(on("Um, so, ah, that works", "en"), "So, that works");
	assertEquals(on("Um, so, ah, that works", "English"), "So, that works");
	// Unknown language fails closed: "um" is a real word in Portuguese and German.
	assertEquals(on("Um, so, ah, that works"), "Um, so, ah, that works");
	assertEquals(on("Ich komme um acht", "de"), "Ich komme um acht");
	assertEquals(on("Eu tenho um gato", "pt"), "Eu tenho um gato");
	assertEquals(on("Äh, ich glaube schon", "de"), "Ich glaube schon");
	assertEquals(on("Euh, je pense que oui", "French"), "Je pense que oui");
});

test("never touches fillers embedded in real words", () => {
	assertEquals(
		on("The human umbrella uhaul shmm hummus", "en"),
		"The human umbrella uhaul shmm hummus",
	);
	assertEquals(on("Set the width to 5 mm", "en"), "Set the width to 5 mm");
});

test("collapses 3+ word stutters but keeps a deliberate double", () => {
	assertEquals(on("I I I I think it is is fine"), "I think it is is fine");
	assertEquals(on("The the the plan works"), "The plan works");
});

test("disabled removal still normalizes stutters and whitespace", () => {
	assertEquals(
		cleanTranscript("  Hmm,  so so so   yes ", { removeFillerWords: false }),
		"Hmm, so yes",
	);
});

test("keeps line breaks and ordinary punctuation intact", () => {
	assertEquals(
		on("First line.\nSecond line, hmm, done."),
		"First line.\nSecond line, done.",
	);
	assertEquals(on("Is it 3.5 or 4? Hmm... 4!"), "Is it 3.5 or 4? 4!");
});

test("transcriptLanguageCode accepts codes, regional codes and Whisper names", () => {
	assertEquals(transcriptLanguageCode("en"), "en");
	assertEquals(transcriptLanguageCode("en-GB"), "en");
	assertEquals(transcriptLanguageCode("English"), "en");
	assertEquals(transcriptLanguageCode("german"), "de");
	assertEquals(transcriptLanguageCode(""), undefined);
	assertEquals(transcriptLanguageCode(undefined), undefined);
	assertEquals(transcriptLanguageCode("klingon language"), undefined);
});

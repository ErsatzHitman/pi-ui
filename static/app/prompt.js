export function promptInput() {
	const input = document.getElementById("prompt-input");
	return input instanceof HTMLTextAreaElement ? input : undefined;
}

export function setPromptValue(value) {
	const input = promptInput();
	if (!input) return;
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function focusPromptEnd() {
	const input = promptInput();
	if (!input) return;
	input.focus({ preventScroll: true });
	input.selectionStart = input.value.length;
	input.selectionEnd = input.value.length;
}

/**
 * Places a notice element above the whole editor row (a flex row: the voice panel, the
 * textarea, and the editor actions) instead of directly before the textarea within that
 * row. Inserting it inside the row turns it into a flex column that squeezes the
 * textarea — at 390px down to a couple of words per line, and even at 1280px by roughly a
 * third — instead of the notice spanning the full prompt surface above everything. Shared
 * by every prompt notice with this shape: voice.js's errors/blocked explanations
 * (DESIGN-voice.md's original fix) and file-transfer.js's showTransferError (the same bug,
 * fixed the same way — AUDIT-voice.md remaining #1).
 */
export function placeNoticeAbovePromptRow(el, input) {
	(input.closest(".prompt-editor-row") ?? input).before(el);
}

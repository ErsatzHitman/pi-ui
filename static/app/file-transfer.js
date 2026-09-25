import { isString } from "../../src/utils/type-guards.ts";
import { fileUriToPath } from "../file-uri.js";
import {
	attachmentFileExtension,
	attachmentFileIcons,
	attachmentFileKind,
} from "./attachment-file.js";
import { duration, easing, reducedMotion } from "./motion.js";
import { closePickers } from "./pickers.js";
import { placeNoticeAbovePromptRow, promptInput } from "./prompt.js";

const FILE_REFERENCE_TYPES = [
	"text/uri-list",
	"x-special/gnome-copied-files",
	"text/plain",
];
const MAX_TRANSFER_FILES = 10;
const MAX_TRANSFER_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TRANSFER_TOTAL_BYTES = 50 * 1024 * 1024;
const AVIF_JPEG_QUALITY = 0.85;
let dragDepth = 0;
let submitting = false;
const attachments = [];
// Chip nodes keyed by attachment identity (D7): a change appends only new chips and removes
// only departed ones, so `@starting-style` plays once per real insertion (prompt-box.css).
let attachmentNodes = new Map();
// Sent attachments leave at once: their chips re-appear in the user message.
const instantRemovals = new WeakSet();

export function hasFiles(data) {
	if (!data) return false;
	if (data.files?.length) return true;
	return data.types.includes("Files") || data.types.includes("text/uri-list");
}

export function pick() {
	showTransferError("");
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	input.addEventListener(
		"change",
		() => {
			if (input.files?.length) void insert(input.files);
		},
		{ once: true },
	);
	input.click();
}

export function enterDrag() {
	dragDepth += 1;
	return true;
}

export function leaveDrag() {
	dragDepth = Math.max(0, dragDepth - 1);
	return dragDepth > 0;
}

export function resetDrag() {
	dragDepth = 0;
}

export async function insert(data) {
	if (!data) return;
	showTransferError("");
	const transferred = transferredFiles(data);
	const needsImageHandling = transferred.some(
		(file) => isAvifImageFile(file) || isHeicImageFile(file),
	);
	const paths = extractTransferredFilePaths(data);
	if (paths.length > 0 && !needsImageHandling) {
		const unsupported = unsupportedImagePathError(paths);
		if (unsupported) {
			showTransferError(unsupported);
			return;
		}
		addPathAttachments(paths);
		return;
	}
	if (transferred.length === 0) return;
	const validationError = validateTransferredFiles(transferred);
	if (validationError) {
		showTransferError(validationError);
		return;
	}
	let files;
	try {
		files = await prepareTransferredImages(transferred);
	} catch (error) {
		console.error(error);
		showTransferError(error?.message || "Could not prepare the selected images.");
		return;
	}
	const preparedValidationError = validateTransferredFiles(files);
	if (preparedValidationError) {
		showTransferError(preparedValidationError);
		return;
	}
	const uploaded = await uploadTransferredFiles(files);
	for (let index = 0; index < uploaded.length; index += 1) {
		addAttachment({
			path: uploaded[index].path,
			file: fileWithDetectedMimeType(files[index], uploaded[index].mimeType),
		});
	}
}

export function hasAttachments() {
	return attachments.length > 0;
}

export function canSubmit(prompt) {
	return !submitting && (prompt.trim() !== "" || hasAttachments());
}

export async function submit(endpoint, prompt, streamingBehavior) {
	if (!canSubmit(prompt)) return false;
	const submittedAttachments = [...attachments];
	const submittedPrompt = composePrompt(
		prompt,
		submittedAttachments.map(({ path }) => path),
	);
	const formData = new FormData();
	formData.set("prompt", submittedPrompt);
	if (streamingBehavior) formData.set("streamingBehavior", streamingBehavior);
	for (const { file } of submittedAttachments) {
		if (file?.type.startsWith("image/"))
			formData.append("image", file, file.name || "pasted-image");
	}
	submitting = true;
	try {
		const response = await fetch(endpoint, { method: "POST", body: formData });
		await response.text();
		if (!response.ok)
			throw new Error(`Prompt was not accepted (${response.status}).`);
		removeSubmittedAttachments(submittedAttachments);
		showTransferError("");
		return true;
	} catch (error) {
		restoreSubmittedPrompt(prompt);
		showTransferError(error?.message || "Could not send the prompt.");
		// The send flow (sending state, held spacer) unwinds on this.
		document.dispatchEvent(new CustomEvent("pi-ui-prompt-send-failed"));
		return false;
	} finally {
		submitting = false;
		document
			.getElementById("prompt-box")
			?.dispatchEvent(
				new CustomEvent("pi-ui-prompt-submit-finished", { bubbles: true }),
			);
		renderAttachments();
	}
}

export function extractTransferredFilePaths(data) {
	const references =
		"getData" in data
			? FILE_REFERENCE_TYPES.flatMap((type) => data.getData(type).split(/\r?\n/))
			: [];
	for (const file of transferredFiles(data)) {
		references.push(file.path ?? "", file.webkitRelativePath ?? "");
	}
	const paths = new Set(references.map(fileReferenceToPath));
	paths.delete(undefined);
	return [...paths];
}

function transferredFiles(data) {
	if (data.files) return [...data.files];
	return Array.from(data);
}

export function isAvifImageFile(file) {
	return file.type?.toLowerCase() === "image/avif" || /\.avif$/i.test(file.name ?? "");
}

export function isHeicImageFile(file) {
	return (
		/^(?:image\/)?hei[cf]$/i.test(file.type ?? "") ||
		/\.hei[cf]$/i.test(file.name ?? "")
	);
}

export function jpegFileName(name) {
	return /\.avif$/i.test(name)
		? name.replace(/\.avif$/i, ".jpg")
		: `${name || "image"}.jpg`;
}

export function fileWithDetectedMimeType(file, mimeType) {
	if (mimeType === undefined || file.type === mimeType) return file;
	return new File([file], file.name, {
		type: mimeType ?? "",
		lastModified: file.lastModified,
	});
}

function prepareTransferredImages(files) {
	return Array.fromAsync(files, (file) => {
		if (isHeicImageFile(file)) {
			throw new Error(
				"HEIC and HEIF images are not supported. Convert them to JPEG or PNG first.",
			);
		}
		return isAvifImageFile(file) ? convertAvifToJpeg(file) : file;
	});
}

export async function convertAvifToJpeg(file) {
	let bitmap;
	try {
		bitmap = await createImageBitmap(file);
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas image conversion is unavailable.");
		context.fillStyle = "white";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise((resolve, reject) => {
			canvas.toBlob(
				(result) =>
					result ? resolve(result) : reject(new Error("JPEG encoding failed.")),
				"image/jpeg",
				AVIF_JPEG_QUALITY,
			);
		});
		return new File([blob], jpegFileName(file.name), {
			type: "image/jpeg",
			lastModified: file.lastModified,
		});
	} catch (error) {
		throw new Error(`Could not convert ${file.name || "the AVIF image"} to JPEG.`, {
			cause: error,
		});
	} finally {
		bitmap?.close();
	}
}

function unsupportedImagePathError(paths) {
	if (paths.some((path) => /\.hei[cf]$/i.test(path))) {
		return "HEIC and HEIF images are not supported. Convert them to JPEG or PNG first.";
	}
	if (paths.some((path) => /\.avif$/i.test(path))) {
		return "AVIF images must be dropped, pasted, or selected with the browser file picker so they can be converted.";
	}
}

function fileReferenceToPath(value) {
	const reference = value.trim();
	if (
		!reference ||
		reference.startsWith("#") ||
		reference === "copy" ||
		reference === "cut"
	) {
		return undefined;
	}
	const uriPath = fileUriToPath(reference);
	if (uriPath) return uriPath;
	if (reference.startsWith("/") || /^[A-Za-z]:[\\/]/.test(reference)) return reference;
	return undefined;
}

function validateTransferredFiles(files) {
	if (files.length > MAX_TRANSFER_FILES) {
		return `Attach at most ${MAX_TRANSFER_FILES} files at a time.`;
	}
	let totalBytes = 0;
	for (const file of files) {
		if (file.size > MAX_TRANSFER_FILE_BYTES) {
			return "Dropped or pasted files must be 20 MiB or smaller; use the Files button for larger files.";
		}
		totalBytes += file.size;
	}
	if (totalBytes > MAX_TRANSFER_TOTAL_BYTES) {
		return "Dropped or pasted files must total 50 MiB or less.";
	}
}

async function uploadTransferredFiles(files) {
	const formData = new FormData();
	for (const file of files) formData.append("file", file, file.name || "pasted-file");
	try {
		const endpoint = document.body.dataset.filesImportEndpoint;
		const response = await fetch(endpoint, { method: "POST", body: formData });
		const result = await response.json().catch(() => ({}));
		if (!response.ok) {
			showTransferError(
				isString(result.message)
					? result.message
					: "Could not transfer the selected files.",
			);
			return [];
		}
		showTransferError("");
		return Array.isArray(result.imports) ? result.imports : [];
	} catch {
		showTransferError("Could not transfer the selected files.");
		return [];
	}
}

function showTransferError(message) {
	const input = promptInput();
	if (!input) return;
	let error = document.getElementById("file-transfer-error");
	if (!(error instanceof HTMLParagraphElement)) {
		error = document.createElement("p");
		error.id = "file-transfer-error";
		error.className = "file-transfer-error";
		error.setAttribute("role", "alert");
		error.setAttribute("aria-live", "polite");
		placeNoticeAbovePromptRow(error, input);
	}
	// Clearing only hides: the text stays for the 120ms fade-out (prompt-box.css) and is
	// replaced by the next message. A hidden paragraph is out of the accessibility tree.
	if (message) error.textContent = message;
	error.hidden = !message;
}

export function formatFileReferences(paths) {
	return `${paths.map((path) => `@${path}`).join("\n")}\n`;
}

export function composePrompt(prompt, paths) {
	const references = formatFileReferences(paths);
	return prompt.trim() ? `${references}${prompt}` : references.trimEnd();
}

function addPathAttachments(paths) {
	for (const path of paths) addAttachment({ path });
}

function addAttachment({ path, file }) {
	if (!path || attachments.some((attachment) => attachment.path === path)) return;
	attachments.push({
		path,
		file,
		previewUrl: file?.type.startsWith("image/")
			? URL.createObjectURL(file)
			: undefined,
	});
	renderAttachments();
	promptInput()?.focus();
	closePickers(true);
}

function restoreSubmittedPrompt(prompt) {
	const input = promptInput();
	if (!input || input.value !== "" || !prompt) return;
	input.value = prompt;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function removeSubmittedAttachments(submitted) {
	for (const attachment of submitted) {
		const index = attachments.indexOf(attachment);
		if (index < 0) continue;
		attachments.splice(index, 1);
		instantRemovals.add(attachment);
	}
}

function removeAttachment(path) {
	const index = attachments.findIndex((attachment) => attachment.path === path);
	if (index < 0) return;
	attachments.splice(index, 1);
	renderAttachments();
}

/**
 * Pure keyed reconcile: reuses the node of every key still present, creates nodes only for
 * new keys (in order) and reports the departed ones. Exported for tests.
 */
export function reconcileKeyed(previous, keys, create) {
	const nodes = new Map();
	const added = [];
	for (const key of keys) {
		let node = previous.get(key);
		if (node === undefined) {
			node = create(key);
			added.push(node);
		}
		nodes.set(key, node);
	}
	const removed = [...previous].filter(([key]) => !nodes.has(key));
	return { nodes, added, removed };
}

/**
 * Exit keyframes for a removed chip, starting from its computed values at the click (D-X1).
 * An implicit start keyframe would not do: `click` fires after `:active` ends, so the
 * underlying scale is already 1 and the chip's own CSS scale transition (which outranks
 * animations) would ease it back up while it fades. The caller reads `from` first and then
 * suppresses the chip's transitions (`[data-exiting]`), so a pressed chip leaves from 0.97.
 * Reduced motion: opacity only.
 */
export function attachmentExitKeyframes(reduce, from) {
	return reduce
		? [{ opacity: from.opacity }, { opacity: 0 }]
		: [
				{ opacity: from.opacity, scale: from.scale },
				{ opacity: 0, scale: 0.96 },
			];
}

/** Pure: a chip's current opacity/scale from its computed style (`scale: none` is 1). */
export function currentChipState(style) {
	return {
		opacity: Number(style.opacity),
		scale: style.scale === "none" ? "1" : style.scale,
	};
}

function renderAttachments() {
	const tray = document.getElementById("prompt-attachments");
	if (!(tray instanceof HTMLElement)) return;
	const { nodes, removed } = reconcileKeyed(
		attachmentNodes,
		attachments,
		renderAttachment,
	);
	attachmentNodes = nodes;
	// The tray's height before this change: 0 while hidden, mid-tween wherever it is. A
	// change that leaves chips (first chip, a chip wrapping to a new row, a chip added while
	// the tray folds away) eases to the new height; the last removal folds in exitAttachment.
	const trayBefore = tray.hidden ? 0 : tray.offsetHeight;
	const keepsChips = attachments.length > 0;
	for (const [attachment, node] of removed) {
		if (instantRemovals.has(attachment) || !node.isConnected) {
			node.remove();
			revokePreview(attachment);
		} else exitAttachment(tray, node, attachment);
	}
	// New chips, plus kept chips whose tray was re-rendered, go to the end in order.
	for (const node of nodes.values()) if (node.parentElement !== tray) tray.append(node);
	if (keepsChips) {
		trayCollapse?.cancel();
		trayCollapse = undefined;
	}
	syncTrayHidden(tray);
	if (keepsChips && removed.length === 0)
		resizeTray(tray, trayBefore, tray.offsetHeight);
	const send = document.querySelector("[data-send-trigger]");
	if (send instanceof HTMLButtonElement)
		send.disabled = !canSubmit(promptInput()?.value ?? "");
}

/**
 * A removed chip leaves (fade + shrink from its press scale); the chips after it glide into
 * the freed slot once it is gone. It stops being a control at once: inert, hidden from
 * assistive tech, and focus (if it had it) moves to the next chip or the prompt.
 * Exported for tests.
 */
export function exitAttachment(tray, node, attachment) {
	// Read before [data-exiting] drops the transitions: mid-press-release this is ~0.97.
	const style = getComputedStyle(node);
	const from = currentChipState(style);
	// Hold the press scale underneath too, so the :active release cannot ease it back up.
	node.style.scale = style.scale;
	node.setAttribute("data-exiting", "");
	node.style.pointerEvents = "none";
	const hadFocus = node.contains(document.activeElement);
	node.inert = true;
	node.setAttribute("aria-hidden", "true");
	const last = !tray.querySelector(".prompt-attachment:not([data-exiting])");
	if (hadFocus)
		(
			tray.querySelector(".prompt-attachment:not([data-exiting])") ?? promptInput()
		)?.focus({ preventScroll: true });
	// The last chip: the tray folds away while the chip fades, not after it.
	if (last && attachments.length === 0) collapseTray(tray);
	const done = () => {
		const before = survivorRects(tray);
		node.remove();
		// Revoke only after the exit, or the fading image chip would lose its preview.
		revokePreview(attachment);
		syncTrayHidden(tray);
		glideSurvivors(before);
	};
	node.animate(attachmentExitKeyframes(reducedMotion(), from), {
		duration: duration.sm,
		easing: easing.out,
		fill: "forwards",
	}).finished.then(done, done);
}

// In-flight survivor glides, so a second removal restarts from where the chip is.
const glides = new WeakMap();

function survivorRects(tray) {
	return [...tray.querySelectorAll(".prompt-attachment:not([data-exiting])")].map(
		(chip) => ({ chip, rect: chip.getBoundingClientRect() }),
	);
}

/** FLIP: each survivor starts where it was before the removal and glides to its slot. */
function glideSurvivors(before) {
	if (reducedMotion()) return;
	for (const { chip, rect } of before) {
		// The pre-removal rect included any in-flight glide; measure the new slot without it.
		glides.get(chip)?.cancel();
		const after = chip.getBoundingClientRect();
		const dx = rect.left - after.left;
		const dy = rect.top - after.top;
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
		glides.set(
			chip,
			chip.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
				duration: duration.md,
				easing: easing.out,
			}),
		);
	}
}

/** The tray stays shown while its last chip fades out and while it folds away. */
function syncTrayHidden(tray) {
	tray.hidden =
		attachments.length === 0 &&
		trayCollapse === undefined &&
		!tray.querySelector(".prompt-attachment[data-exiting]");
}

// The running fold of an emptied tray, until it ends (or a new chip reopens the tray).
let trayCollapse;
let trayResize;

/**
 * Pure: keyframes that ease the attachment tray between two heights (flow-critique S2). The
 * composer is bottom-anchored, so the tray's first chip or its last removal moves the
 * composer's top edge (and the queue above it) by the whole row: this bridges that edge
 * instead of jumping it in one frame. The margin under the row folds with it. `overflow:
 * clip` holds for the whole tween, so the chip is revealed or tucked away by the edge.
 */
export function trayResizeKeyframes(from, to, margin) {
	const box = (height) => ({
		height: `${height}px`,
		marginBottom: height === 0 ? "0px" : margin,
		overflow: "clip",
	});
	return [box(from), box(to)];
}

/** Tweens the tray from `from` to `to` px (160ms). Reduced motion: the height steps. */
function resizeTray(tray, from, to) {
	trayResize?.cancel();
	trayResize = undefined;
	if (reducedMotion() || Math.abs(to - from) < 1) return undefined;
	const margin = getComputedStyle(tray).marginBottom;
	trayResize = tray.animate(trayResizeKeyframes(from, to, margin), {
		duration: duration.md,
		easing: easing.out,
	});
	return trayResize;
}

/** Folds the emptied tray to 0 alongside its last chip's exit, then hides it. */
export function collapseTray(tray) {
	const animation = resizeTray(tray, tray.offsetHeight, 0);
	if (!animation) return;
	trayCollapse = animation;
	const done = () => {
		if (trayCollapse !== animation) return;
		trayCollapse = undefined;
		syncTrayHidden(tray);
	};
	// Settles in the frame the fold ends (before it paints), so the tray never springs back.
	animation.finished.then(done, done);
}

function revokePreview(attachment) {
	if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

function renderAttachment(attachment) {
	const name = attachment.file?.name || displayName(attachment.path);
	const item = document.createElement("button");
	item.type = "button";
	item.className = `prompt-attachment prompt-attachment-${attachment.previewUrl ? "image" : "file"}`;
	item.setAttribute("aria-label", `Remove ${name}`);
	item.addEventListener("click", () => removeAttachment(attachment.path));
	if (attachment.previewUrl) {
		const preview = document.createElement("span");
		preview.className = "prompt-attachment-preview";
		const image = document.createElement("img");
		image.className = "prompt-attachment-image-content";
		image.src = attachment.previewUrl;
		image.alt = name;
		preview.append(image);
		item.append(preview, removeBadge());
		return item;
	}

	const extension = attachmentFileExtension(name);
	const kind = attachmentFileKind(name, attachment.file?.type);
	const icon = document.createElement("span");
	icon.className = "prompt-attachment-file-icon";
	icon.dataset.fileKind = kind;
	icon.append(attachmentFileIcon(kind));
	if (extension) {
		const extensionElement = document.createElement("span");
		extensionElement.className = "prompt-attachment-extension";
		extensionElement.textContent = extension;
		icon.append(extensionElement);
	}
	item.append(icon);
	const details = document.createElement("span");
	details.className = "prompt-attachment-details";
	const nameElement = document.createElement("span");
	nameElement.className = "prompt-attachment-name";
	nameElement.textContent = name;
	details.append(nameElement);
	const meta = document.createElement("span");
	meta.className = "prompt-attachment-meta";
	meta.textContent = attachment.file ? formatBytes(attachment.file.size) : "local file";
	details.append(meta);
	item.append(details, removeBadge());
	return item;
}

function removeBadge() {
	const badge = document.createElement("span");
	badge.className = "prompt-attachment-remove";
	badge.textContent = "×";
	badge.setAttribute("aria-hidden", "true");
	return badge;
}

function displayName(path) {
	return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function attachmentFileIcon(kind) {
	const namespace = "http://www.w3.org/2000/svg";
	const icon = attachmentFileIcons[kind] ?? attachmentFileIcons.file;
	const svg = document.createElementNS(namespace, "svg");
	svg.setAttribute("class", "prompt-attachment-file-type-icon");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("aria-hidden", "true");
	for (const data of icon.paths) {
		const path = document.createElementNS(namespace, "path");
		path.setAttribute("d", data);
		svg.append(path);
	}
	if (icon.circle) {
		const circle = document.createElementNS(namespace, "circle");
		for (const [name, value] of Object.entries(icon.circle)) {
			circle.setAttribute(name, String(value));
		}
		svg.append(circle);
	}
	return svg;
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

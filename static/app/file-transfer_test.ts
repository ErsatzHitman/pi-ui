import { test } from "bun:test";

import { assertEquals, assertRejects } from "#testing/assertions";

import { attachmentFileExtension, attachmentFileKind } from "./attachment-file.js";

Object.defineProperty(globalThis, "ResizeObserver", {
	configurable: true,
	value: class {
		disconnect() {
			return undefined;
		}
		observe() {
			return undefined;
		}
	},
});

const {
	attachmentExitKeyframes,
	composePrompt,
	convertAvifToJpeg,
	currentChipState,
	extractTransferredFilePaths,
	fileWithDetectedMimeType,
	formatFileReferences,
	isAvifImageFile,
	isHeicImageFile,
	jpegFileName,
	reconcileKeyed,
} = await import("./file-transfer.js");

test("file references use one line per path and end with a newline", () => {
	assertEquals(
		formatFileReferences(["/tmp/one.txt", "/tmp/two.txt"]),
		"@/tmp/one.txt\n@/tmp/two.txt\n",
	);
});

test("attachment paths are composed separately from visible prompt editing", () => {
	assertEquals(
		composePrompt("review these", ["/tmp/one.txt", "/tmp/two.txt"]),
		"@/tmp/one.txt\n@/tmp/two.txt\nreview these",
	);
	assertEquals(composePrompt("", ["/tmp/one.txt"]), "@/tmp/one.txt");
});

test("transferred files use their original paths", () => {
	const values = new Map(
		Object.entries({
			"text/uri-list": "# files\nfile:///tmp/one.txt\nfile:///tmp/two%20words.txt",
			"x-special/gnome-copied-files":
				"copy\nfile:///tmp/one.txt\nfile:///tmp/three.txt",
			"text/plain": "/tmp/four.txt\nnot-a-path",
		}),
	);

	assertEquals(
		extractTransferredFilePaths({
			getData: (type: string) => values.get(type) ?? "",
		}),
		["/tmp/one.txt", "/tmp/two words.txt", "/tmp/three.txt", "/tmp/four.txt"],
	);
});

test("attachment file kinds use MIME types and extensions", () => {
	assertEquals(attachmentFileExtension("archive.TAR.GZ"), "gz");
	assertEquals(attachmentFileExtension("README"), "");
	assertEquals(attachmentFileExtension("long.typescript"), "type");
	assertEquals(attachmentFileKind("vadim.txt", "text/plain"), "text");
	assertEquals(attachmentFileKind("recording.ogg", "audio/ogg"), "audio");
	assertEquals(attachmentFileKind("source.ts", ""), "code");
	assertEquals(attachmentFileKind("bundle.zip", ""), "archive");
	assertEquals(attachmentFileKind("unknown.bin", ""), "file");
});

test("server-detected MIME types replace untrusted browser metadata", async () => {
	const original = new File(["image"], "screenshot.bin", {
		type: "application/octet-stream",
		lastModified: 42,
	});
	const detected = fileWithDetectedMimeType(original, "image/png");
	assertEquals(detected.name, original.name);
	assertEquals(detected.type, "image/png");
	assertEquals(detected.lastModified, 42);
	assertEquals(await detected.text(), "image");
	assertEquals(fileWithDetectedMimeType(detected, "image/png"), detected);
	assertEquals(fileWithDetectedMimeType(detected, null).type, "");
	assertEquals(fileWithDetectedMimeType(detected, undefined), detected);
});

test("AVIF images are detected and renamed for JPEG conversion", () => {
	assertEquals(isAvifImageFile({ name: "photo.bin", type: "image/avif" }), true);
	assertEquals(isAvifImageFile({ name: "photo.AVIF", type: "" }), true);
	assertEquals(isAvifImageFile({ name: "photo.png", type: "image/png" }), false);
	assertEquals(jpegFileName("photo.AVIF"), "photo.jpg");
	assertEquals(jpegFileName("pasted-image"), "pasted-image.jpg");
});

test("HEIC and HEIF images are detected by MIME type or extension", () => {
	assertEquals(isHeicImageFile({ name: "photo.bin", type: "image/heic" }), true);
	assertEquals(isHeicImageFile({ name: "photo.HEIF", type: "" }), true);
	assertEquals(isHeicImageFile({ name: "photo.avif", type: "image/avif" }), false);
});

test("AVIF conversion paints before requesting JPEG encoding and releases the bitmap", async () => {
	const originalBitmap = Object.getOwnPropertyDescriptor(
		globalThis,
		"createImageBitmap",
	);
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	let closed = false;
	const bitmap = {
		width: 3200,
		height: 1800,
		close: () => {
			closed = true;
		},
	};
	const painted: string[] = [];
	const context = {
		fillStyle: "",
		fillRect: (...bounds: number[]) => {
			assertEquals(context.fillStyle, "white");
			assertEquals(bounds, [0, 0, 3200, 1800]);
			painted.push("background");
		},
		drawImage: (image: typeof bitmap, ...bounds: number[]) => {
			assertEquals(image === bitmap, true);
			assertEquals(bounds, [0, 0, 3200, 1800]);
			painted.push("image");
		},
	};
	const canvas = {
		width: 0,
		height: 0,
		getContext: (kind: string) => (kind === "2d" ? context : null),
		toBlob: (callback: (blob: Blob) => void, type: string, quality: number) => {
			assertEquals(painted, ["background", "image"]);
			assertEquals(type, "image/jpeg");
			assertEquals(quality, 0.85);
			callback(new Blob(["jpeg"], { type }));
		},
	};
	Object.defineProperty(globalThis, "createImageBitmap", {
		configurable: true,
		value: () => Promise.resolve(bitmap),
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: { createElement: (tag: string) => (tag === "canvas" ? canvas : null) },
	});
	try {
		const converted = await convertAvifToJpeg(
			new File(["avif"], "screenshot.avif", {
				type: "image/avif",
				lastModified: 42,
			}),
		);
		assertEquals(converted.name, "screenshot.jpg");
		assertEquals(converted.type, "image/jpeg");
		assertEquals(converted.lastModified, 42);
		assertEquals(canvas.width, 3200);
		assertEquals(canvas.height, 1800);
		assertEquals(closed, true);
	} finally {
		restoreGlobal("createImageBitmap", originalBitmap);
		restoreGlobal("document", originalDocument);
	}
});

test("AVIF conversion reports decoding failures clearly", async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
	Object.defineProperty(globalThis, "createImageBitmap", {
		configurable: true,
		value: () => Promise.reject(new Error("decode failed")),
	});
	try {
		await assertRejects(
			() =>
				convertAvifToJpeg(
					new File(["broken"], "broken.avif", { type: "image/avif" }),
				),
			Error,
			"Could not convert broken.avif to JPEG.",
		);
	} finally {
		restoreGlobal("createImageBitmap", original);
	}
});

function restoreGlobal(name: string, descriptor?: PropertyDescriptor) {
	if (descriptor) {
		Object.defineProperty(globalThis, name, descriptor);
	} else {
		Reflect.deleteProperty(globalThis, name);
	}
}

test("transferred files use a webview-provided path without reading bytes", () => {
	assertEquals(
		extractTransferredFilePaths({
			files: [{ path: "/tmp/large-model.bin", name: "large-model.bin" }],
		}),
		["/tmp/large-model.bin"],
	);
});

test("adding an attachment keeps the existing chip node; removing one leaves the other intact", () => {
	const first = { path: "/tmp/one.txt" };
	const second = { path: "/tmp/two.txt" };
	const create = (attachment: { path: string }) => ({ chip: attachment.path });

	const one = reconcileKeyed(new Map(), [first], create);
	const firstNode = one.nodes.get(first);
	assertEquals(one.added.length, 1);

	const two = reconcileKeyed(one.nodes, [first, second], create);
	assertEquals(two.nodes.get(first) === firstNode, true);
	assertEquals(two.added, [{ chip: "/tmp/two.txt" }]);
	assertEquals(two.removed, []);

	const secondNode = two.nodes.get(second);
	const back = reconcileKeyed(two.nodes, [second], create);
	assertEquals(back.nodes.get(second) === secondNode, true);
	assertEquals(back.added, []);
	assertEquals(back.removed.length, 1);
	assertEquals(
		back.removed[0]?.[0] === first && back.removed[0]?.[1] === firstNode,
		true,
	);
});

test("a removed chip exits from the scale it had at the click, not from 1", () => {
	// Mid press-release the chip's computed scale is still ~0.97 (D-X1).
	const pressed = currentChipState({ opacity: "1", scale: "0.97" });
	assertEquals(pressed, { opacity: 1, scale: "0.97" });
	assertEquals(attachmentExitKeyframes(false, pressed), [
		{ opacity: 1, scale: "0.97" },
		{ opacity: 0, scale: 0.96 },
	]);
	// Unscaled chip: computed `scale: none` starts at 1; a chip still fading in keeps its opacity.
	assertEquals(currentChipState({ opacity: "0.4", scale: "none" }), {
		opacity: 0.4,
		scale: "1",
	});
	// Reduced motion: opacity only.
	assertEquals(attachmentExitKeyframes(true, pressed), [
		{ opacity: 1 },
		{ opacity: 0 },
	]);
});

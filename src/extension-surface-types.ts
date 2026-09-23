import type { JsonObject, JsonValue } from "./utils/json-types.ts";

/**
 * Pi UI Bridge ("PIUI") wire vocabulary emitted by bridge-aware extensions in RPC mode
 * through `ctx.ui.notify("PIUI " + json)` (see `~/.pi/agent/extensions/lib/bridge.ts`).
 */
export const piUiMarker = "PIUI ";

export const piUiPlacements = ["status", "pinned", "inline", "sheet", "screen"] as const;
export type PiUiPlacement = (typeof piUiPlacements)[number];

export const piUiKinds = [
	"status",
	"widget",
	"panel",
	"progress",
	"roster",
	"log",
	"markdown",
	"diff",
	"form",
	"composer",
] as const;
export type PiUiKind = (typeof piUiKinds)[number];

export type PiUiTone = "default" | "accent" | "success" | "warning" | "error";

export type PiUiAction = {
	id: string;
	label: string;
	variant?: "primary" | "secondary" | "danger";
	confirm?: string;
};

/**
 * A decoded element. Known envelope fields are typed; every other field the extension sent
 * (`text`, `lines`, `rows`, `sections`, `fields`, `value`, `payload`, …) is kept in `data`
 * so renderers can read kind-specific content without the decoder dropping it.
 */
export type PiUiElement = {
	id: string;
	ns: string;
	kind: PiUiKind;
	placement: PiUiPlacement;
	title?: string;
	actions?: readonly PiUiAction[];
	durable?: boolean;
	data: JsonObject;
	/** Monotonic per-element revision, bumped on every set/patch/append. */
	revision: number;
	updatedAt: number;
};

/** Latest payload published on an extension event-bus / PIUI channel. */
export type ExtensionChannelSnapshot = {
	channel: string;
	payload: JsonValue;
	updatedAt: number;
};

/** A user action on a rendered element, routed back to the extension's `pi_ui_event` command. */
export type PiUiActionRequest = {
	elementId: string;
	actionId: string;
	value?: JsonValue;
};

/**
 * A DOM-safe slug for an element's `ns`/`id`. Shared between `AppStore` (which
 * must name the exact dialog id to open when a `sheet`/`screen` element first
 * appears) and the renderer that gives a `<dialog>` that same id — keeping a
 * single source of truth prevents the two from drifting apart.
 *
 * The replacement alone is lossy — `"a.b"` and `"a_b"` both slug to `"a_b"` —
 * so whenever replacing characters actually changed the string, a short
 * deterministic hash of the original value is appended to keep otherwise-
 * colliding raw values apart. A value that was already slug-safe is left
 * untouched (no hash suffix), so the common case stays exactly as readable
 * as before.
 */
export function piUiSlug(value: string): string {
	const slug = value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
	return slug === value ? slug : `${slug}-${shortHash(value)}`;
}

/**
 * A short, deterministic, non-cryptographic hash (cyrb53), used only to
 * disambiguate two different raw strings that `piUiSlug` would otherwise
 * collapse onto the same slug — not for anything security-sensitive.
 */
function shortHash(value: string): string {
	let h1 = 0xdeadbeef ^ value.length;
	let h2 = 0x41c6ce57 ^ value.length;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Whether an element renders as a native `<dialog>` sheet rather than inline. */
export function isPiUiSheetElement(element: Pick<PiUiElement, "placement">): boolean {
	return element.placement === "sheet" || element.placement === "screen";
}

/** The `<dialog>` element id a `sheet`/`screen`-placement element renders under. */
export function piUiDialogId(element: Pick<PiUiElement, "id" | "ns">): string {
	return `piui-sheet-${piUiSlug(element.ns)}-${piUiSlug(element.id)}`;
}

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
 */
export function piUiSlug(value: string): string {
	return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

/** Whether an element renders as a native `<dialog>` sheet rather than inline. */
export function isPiUiSheetElement(element: Pick<PiUiElement, "placement">): boolean {
	return element.placement === "sheet" || element.placement === "screen";
}

/** The `<dialog>` element id a `sheet`/`screen`-placement element renders under. */
export function piUiDialogId(element: Pick<PiUiElement, "id" | "ns">): string {
	return `piui-sheet-${piUiSlug(element.ns)}-${piUiSlug(element.id)}`;
}

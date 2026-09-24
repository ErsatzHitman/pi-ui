import type { ExtensionRef } from "../extension-activity-types.ts";
import { extensionLabelOverrides } from "./policy.ts";

/**
 * The two `Extension` fields identity resolution needs. Kept minimal (rather
 * than importing the SDK's `Extension`/`SourceInfo` types) so this module has
 * no SDK dependency and stays trivially unit-testable — see
 * `DESIGN-ext-activity.md` §2.2.8.
 */
export type IdentitySource = Readonly<{
	/** `Extension.resolvedPath`. */
	resolvedPath: string;
	/** `Extension.sourceInfo.source` (`"local"`, `"npm:@narumitw/pi-lsp"`, `"cli"`, …). */
	source: string;
}>;

/**
 * Slug rules (§2.2.8):
 * - a package source (`npm:@scope/name[@version]` or `npm:name[@version]`)
 *   uses the package name with any npm scope stripped;
 * - otherwise, a directory extension (`…/jev/index.ts`) uses the directory
 *   name, and a single-file extension (`…/vision-proxy.ts`) uses its
 *   basename without extension.
 */
export function resolveExtensionSlug(input: IdentitySource): string {
	const packageName = parseNpmPackageName(input.source);
	if (packageName) return stripNpmScope(packageName);
	return slugFromPath(input.resolvedPath);
}

/** Falls back to title case (`vision-proxy` → `Vision Proxy`) when no
 * override applies — see `policy.ts`'s `extensionLabelOverrides`. */
export function resolveExtensionLabel(slug: string): string {
	if (Object.hasOwn(extensionLabelOverrides, slug)) {
		// SAFETY: `Object.hasOwn` just confirmed `slug` is one of
		// `extensionLabelOverrides`'s own literal keys.
		return extensionLabelOverrides[slug as keyof typeof extensionLabelOverrides];
	}
	return titleCaseSlug(slug);
}

export function resolveExtensionRef(input: IdentitySource): ExtensionRef {
	const id = resolveExtensionSlug(input);
	return {
		id,
		label: resolveExtensionLabel(id),
		path: input.resolvedPath,
		source: input.source,
	};
}

function parseNpmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice("npm:".length).trim();
	if (spec.length === 0) return undefined;
	if (spec.startsWith("@")) {
		const versionAt = spec.indexOf("@", 1);
		return versionAt === -1 ? spec : spec.slice(0, versionAt);
	}
	const versionAt = spec.indexOf("@");
	return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

function stripNpmScope(packageName: string): string {
	if (!packageName.startsWith("@")) return packageName;
	const slash = packageName.indexOf("/");
	return slash === -1 ? packageName : packageName.slice(slash + 1);
}

const extensionFileExtensionPattern = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** Bare "entry point" basenames that mean "use the parent directory's name
 * instead" — matches how directory extensions are conventionally authored. */
const entryPointBasenames = new Set(["index", "main"]);

function slugFromPath(resolvedPath: string): string {
	const normalized = resolvedPath.replace(/\\/g, "/");
	const withoutExtension = normalized.replace(extensionFileExtensionPattern, "");
	const segments = withoutExtension.split("/").filter((segment) => segment.length > 0);
	const base = segments.at(-1) ?? withoutExtension;
	const parent = segments.at(-2);
	if (entryPointBasenames.has(base) && segments.length > 1) {
		// SAFETY: `parent` is defined whenever `segments.length > 1`, since
		// `.at(-2)` only returns `undefined` for arrays shorter than two elements.
		return parent as string;
	}
	return base;
}

function titleCaseSlug(slug: string): string {
	const words = slug.split(/[-_]+/).filter((word) => word.length > 0);
	if (words.length === 0) return slug;
	return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

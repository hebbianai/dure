import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";
import type { UiPrefs } from "@/lib/settings/uiPrefs";

export function canonicalThemeId(id: string | undefined): string | undefined {
	if (id === LEGACY_PRODUCT_COMPATIBILITY.builtinThemeIds.dark) return "dure-dark";
	if (id === LEGACY_PRODUCT_COMPATIBILITY.builtinThemeIds.light) return "dure-light";
	return id;
}

/** Canonicalize persisted pre-rename ids without rewriting custom theme ids. */
export function normalizePersistedThemeScheme(
	value: unknown,
): UiPrefs["themeScheme"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const dark =
		typeof raw.dark === "string" ? canonicalThemeId(raw.dark) : undefined;
	const light =
		typeof raw.light === "string" ? canonicalThemeId(raw.light) : undefined;
	if (dark === undefined && light === undefined) return undefined;
	return {
		...(dark === undefined ? {} : { dark }),
		...(light === undefined ? {} : { light }),
	};
}

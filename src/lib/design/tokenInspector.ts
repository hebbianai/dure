// Token Inspector data and live-preview plumbing.
// The pane never imports engine code — it consumes the generated
// design-coverage.json (schemaVersion asserted; absence/staleness is a
// "regenerate now" affordance, never an error state).

import { hexToOklch, type Oklch, oklchToHex } from "@/lib/theme/oklch";

export const TOKEN_SNAPSHOT_RELATIVE_PATH = "design/.generated/design-coverage.json";
export const INSPECTOR_PREVIEW_STYLE_ID = "dure-token-inspector-preview";

export interface TokenRow {
	/** full custom-property name, `--` included */
	name: string;
	value: string;
	darkValue?: string;
	type: "color" | "dimension" | "other";
	/** engine scope attribution: root/dark = sub-ms live path, theme-inline = build-time */
	scopes: string[];
}

export type TokenSnapshot =
	| { ok: true; tokens: TokenRow[]; generatedAt: string; sourceCommit: string }
	| { ok: false; reason: "invalid-json" | "unsupported-schema" | "no-tokens" };

export function parseTokenSnapshot(jsonText: string): TokenSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return { ok: false, reason: "invalid-json" };
	}
	const envelope = parsed as {
		schemaVersion?: unknown;
		generatedAt?: unknown;
		sourceCommit?: unknown;
		tokensDtcg?: Record<string, { $value?: unknown; $type?: unknown; $extensions?: Record<string, unknown> }>;
	};
	// Both versions carry the same token payload; v2 retires screen prose metrics.
	if (envelope.schemaVersion !== 1 && envelope.schemaVersion !== 2) {
		return { ok: false, reason: "unsupported-schema" };
	}
	const entries = Object.entries(envelope.tokensDtcg ?? {});
	if (entries.length === 0) return { ok: false, reason: "no-tokens" };
	const tokens: TokenRow[] = entries
		.map(([bareName, entry]) => {
			const extensions = entry.$extensions ?? {};
			const scopes = Array.isArray(extensions["app.dure.scopes"])
				? (extensions["app.dure.scopes"] as string[])
				: [];
			const rawType = entry.$type;
			const type: TokenRow["type"] =
				rawType === "color" ? "color" : rawType === "dimension" ? "dimension" : "other";
			return {
				name: `--${bareName}`,
				value: typeof entry.$value === "string" ? entry.$value : "",
				...(typeof extensions["app.dure.dark"] === "string"
					? { darkValue: extensions["app.dure.dark"] as string }
					: {}),
				type,
				scopes,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	return {
		ok: true,
		tokens,
		generatedAt: String(envelope.generatedAt ?? ""),
		sourceCommit: String(envelope.sourceCommit ?? ""),
	};
}

/** A token is live-editable sub-ms when it has a runtime declaration scope. */
export const isRuntimeToken = (row: TokenRow) =>
	row.scopes.includes("root") || row.scopes.includes("dark");

/** Parse `#hex` or `oklch(l c h)` into slider space; null → text-input fallback
 *  (alpha forms and non-color values deliberately stay out of the sliders). */
export function parseSliderColor(value: string): Oklch | null {
	const trimmed = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return hexToOklch(trimmed);
	const match = trimmed.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i);
	if (!match) return null;
	return {
		l: Number.parseFloat(match[1]),
		c: Number.parseFloat(match[2]),
		h: Number.parseFloat(match[3]),
	};
}

export const formatOklch = ({ l, c, h }: Oklch) =>
	`oklch(${Number(l.toFixed(4))} ${Number(c.toFixed(4))} ${Number(h.toFixed(2))})`;

/** Gradient stops for a slider track, sweeping one OKLCH channel through the
 *  repo's own gamut-clamping converter so out-of-gamut regions visibly flatten. */
export function sliderTrackStops(base: Oklch, channel: "l" | "c" | "h", steps = 8): string[] {
	const max = channel === "l" ? 1 : channel === "c" ? 0.4 : 360;
	const stops: string[] = [];
	for (let i = 0; i <= steps; i++) {
		stops.push(oklchToHex({ ...base, [channel]: (max * i) / steps }));
	}
	return stops;
}

const sanitizeCssValue = (value: string) => value.replace(/[;{}]/g, "").trim();

/** Preview CSS for the CURRENT appearance: a dedicated style element appended
 *  after the managed theme override, so equal html:root specificity resolves
 *  by document order and the inspector wins while previewing. */
export function buildInspectorPreviewCss(edits: Record<string, string>): string {
	const declarations = Object.entries(edits)
		.filter(([name]) => /^--[\w-]+$/.test(name))
		.map(([name, value]) => `  ${name}: ${sanitizeCssValue(value)};`)
		.join("\n");
	return declarations ? `html:root {\n${declarations}\n}` : "";
}

/** Per-instance element id so two mounted panes (one per desktop deck) never
 *  fight over one node — each instance applies and cleans up only its own. */
export function applyInspectorPreview(
	doc: Document,
	css: string,
	elementId: string = INSPECTOR_PREVIEW_STYLE_ID,
): void {
	let el = doc.getElementById(elementId);
	if (!css) {
		el?.remove();
		return;
	}
	if (!el) {
		el = doc.createElement("style");
		el.id = elementId;
		doc.head.appendChild(el);
	} else {
		// Re-append: the managed theme override is (re)created on scheme
		// changes and appends itself — equal html:root specificity resolves by
		// document order, so the preview must reclaim the last slot.
		doc.head.appendChild(el);
	}
	if (el.textContent !== css) el.textContent = css;
}

/** The value the app is currently showing for this token — dark appearance
 *  reads the dark declaration when one exists. Editing must start here, not
 *  from the light value, or the first slider touch lurches the whole app. */
export function effectiveTokenValue(row: TokenRow, isDark: boolean): string {
	return isDark && row.darkValue !== undefined ? row.darkValue : row.value;
}

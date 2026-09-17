// The pane header band and the buttons sitting on it must hover the same way.
// The band is painted by dockview (--dv-tabs-and-actions-container-background-color
// = --glass-header) and its hover by a rule in index.css, while the buttons use
// the Tailwind utility for glass/tint-hover — two sources for one gesture. This
// contract keeps them pointing the same direction: whatever the app's hover tint
// does to a surface, the pane tab's hover must do to the band.
//
// Direction, not value: pinning a hex here would fail on any scheme change and
// still miss the actual regression, which is a hover that moves the surface the
// wrong way (var(--muted) lightened the light band and darkened the dark one,
// 2026-09-01).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToOklch } from "@/lib/theme/oklch";

const css = readFileSync("src/index.css", "utf8");

/** The last declaration of `name` before `limit`, i.e. the value that block wins with. */
function declaredBefore(name: string, limit: number): string {
	const matches = [
		...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g")),
	].filter((m) => (m.index ?? 0) < limit);
	// Index access, not Array.at — tsconfig pins lib to ES2020.
	const last = matches[matches.length - 1];
	if (!last) throw new Error(`${name} is not declared before offset ${limit}`);
	return last[1].trim();
}

const DARK_BLOCK = css.indexOf(".dark {");
const MODES = {
	light: { at: DARK_BLOCK },
	dark: { at: css.length },
} as const;

/** #rrggbbaa → the colour it composites to over `backdrop` (#rrggbb). */
function compositeOver(layer: string, backdrop: string): string {
	const alpha =
		layer.length === 9 ? Number.parseInt(layer.slice(7, 9), 16) / 255 : 1;
	const channel = (i: number) => {
		const src = Number.parseInt(layer.slice(1 + i * 2, 3 + i * 2), 16);
		const dst = Number.parseInt(backdrop.slice(1 + i * 2, 3 + i * 2), 16);
		return Math.round(src * alpha + dst * (1 - alpha));
	};
	return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

/** OKLCH lightness of a token value — either a hex literal or `oklch(L c h)`. */
function lightnessOf(value: string): number {
	const oklch = /^oklch\(\s*([\d.]+)/.exec(value);
	if (oklch) return Number.parseFloat(oklch[1]);
	return hexToOklch(value.slice(0, 7)).l;
}

const escapeSelector = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The background-color a pane-tab state rule paints. */
function tabStateValue(selector: string): string {
	const rule = css.match(
		new RegExp(`${escapeSelector(selector)}[^{]*\\{([^}]*)\\}`),
	);
	expect(rule, `${selector} rule is missing`).not.toBeNull();
	const declaration = /background-color:\s*([^;!]+)/.exec(rule?.[1] ?? "");
	expect(
		declaration,
		`${selector} declares no background-color`,
	).not.toBeNull();
	return (declaration?.[1] ?? "").trim();
}

/** `var(--x)` → `--x`, so the rule's token can be resolved per mode. */
const tokenName = (value: string) =>
	/^var\((--[\w-]+)\)$/.exec(value)?.[1] ?? null;

/** Pointer states the header band paints, in escalation order. */
const TAB_STATES = [
	".dockview-theme-abyss .dv-groupview .dv-tab:hover",
	".dockview-theme-abyss .dv-groupview .dv-tab:active",
] as const;

describe("pane header pointer-state contract", () => {
	it.each(TAB_STATES)(
		"%s moves the band the way the app's hover tint does",
		(selector) => {
			const value = tabStateValue(selector);
			const stateToken = tokenName(value);
			expect(
				stateToken,
				`${selector} must use a token, got ${value}`,
			).not.toBeNull();

			for (const [mode, { at }] of Object.entries(MODES)) {
				const band = declaredBefore("--glass-header", at);
				const tint = declaredBefore("--glass-tint-hover", at);
				const state = declaredBefore(stateToken as string, at);

				const rest = lightnessOf(band);
				// What the app's hover language does to this band, and what the pane
				// header actually does to it. The pane tab paints its value directly, so
				// a translucent token composites over the band the same way the utility
				// would.
				const reference = lightnessOf(compositeOver(tint, band));
				const actual = lightnessOf(
					state.startsWith("#") ? compositeOver(state, band) : state,
				);

				expect(
					Math.sign(actual - rest),
					`${mode}: ${state} moves the band ${band} the wrong way (app tint ${tint} goes the other direction)`,
				).toBe(Math.sign(reference - rest));
			}
		},
	);

	it("keeps the !important that beats dockview's own tab rule", () => {
		// dockview.css:2471 paints .dv-tab from its own six-class selector (0,6,0),
		// and index.css sets those tab-background tokens to transparent. Our rule is
		// (0,4,0), so without !important the hover paints nothing at all.
		for (const selector of TAB_STATES) {
			const rule = css.match(
				new RegExp(`${escapeSelector(selector)}[^{]*\\{([^}]*)\\}`),
			);
			expect(rule?.[1], `${selector} rule is missing`).toBeDefined();
			expect(rule?.[1]).toMatch(/background-color:[^;]*!important/);
		}
	});
});

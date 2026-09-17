// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	applyInspectorPreview,
	buildInspectorPreviewCss,
	effectiveTokenValue,
	formatOklch,
	INSPECTOR_PREVIEW_STYLE_ID,
	isRuntimeToken,
	parseSliderColor,
	parseTokenSnapshot,
	sliderTrackStops,
} from "./tokenInspector";

const envelope = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		schemaVersion: 1,
		generatedAt: "2026-08-06T00:00:00.000Z",
		sourceCommit: "abc123",
		tokensDtcg: {
			background: {
				$value: "oklch(1 0 0)",
				$type: "color",
				$extensions: { "app.dure.scopes": ["dark", "root"], "app.dure.dark": "oklch(0.145 0 0)" },
			},
			"text-xs": {
				$value: "0.8125rem",
				$type: "dimension",
				$extensions: { "app.dure.scopes": ["theme-inline"] },
			},
		},
		...overrides,
	});

describe("parseTokenSnapshot", () => {
	it("reads legacy and source-inventory snapshots with identical tokens", () => {
		expect(parseTokenSnapshot(envelope({ schemaVersion: 2, surfaces: [], mockups: [] }))).toEqual(
			parseTokenSnapshot(envelope()),
		);
	});

	it("parses tokens with scopes and dark values", () => {
		const snapshot = parseTokenSnapshot(envelope());
		if (!snapshot.ok) throw new Error("expected ok");
		expect(snapshot.tokens).toHaveLength(2);
		const background = snapshot.tokens.find((t) => t.name === "--background");
		expect(background?.darkValue).toBe("oklch(0.145 0 0)");
		expect(background && isRuntimeToken(background)).toBe(true);
		const textXs = snapshot.tokens.find((t) => t.name === "--text-xs");
		expect(textXs && isRuntimeToken(textXs)).toBe(false);
	});

	it("asserts the schema version instead of shape-sniffing", () => {
		expect(parseTokenSnapshot(envelope({ schemaVersion: 3 }))).toEqual({
			ok: false,
			reason: "unsupported-schema",
		});
		expect(parseTokenSnapshot("not json")).toEqual({ ok: false, reason: "invalid-json" });
		expect(parseTokenSnapshot(envelope({ tokensDtcg: {} }))).toEqual({
			ok: false,
			reason: "no-tokens",
		});
	});
});

describe("slider color plumbing", () => {
	it("parses hex and plain oklch, rejects alpha forms", () => {
		expect(parseSliderColor("#15803d")).not.toBeNull();
		expect(parseSliderColor("oklch(0.52 0.13 150)")).toEqual({ l: 0.52, c: 0.13, h: 150 });
		expect(parseSliderColor("oklch(1 0 0 / 10%)")).toBeNull();
		expect(parseSliderColor("0.8125rem")).toBeNull();
	});

	it("formats round-trippable oklch", () => {
		expect(parseSliderColor(formatOklch({ l: 0.52, c: 0.13, h: 150 }))).toEqual({
			l: 0.52,
			c: 0.13,
			h: 150,
		});
	});

	it("produces gamut-clamped hex stops for track gradients", () => {
		const stops = sliderTrackStops({ l: 0.6, c: 0.3, h: 150 }, "l", 4);
		expect(stops).toHaveLength(5);
		for (const stop of stops) expect(stop).toMatch(/^#[0-9a-f]{6}$/i);
	});
});

describe("preview injection", () => {
	it("builds sanitized css and applies it as the LAST head style", () => {
		const css = buildInspectorPreviewCss({ "--background": "oklch(0.9 0 0); } html{", "not-a-token": "x" });
		expect(css).toContain("--background: oklch(0.9 0 0)  html");
		expect(css).not.toContain(";}");
		expect(css).not.toContain("not-a-token");

		document.head.innerHTML = `<style id="hebbian-theme-overrides">html:root{--background:#111}</style>`;
		applyInspectorPreview(document, css);
		const el = document.getElementById(INSPECTOR_PREVIEW_STYLE_ID);
		expect(el?.textContent).toBe(css);
		expect(document.head.lastElementChild?.id).toBe(INSPECTOR_PREVIEW_STYLE_ID);

		applyInspectorPreview(document, "");
		expect(document.getElementById(INSPECTOR_PREVIEW_STYLE_ID)).toBeNull();
	});

	it("keeps per-instance elements independent", () => {
		document.head.innerHTML = "";
		applyInspectorPreview(document, "html:root{--a:1}", "preview-a");
		applyInspectorPreview(document, "html:root{--b:2}", "preview-b");
		applyInspectorPreview(document, "", "preview-b");
		expect(document.getElementById("preview-a")?.textContent).toContain("--a");
		expect(document.getElementById("preview-b")).toBeNull();
	});
});

describe("effectiveTokenValue", () => {
	it("reads the dark declaration in dark appearance, falling back to light", () => {
		const row = {
			name: "--background",
			value: "oklch(1 0 0)",
			darkValue: "oklch(0.145 0 0)",
			type: "color" as const,
			scopes: ["root", "dark"],
		};
		expect(effectiveTokenValue(row, true)).toBe("oklch(0.145 0 0)");
		expect(effectiveTokenValue(row, false)).toBe("oklch(1 0 0)");
		expect(effectiveTokenValue({ ...row, darkValue: undefined }, true)).toBe("oklch(1 0 0)");
	});
});

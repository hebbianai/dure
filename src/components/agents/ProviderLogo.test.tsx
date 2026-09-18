// @vitest-environment jsdom
// Provider logos stay grayscale across glyphs, badge surfaces and caller
// overrides. Each rendering path needs coverage because changing one does not
// remove brand tint from the others.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ProviderBadge, ProviderGlyph } from "@/components/agents/ProviderLogo";
import { PROVIDER_IDS } from "@/lib/agents/providers";

/** Classes that apply a provider-specific brand tint. */
const BRAND = /agent-(claude|codex|kimi)-(icon|fill)/;

afterEach(cleanup);

describe("grayscale provider icons", () => {
	it("renders Pi as a shared inline glyph without its background tile", () => {
		const { container } = render(<ProviderGlyph provider="pi" />);
		expect(container.querySelector("img")).toBeNull();
		const glyph = container.querySelector("svg");
		expect(glyph).toBeTruthy();
		expect(glyph?.querySelector("rect")).toBeNull();
		expect(glyph?.getAttribute("class") ?? "").toContain(
			"text-muted-foreground",
		);
	});

	it("does not apply brand color classes to glyphs", () => {
		for (const provider of PROVIDER_IDS) {
			const { container } = render(<ProviderGlyph provider={provider} />);
			const glyph = container.querySelector("svg, img");
			expect(glyph, provider).toBeTruthy();
			expect(glyph?.getAttribute("class") ?? "", provider).not.toMatch(BRAND);
			cleanup();
		}
	});

	// Badge surfaces can retain tint independently of their glyphs.
	it("does not apply brand tint to badge borders or backgrounds", () => {
		for (const provider of PROVIDER_IDS) {
			const { container } = render(<ProviderBadge provider={provider} />);
			const box = container.firstElementChild;
			expect(box, provider).toBeTruthy();
			expect(box?.getAttribute("class") ?? "", provider).not.toMatch(BRAND);
			cleanup();
		}
	});

	// Hardcoded SVG paint would survive changes to the surrounding classes.
	it("uses currentColor instead of hardcoded inline SVG paint", () => {
		for (const provider of PROVIDER_IDS) {
			const { container } = render(<ProviderGlyph provider={provider} />);
			for (const el of container.querySelectorAll("svg *, svg")) {
				for (const attr of ["fill", "stroke"]) {
					const value = el.getAttribute(attr);
					if (value === null) continue;
					expect(["currentColor", "none"], `${provider} ${el.tagName}[${attr}]`).toContain(
						value,
					);
				}
			}
			cleanup();
		}
	});

	// Every provider uses the same muted foreground tone.
	it("uses the muted foreground tone for painted glyphs", () => {
		for (const provider of PROVIDER_IDS) {
			const { container } = render(<ProviderGlyph provider={provider} />);
			const svg = container.querySelector("svg");
			if (svg) expect(svg.getAttribute("class") ?? "", provider).toContain("text-muted-foreground");
			cleanup();
		}
	});
});

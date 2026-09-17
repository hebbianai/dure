// The default dark terminal paints the pane surface, not the derivation anchor.
//
// terminal.background carries two different facts in this codebase: what the
// terminal actually paints, and the t=0 anchor every UI surface derives from
// (resolveTheme SURFACE_CURVE). Figma 2355:50233 says those are different
// values for our own theme — the terminal body sits on glass/pane #242424,
// while the app's darkest anchor is #0a0a0a. The proof that #0a0a0a is the
// anchor is that the curve reproduces the design's measured values from it.
//
// Collapsing the two (2026-09-01, reverted a day later) painted the terminal
// near-black, which is the anchor, not any surface the design draws.
import { describe, expect, it } from "vitest";
import { hexToOklch, mixOklch, oklchToHex } from "@/lib/theme/oklch";
import { resolveTheme } from "@/lib/theme/resolveTheme";
import { DARK_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import { themeById } from "@/lib/theme/themeRegistry";

/** Figma 2355:50233 variable measurement (get_variable_defs, 2026-09-02). */
const FIGMA = {
	pane: "#242424", // glass/pane — the terminal body's surface
	// glass/header — the pane header band. Below the body since 2026-09-09
	// (was #2e2e2e, equal to the seam); the Figma variable follows.
	header: "#1a1a1a",
} as const;

const DARK_ANCHOR = "#0a0a0a";

describe("default dark terminal surface", () => {
	it("paints the design's glass/pane, not the derivation anchor", () => {
		expect(DARK_TERMINAL_PALETTE.background).toBe(FIGMA.pane);
	});

	it("keeps the anchor that reproduces the design's surfaces", () => {
		// If this drifts, every derived surface moves with it — the anchor is
		// load-bearing for the whole dark palette, which is exactly why it must
		// not be conflated with what the terminal paints.
		const dureDark = themeById("dure-dark");
		expect(dureDark).toBeDefined();
		const resolved = resolveTheme(dureDark as NonNullable<typeof dureDark>);
		expect(resolved.ui.background).toBe(DARK_ANCHOR);
		expect(resolved.ui["glass-pane"]).toBe(FIGMA.pane);
		expect(resolved.ui["glass-header"]).toBe(FIGMA.header);
	});

	it("derives the design's surfaces from that anchor", () => {
		// The measurement behind the anchor: the curve's own stops land on the
		// Figma values when seeded with #0a0a0a. Independent of resolveTheme's
		// wiring, so it still says why #0a0a0a is the right anchor if the
		// derivation is ever restructured.
		const bg = hexToOklch(DARK_ANCHOR);
		const fg = hexToOklch(DARK_TERMINAL_PALETTE.foreground);
		const step = (t: number) => oklchToHex(mixOklch(bg, fg, t));
		expect(step(0.146)).toBe(FIGMA.pane);
		// The band sits below the pane stop (0.146) since 2026-09-09.
		expect(step(0.093)).toBe(FIGMA.header);
	});

	it("lets a colour scheme move the terminal with the app", () => {
		// The behaviour the anchor split must not cost: picking a scheme moves
		// the terminal to that scheme's own background, because a scheme author
		// meant that value (it is also what OSC 11 answers).
		const macchiato = themeById("catppuccin-macchiato");
		expect(macchiato?.terminal.background).toBe("#24273a");
		const resolved = resolveTheme(macchiato as NonNullable<typeof macchiato>);
		expect(resolved.ui.background).toBe("#24273a");
	});
});

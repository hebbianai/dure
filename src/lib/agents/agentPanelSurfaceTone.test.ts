import { describe, expect, it } from "vitest";

import { agentPanelSecondaryBarTone } from "@/lib/agents/agentPanelSurfaceTone";

describe("agentPanelSecondaryBarTone", () => {
	it("joins an hmux bar to the canonical terminal background without a seam", () => {
		const tone = agentPanelSecondaryBarTone(true);
		// The colour the canvas paints, not the app floor: those were the same
		// value until the default terminal moved onto glass/pane (2026-09-01),
		// and they still differ for any scheme.
		expect(tone).toContain("bg-surface-terminal");
		expect(tone).toContain("border-transparent");
		expect(tone).not.toContain("bg-glass-pane");
		expect(tone).not.toContain("bg-background");
	});

	it("keeps legacy agent chrome on the pane surface", () => {
		const tone = agentPanelSecondaryBarTone(false);
		expect(tone).toContain("bg-glass-pane");
		expect(tone).toContain("border-border/60");
	});
});

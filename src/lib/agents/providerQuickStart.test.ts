import { describe, expect, it } from "vitest";
import { quickStartProviders } from "@/lib/agents/providerQuickStart";

// The shape availableProviders() produces: catalog order, core first because
// the three core providers are the first three catalog keys, then whatever
// else the PATH probe found.
const AVAILABLE = ["claude", "codex", "kimi", "gemini", "cursor"] as const;

describe("quickStartProviders", () => {
	/** The bug this function exists for: an uninstalled core provider must not
	 *  take a button from one the user actually has. */
	it("puts installed providers ahead of core-but-absent ones", () => {
		expect(quickStartProviders(AVAILABLE, ["claude", "gemini"], 3)).toEqual([
			"claude",
			"gemini",
			"codex",
		]);
	});

	it("keeps catalog order inside each group", () => {
		expect(
			quickStartProviders(AVAILABLE, ["cursor", "gemini", "codex"], 3),
		).toEqual(["codex", "gemini", "cursor"]);
	});

	/** Before the PATH probe resolves, installedAgents is empty — the row still
	 *  renders, in the plain catalog order, and settles once detection lands. */
	it("falls back to the available order when nothing is detected yet", () => {
		expect(quickStartProviders(AVAILABLE, [], 3)).toEqual([
			"claude",
			"codex",
			"kimi",
		]);
	});

	it("never returns a provider the menu would not list", () => {
		expect(quickStartProviders(["claude"], ["gemini", "cursor"], 3)).toEqual([
			"claude",
		]);
	});

	it("returns nothing when no button fits", () => {
		expect(quickStartProviders(AVAILABLE, ["claude"], 0)).toEqual([]);
	});
});

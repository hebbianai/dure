import { describe, expect, it } from "vitest";
import {
	agentDisplayName,
	normalizeAgentDisplayName,
} from "@/lib/agents/agentDisplayName";

describe("agentDisplayName", () => {
	it("keeps the immutable launch name separate from the user-visible label", () => {
		expect(agentDisplayName({ name: "codex-1", displayName: "릴리스 점검" })).toBe(
			"릴리스 점검",
		);
		expect(agentDisplayName({ name: "codex-1" })).toBe("codex-1");
	});

	it("treats blank and canonical values as clearing the override", () => {
		expect(normalizeAgentDisplayName("codex-1", "  ")).toBeUndefined();
		expect(normalizeAgentDisplayName("codex-1", " codex-1 ")).toBeUndefined();
		expect(normalizeAgentDisplayName("codex-1", " QA ")).toBe("QA");
	});
});

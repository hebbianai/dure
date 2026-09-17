import { describe, expect, it } from "vitest";
import {
	canonicalAgentNameCandidate,
	supportsCanonicalAgentName,
	uniqueAgentName,
} from "@/lib/agents/agentName";

describe("canonical Agent names", () => {
	it("normalizes display text once at the identity boundary", () => {
		expect(canonicalAgentNameCandidate("  Feature/Fix Login. ")).toBe(
			"feature-fix-login",
		);
	});

	it("caps names and preserves canonical boundaries", () => {
		const name = canonicalAgentNameCandidate(`${"a".repeat(80)}-`);
		expect(name).toBe("a".repeat(64));
		expect(supportsCanonicalAgentName(name ?? "")).toBe(true);
	});

	it("keeps collision suffixes within the canonical identity", () => {
		const base = "a".repeat(64);
		const name = uniqueAgentName(base, [base]);
		expect(name.endsWith("-2")).toBe(true);
		expect(supportsCanonicalAgentName(name)).toBe(true);
	});
});

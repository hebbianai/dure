import { describe, expect, it } from "vitest";
import {
	PROVIDER_IDS,
	PROVIDERS,
	providersForInterfaceMode,
} from "@/lib/agents/providerCatalog";

describe("provider catalog runtime boundary", () => {
	it("does not carry terminal-text presentation or identity inference", () => {
		for (const specification of Object.values(PROVIDERS)) {
			expect(specification).not.toHaveProperty("detect");
			expect(specification).not.toHaveProperty("terminalScreenProjection");
			expect(specification).not.toHaveProperty("runtimeInterruptions");
		}
	});
});

it("requires explicit Basic approval independently of core and runtime support", () => {
	const original = PROVIDERS.gemini;
	try {
		PROVIDERS.gemini = { ...original, core: true, structuredChat: true };
		expect(providersForInterfaceMode("basic")).not.toContain("gemini");
		expect(providersForInterfaceMode("pro")).toEqual(PROVIDER_IDS);
		PROVIDERS.gemini = { ...original, basic: true };
		expect(providersForInterfaceMode("basic")).toContain("gemini");
	} finally {
		PROVIDERS.gemini = original;
	}
});

it("keeps Qwen experimental while exposing exact resume without account overlays", () => {
	expect(providersForInterfaceMode("pro")).toContain("qwen-code");
	expect(providersForInterfaceMode("basic")).not.toContain("qwen-code");
	expect(PROVIDERS["qwen-code"].resumeId?.("session-1")).toBe(
		"qwen --resume session-1",
	);
	expect(PROVIDERS["qwen-code"].configEnv).toBeUndefined();
});

import { describe, expect, it } from "vitest";
import { resolveDefaultProvider } from "@/lib/agents/defaultProvider";

describe("resolveDefaultProvider", () => {
	it("returns the preferred provider when it is available", () => {
		expect(resolveDefaultProvider("codex", ["claude", "codex", "kimi"])).toBe("codex");
	});
	it("falls back to the first available provider when unset (Auto)", () => {
		expect(resolveDefaultProvider(undefined, ["claude", "codex"])).toBe("claude");
	});
	it("ignores a stored preference for a provider that is no longer available", () => {
		// A persisted pref can outlive an uninstall; it must not leak through.
		expect(resolveDefaultProvider("gemini", ["claude", "codex"])).toBe("claude");
	});
});

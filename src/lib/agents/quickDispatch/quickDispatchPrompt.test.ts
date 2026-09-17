import { describe, expect, it } from "vitest";
import {
	MAX_QUICK_DISPATCH_PROMPT_BYTES,
	buildQuickDispatchPrompt,
	quickDispatchPromptByteLength,
} from "@/lib/agents/quickDispatch/quickDispatchPrompt";

describe("buildQuickDispatchPrompt", () => {
	it("returns trimmed text when there are no attachments", () => {
		expect(buildQuickDispatchPrompt("  fix it \n", [])).toBe("fix it");
	});
	it("appends one read instruction per attachment path", () => {
		const prompt = buildQuickDispatchPrompt("fix it", ["/a/1.png", "/a/2.png"]);
		expect(prompt).toContain("fix it");
		expect(prompt).toContain("/a/1.png");
		expect(prompt).toContain("/a/2.png");
		expect(prompt.indexOf("fix it")).toBeLessThan(prompt.indexOf("/a/1.png"));
	});
	it("measures bytes, not code units", () => {
		expect(quickDispatchPromptByteLength("한")).toBe(3);
		expect(MAX_QUICK_DISPATCH_PROMPT_BYTES).toBe(16 * 1024);
	});
});

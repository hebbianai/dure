import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function fixture(name) {
	return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("fake provider screen models", () => {
	it("keeps Codex on the normal buffer and Claude on the alternate buffer", async () => {
		const [codex, claude] = await Promise.all([
			fixture("codex"),
			fixture("claude"),
		]);

		expect(codex).not.toContain("\\x1b[?1049h");
		expect(codex).not.toContain("\\x1b[?1049l");
		expect(claude).toContain("\\x1b[?1049h");
		expect(claude).toContain("\\x1b[?1049l");
	});
});

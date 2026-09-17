import { describe, expect, it } from "vitest";
import { requireTerminalProviderFixture } from "./terminalProviderFixture";

describe("requireTerminalProviderFixture", () => {
	it.each(["claude", "codex"] as const)(
		"accepts the %s fixture",
		(provider) => {
			expect(requireTerminalProviderFixture(provider)).toBe(provider);
		},
	);

	it.each([undefined, "kimi", "unknown"])("rejects %s", (provider) => {
		expect(() => requireTerminalProviderFixture(provider)).toThrow(
			"large-view QA requires a configured provider fixture",
		);
	});
});

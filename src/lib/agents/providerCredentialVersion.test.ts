import { describe, expect, it } from "vitest";
import {
	assertCredentialOverlayVersion,
	ProviderCredentialVersionUnsupportedError,
} from "@/lib/agents/providerCredentials";

describe("provider credential overlay version policy", () => {
	it.each([
		"2.1.212 (Claude Code)",
		"2.1.213",
		"2.2.0 (Claude Code)",
		"3.0.0",
	])("accepts Claude versions with the reviewed scoped-keychain contract: %s", (version) => {
		expect(() =>
			assertCredentialOverlayVersion("claude", version),
		).not.toThrow();
	});

	it.each(["2.1.211 (Claude Code)", "2.0.99", "1.99.999", undefined, "dev"])(
		"rejects an older or unparseable Claude fixture without guessing: %s",
		(version) => {
			expect(() =>
				assertCredentialOverlayVersion("claude", version),
			).toThrowError(ProviderCredentialVersionUnsupportedError);
		},
	);

	it("does not impose Claude's Keychain policy on other providers", () => {
		expect(() =>
			assertCredentialOverlayVersion("codex", undefined),
		).not.toThrow();
	});
});

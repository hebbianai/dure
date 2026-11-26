import { describe, expect, it } from "vitest";
import type { AccountProfile } from "@/types";
import { accountUsageProfiles } from "./accountUsageProfiles";

describe("accountUsageProfiles", () => {
	it("includes each checked provider's default and registered profiles", () => {
		const accounts: AccountProfile[] = [
			{ id: "cx", name: "Codex", provider: "codex", dir: "/profiles/cx" },
			{ id: "cl", name: "Claude", provider: "claude", dir: "/profiles/cl" },
			{ id: "gm", name: "Gemini", provider: "gemini", dir: "/profiles/gm" },
		];
		expect(accountUsageProfiles(accounts)).toEqual([
			{ providerId: "codex", credentialId: null, directory: null },
			{ providerId: "codex", credentialId: "cx", directory: "/profiles/cx" },
			{ providerId: "claude", credentialId: null, directory: null },
			{ providerId: "claude", credentialId: "cl", directory: "/profiles/cl" },
		]);
	});
});

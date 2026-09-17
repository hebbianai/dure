import { afterEach, describe, expect, it, vi } from "vitest";
import { worktreeReleaseProfile } from "./worktreeReleaseProfile";

const profile = {
	sourceChannel: "dev-task-0123456789",
	targetChannel: "release-task-0123456789",
	identifier: "io.hebbian.ade.release.0123456789",
	dataStoreIdentifier: Array(16).fill(42),
};
afterEach(() => vi.unstubAllEnvs());

describe("worktree release profile", () => {
	it("adds no override to normal builds", () => {
		vi.stubEnv("VITE_DURE_WORKTREE_RELEASE_PROFILE", undefined);
		expect(worktreeReleaseProfile()).toBeUndefined();
	});
	it("retains the build profile used by presentation import and update policy", () => {
		vi.stubEnv("VITE_DURE_WORKTREE_RELEASE_PROFILE", JSON.stringify(profile));
		expect(worktreeReleaseProfile()).toEqual(profile);
	});
	it("rejects conflicting channels, stable bundle identity and invalid bytes", () => {
		for (const invalid of [
			{ ...profile, targetChannel: "stable" },
			{ ...profile, identifier: "io.hebbian.ade" },
			{ ...profile, identifier: "io.hebbian.ade.release.aaaaaaaaaa" },
			{ ...profile, dataStoreIdentifier: [42] },
			{ ...profile, dataStoreIdentifier: Array(16).fill(256) },
		]) {
			vi.stubEnv("VITE_DURE_WORKTREE_RELEASE_PROFILE", JSON.stringify(invalid));
			expect(() => worktreeReleaseProfile()).toThrow("profile_invalid");
		}
	});
});

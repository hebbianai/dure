import { expect, it } from "vitest";
import { parseBrowserProfiles } from "./browserProfileContract";

const profile = {
	profileId: "profile:one",
	label: "한글 profile",
	scope: "isolated",
	userAgentMode: "native",
};

it("preserves saved policy and lifecycle state without claiming a running page", () => {
	const rows = ["active", "retiring", "deleted"].map((state) => ({
		profile: { ...profile, profileId: `profile:${state}` },
		state,
	}));
	expect(parseBrowserProfiles({ profiles: rows })).toEqual(rows);
	expect(
		parseBrowserProfiles({
			profiles: [
				{
					profile: { ...profile, profileId: "default", scope: "default" },
					state: "active",
				},
			],
		}),
	).toHaveLength(1);
});

it.each([
	{ ...profile, profileId: "invalid id" },
	{ ...profile, profileId: "default" },
	{ ...profile, scope: "default" },
	{ ...profile, scope: {} },
	{ ...profile, userAgentMode: {} },
	{ ...profile, userAgentMode: "unknown" },
	{ ...profile, label: "" },
	{ ...profile, label: "가".repeat(171) },
	{ ...profile, label: "before\u0085after" },
])("rejects malformed saved profile %j", (value) => {
	expect(
		parseBrowserProfiles({ profiles: [{ profile: value, state: "active" }] }),
	).toBeUndefined();
});

it("rejects duplicate identities and unknown lifecycle values", () => {
	const row = { profile, state: "active" };
	expect(parseBrowserProfiles({ profiles: [row, row] })).toBeUndefined();
	expect(
		parseBrowserProfiles({ profiles: [{ ...row, state: "running" }] }),
	).toBeUndefined();
	expect(parseBrowserProfiles({ profiles: null })).toBeUndefined();
});

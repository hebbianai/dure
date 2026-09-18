import { describe, expect, it } from "vitest";
import {
	parseRecoveryObservation,
	parseRecoveryPolicy,
} from "./accountRecoveryContract";

const account = {
	profile: {
		schemaVersion: 1,
		providerId: "codex",
		referenceId: "team",
		credentialGeneration: "generation-1",
	},
	name: "Team",
};
const observation = {
	attemptId: "recovery-1",
	failureItemId: "failure-1",
	target: account,
	stopped: null,
	turnState: "accepted",
	createdAtMs: 100,
};

describe("backend account recovery wire contract", () => {
	it.each([null, "prepared", "accepted", "uncertain", "failed"])(
		"retains the exact %s send outcome",
		(turnState) => {
			const value = { ...observation, turnState };
			expect(parseRecoveryObservation(value)).toEqual(value);
		},
	);
	it.each([
		{ kind: "exhausted" },
		{ kind: "superseded" },
		{ kind: "failed", code: "credential_profile_unavailable" },
	])(
		"preserves a stopped outcome without private runtime details",
		(stopped) => {
			const value = { ...observation, target: null, turnState: null, stopped };
			expect(parseRecoveryObservation(value)).toEqual(value);
		},
	);
	it.each([
		{ turnState: "retrying" },
		{ stopped: { kind: "failed" } },
		{ target: { ...account, credentialPath: "/private/account" } },
		{ runtime: {} },
		{ failureItemId: "" },
		{ createdAtMs: -1 },
	])("rejects malformed or unsupported recovery fields %j", (change) => {
		expect(
			parseRecoveryObservation({ ...observation, ...change }),
		).toBeUndefined();
	});
	it("rejects a policy with an account from a different provider", () => {
		expect(
			parseRecoveryPolicy({
				schemaVersion: 1,
				providerId: "claude",
				revision: 1,
				enabled: true,
				accounts: [account],
				activatedAtMs: 100,
				updatedAtMs: 100,
			}),
		).toBeUndefined();
	});
});

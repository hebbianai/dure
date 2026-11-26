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
	it("keeps when the same account continues after its reset", () => {
		const waiting = {
			...observation,
			target: null,
			turnState: null,
			resumeAtMs: 200,
		};
		expect(parseRecoveryObservation(waiting)).toEqual(waiting);
		// A switch has no reset to wait for; a time must be one.
		expect(
			parseRecoveryObservation({ ...observation, resumeAtMs: 200 }),
		).toBeUndefined();
		expect(
			parseRecoveryObservation({ ...waiting, resumeAtMs: -1 }),
		).toBeUndefined();
	});
	it("reads continuing after a reset, absent as off", () => {
		const policy = {
			schemaVersion: 1,
			providerId: "codex",
			revision: 1,
			enabled: false,
			accounts: [],
			activatedAtMs: 100,
			updatedAtMs: 100,
		};
		expect(parseRecoveryPolicy(policy)?.continueAfterReset).toBe(false);
		expect(
			parseRecoveryPolicy({ ...policy, continueAfterReset: true })
				?.continueAfterReset,
		).toBe(true);
		expect(
			parseRecoveryPolicy({ ...policy, continueAfterReset: "yes" }),
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

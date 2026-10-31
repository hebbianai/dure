import { describe, expect, it } from "vitest";
import type { UsageRecentReport } from "@/lib/ipc";
import type { AccountProfile, Agent } from "@/types";
import {
	sessionAccountChoices,
	sessionAccountSummary,
	sessionAccountSwitchable,
	sessionAccountUsageObservable,
} from "./sessionAccount";

const accounts: AccountProfile[] = [
	{
		id: "acct-work",
		provider: "claude",
		name: "Work",
		dir: "/profiles/claude-work",
	},
	{
		id: "acct-spare",
		provider: "claude",
		name: "Spare",
		dir: "/profiles/claude-spare",
	},
	{
		id: "acct-codex",
		provider: "codex",
		name: "Codex",
		dir: "/profiles/codex",
	},
];

function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "agent-1",
		provider: "claude",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: "hmux-1",
			workspaceId: "ws-1",
			credentialId: "acct-work",
		},
		...overrides,
	} as Agent;
}

const nowSec = 1_000;
const report = {
	claudeAccounts: [
		{
			profileKey: "claude-work",
			usedPercent: 100,
			usedPercentWeekly: 40,
			resetsAt: nowSec + 5_400,
			weeklyResetsAt: null,
			usedPercentCapturedAt: nowSec,
		},
	],
} as unknown as UsageRecentReport;

describe("sessionAccountSummary", () => {
	it("names the account the selector shows, and nothing for the default", () => {
		expect(sessionAccountSummary(agent(), accounts)).toEqual({ label: "Work" });
		expect(
			sessionAccountSummary(
				agent({
					executionProfile: { kind: "provider_default" },
				} as Partial<Agent>),
				accounts,
			),
		).toEqual({});
	});

	it("carries a queued switch, including one back to the default", () => {
		const queued = (targetCredentialId: string | null) =>
			agent({
				pendingCredentialSwitch: {
					targetCredentialId,
					sourceCredentialId: "acct-work",
				},
			} as Partial<Agent>);
		expect(sessionAccountSummary(queued("acct-spare"), accounts)).toEqual({
			label: "Work",
			pending: { label: "Spare" },
		});
		expect(sessionAccountSummary(queued(null), accounts)).toEqual({
			label: "Work",
			pending: {},
		});
	});

	it("does not call a queued launch-settings change an account switch", () => {
		const settingsOnly = agent({
			pendingCredentialSwitch: {
				targetCredentialId: "acct-work",
				sourceCredentialId: "acct-work",
				targetLaunchSelection: {},
			},
		} as Partial<Agent>);
		expect(sessionAccountSummary(settingsOnly, accounts)).toEqual({
			label: "Work",
		});
	});

	/** Absent is the capability: the phone offers no switch the transition would refuse. */
	it("is absent where the selector's transition cannot run", () => {
		expect(sessionAccountSwitchable(agent())).toBe(true);
		const unsupported = agent({
			provider: "gemini",
			runtimeBinding: undefined,
		});
		expect(sessionAccountSwitchable(unsupported)).toBe(false);
		expect(sessionAccountSummary(unsupported, accounts)).toBeUndefined();
	});
});

describe("sessionAccountChoices", () => {
	it("lists the default and the provider's pool with the selector's usage", () => {
		expect(sessionAccountChoices(agent(), accounts, report, nowSec)).toEqual([
			{ accountId: null, current: false, pending: false },
			{
				accountId: "acct-work",
				label: "Work",
				current: true,
				pending: false,
				usage: { usedPercent: 100, window: "five_hour", resetsIn: "1h 30m" },
			},
			{
				accountId: "acct-spare",
				label: "Spare",
				current: false,
				pending: false,
			},
		]);
	});

	it("never sends a profile directory", () => {
		const wire = JSON.stringify(
			sessionAccountChoices(agent(), accounts, report, nowSec),
		);
		expect(wire).not.toContain("/profiles/");
	});

	it("reads no usage for a session on another host", () => {
		const remote = agent({
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "host-1",
				sessionId: "hmux-1",
				workspaceId: "ws-1",
				createIdempotencyKey: "create-1",
			},
		} as Partial<Agent>);
		expect(sessionAccountUsageObservable(remote)).toBe(false);
		expect(sessionAccountUsageObservable(agent())).toBe(true);
	});
});

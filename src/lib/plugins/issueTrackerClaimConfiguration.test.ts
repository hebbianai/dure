import { describe, expect, it } from "vitest";
import {
	isIssueTrackerPermissionEnabled,
	resolveIssueTrackerClaimConfiguration,
} from "./issueTrackerClaimConfiguration";

type Input = Parameters<typeof resolveIssueTrackerClaimConfiguration>[0];

function input(): Input {
	return {
		pluginId: "example.tracker",
		viewContributionId: "example.views",
		viewId: "claims",
		contributionId: "example.issues",
		workspace: {
			root: "/work/project",
			projectId: "project",
			scopeKey: "local:project",
			watchKey: "local:project",
			source: "local",
		},
		settingsTarget: null,
		claims: {
			settingKey: "show_claims",
			statuses: ["working"],
			defaultVisible: true,
		},
		operations: ["list", "watch"],
		intervalSeconds: 30,
		configuration: {
			permission: { enabled: true, plan_comparison: "matches_reviewed_plan" },
			activation: "active",
			settings: {
				values: {},
				agent_claim_policy_epochs: { "example.issues": 17 },
			},
			settingsLoaded: true,
			settingsError: null,
		},
	};
}

describe("issue tracker claim configuration", () => {
	it("projects the exact native policy epoch and provider-declared read settings", () => {
		const source = input();
		expect(resolveIssueTrackerClaimConfiguration(source)).toEqual({
			kind: "ready",
			input: {
				pluginId: "example.tracker",
				viewContributionId: "example.views",
				viewId: "claims",
				contributionId: "example.issues",
				workspace: source.workspace,
				statuses: ["working"],
				watchEnabled: true,
				intervalSeconds: 30,
				agentClaimPolicyEpoch: 17,
			},
		});
	});

	it("does not invent claims or watch capability for another provider", () => {
		const source = input();
		source.claims = undefined;
		expect(resolveIssueTrackerClaimConfiguration(source)).toEqual({
			kind: "hidden",
		});
		source.claims = input().claims;
		source.operations = ["list"];
		expect(resolveIssueTrackerClaimConfiguration(source)).toMatchObject({
			kind: "ready",
			input: { watchEnabled: false },
		});
	});

	it.each([false, true])(
		"workspace visibility %s overrides the declaration",
		(visible) => {
			const source = input();
			source.configuration.settings = {
				values: { show_claims: visible },
				agent_claim_policy_epochs: { "example.issues": 17 },
			};
			source.claims = {
				settingKey: "show_claims",
				statuses: ["working"],
				defaultVisible: !visible,
			};
			expect(resolveIssueTrackerClaimConfiguration(source).kind).toBe(
				visible ? "ready" : "hidden",
			);
		},
	);

	it("waits for settings instead of using defaults during a pending read", () => {
		const source = input();
		source.configuration.settingsLoaded = false;
		expect(resolveIssueTrackerClaimConfiguration(source)).toEqual({
			kind: "hidden",
		});
	});

	it("retains the visible section but gives it no query after settings failure", () => {
		const source = input();
		source.configuration.settingsError = "permission_revoked";
		expect(resolveIssueTrackerClaimConfiguration(source)).toEqual({
			kind: "unavailable",
			reason: "settings",
		});
	});

	it("does not borrow another contribution's claim policy epoch", () => {
		const source = input();
		source.configuration.settings = {
			values: {},
			agent_claim_policy_epochs: { "different.issues": 99 },
		};
		expect(resolveIssueTrackerClaimConfiguration(source)).toEqual({
			kind: "unavailable",
			reason: "policy_epoch",
		});
	});

	it.each(["checking", "required", "activating"] as const)(
		"does not start a claim query while activation is %s",
		(activation) => {
			const source = input();
			source.configuration.activation = activation;
			expect(resolveIssueTrackerClaimConfiguration(source)).toEqual({
				kind: "unavailable",
				reason: "inactive",
			});
		},
	);

	it.each([
		null,
		{ enabled: false, plan_comparison: "matches_reviewed_plan" as const },
		{ enabled: true, plan_comparison: "changed_since_review" as const },
		{ enabled: true, plan_comparison: "no_reviewed_plan" as const },
	])(
		"keeps unknown or disabled permission out of the read path",
		(permission) => {
			const source = input();
			source.configuration.permission = permission;
			expect(resolveIssueTrackerClaimConfiguration(source)).toEqual({
				kind: "unavailable",
				reason: "inactive",
			});
			expect(isIssueTrackerPermissionEnabled(permission)).toBe(false);
		},
	);

	it("does not reinterpret a remote workspace as a supported local tracker", () => {
		const source = input();
		source.workspace = {
			root: "/work/project",
			projectId: "project",
			scopeKey: "ssh:host:project",
			watchKey: "ssh:host:project",
			source: "ssh",
		};
		expect(resolveIssueTrackerClaimConfiguration(source)).toEqual({
			kind: "unavailable",
			reason: "inactive",
		});
	});
});

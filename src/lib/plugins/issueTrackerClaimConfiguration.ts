import type { IssueTrackerOperationV1 } from "@/contracts/generated/extensionContracts";
import type { DurePluginPermissionSnapshot } from "@/lib/ipc/plugins";
import type {
	DurePluginSettingsSnapshot,
	DurePluginSettingsTargetV2,
} from "./durePlugins";
import type { PluginWorkspaceContext } from "./pluginWorkspace";

export interface IssueTrackerClaimProjectionInput {
	pluginId: string;
	viewContributionId: string;
	viewId: string;
	contributionId: string;
	workspace: PluginWorkspaceContext;
	statuses: string[];
	watchEnabled: boolean;
	intervalSeconds: number;
	agentClaimPolicyEpoch: number;
}

type PermissionObservation = Pick<
	DurePluginPermissionSnapshot,
	"enabled" | "plan_comparison"
> | null;

export function isIssueTrackerPermissionEnabled(
	permission: PermissionObservation,
): boolean {
	return (
		permission?.enabled === true &&
		permission.plan_comparison === "matches_reviewed_plan"
	);
}

export type IssueTrackerClaimConfiguration =
	| { kind: "hidden" }
	| {
			kind: "unavailable";
			reason: "inactive" | "settings" | "policy_epoch";
	  }
	| { kind: "ready"; input: IssueTrackerClaimProjectionInput };

/** Projects native permission/settings receipts into a read request. This does
 * not grant permission or activate a provider; those authorities remain native. */
export function resolveIssueTrackerClaimConfiguration(input: {
	pluginId: string;
	viewContributionId: string;
	viewId: string;
	contributionId: string;
	workspace: PluginWorkspaceContext | null;
	settingsTarget: DurePluginSettingsTargetV2 | null;
	claims:
		| {
				settingKey: string;
				statuses: string[];
				defaultVisible: boolean;
		  }
		| null
		| undefined;
	operations: readonly IssueTrackerOperationV1[];
	intervalSeconds: number;
	configuration: {
		permission: PermissionObservation;
		activation: "checking" | "required" | "active" | "activating";
		settings: Pick<
			DurePluginSettingsSnapshot,
			"values" | "agent_claim_policy_epochs"
		> | null;
		settingsLoaded: boolean;
		settingsError: string | null;
	};
}): IssueTrackerClaimConfiguration {
	const { claims, configuration, workspace } = input;
	const settingsKnown =
		input.settingsTarget === null ||
		workspace?.scopeKey === null ||
		configuration.settings !== null;
	const configured = claims
		? configuration.settings?.values[claims.settingKey]
		: undefined;
	if (
		!claims ||
		!configuration.settingsLoaded ||
		!settingsKnown ||
		!(typeof configured === "boolean" ? configured : claims.defaultVisible)
	) {
		return { kind: "hidden" };
	}
	if (configuration.settingsError !== null) {
		return { kind: "unavailable", reason: "settings" };
	}
	if (
		workspace?.source !== "local" ||
		!isIssueTrackerPermissionEnabled(configuration.permission) ||
		configuration.activation !== "active"
	) {
		return { kind: "unavailable", reason: "inactive" };
	}
	const epoch =
		configuration.settings?.agent_claim_policy_epochs?.[input.contributionId];
	if (typeof epoch !== "number") {
		return { kind: "unavailable", reason: "policy_epoch" };
	}
	return {
		kind: "ready",
		input: {
			pluginId: input.pluginId,
			viewContributionId: input.viewContributionId,
			viewId: input.viewId,
			contributionId: input.contributionId,
			workspace,
			statuses: claims.statuses,
			watchEnabled: input.operations.includes("watch"),
			intervalSeconds: input.intervalSeconds,
			agentClaimPolicyEpoch: epoch,
		},
	};
}

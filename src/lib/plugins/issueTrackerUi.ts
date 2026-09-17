import type {
	IssueTrackerOperationV1,
	IssueTrackerQueryResultV1,
	IssueTrackerQueryV1,
	PluginIssueTrackerDefaultQueryV1,
	PluginSettingValueV1,
} from "@/contracts/generated/extensionContracts";
import { t } from "@/lib/i18n";

export type IssueTrackerListMode = "blocked" | "human" | "list" | "ready";

export function issueTrackerListModes(
	operations: readonly IssueTrackerOperationV1[],
): IssueTrackerListMode[] {
	const modes: IssueTrackerListMode[] = [];
	if (operations.includes("ready")) modes.push("ready");
	if (operations.includes("list")) modes.push("list", "blocked");
	else if (operations.includes("human")) modes.push("human");
	return modes;
}

export function issueTrackerInitialMode(
	declared: PluginIssueTrackerDefaultQueryV1,
	workspaceSettings?: Record<string, PluginSettingValueV1>,
	settingKey?: string,
): IssueTrackerListMode {
	const configured = settingKey ? workspaceSettings?.[settingKey] : undefined;
	if (
		configured === "blocked" ||
		configured === "human" ||
		configured === "list" ||
		configured === "ready"
	) {
		return configured;
	}
	return declared;
}

export function issueTrackerListQuery(
	mode: IssueTrackerListMode,
): IssueTrackerQueryV1 {
	if (mode === "blocked") {
		return { kind: "list_by_status", statuses: ["blocked"], limit: 100 };
	}
	return { kind: mode, limit: 100 };
}

export function issueTrackerListResult(result: IssueTrackerQueryResultV1) {
	if (result.kind === "show" || result.kind === "counts") {
		throw new Error("unexpected issue detail response");
	}
	return result.issues;
}

export function issueTrackerDetailResult(result: IssueTrackerQueryResultV1) {
	if (result.kind !== "show") {
		throw new Error("unexpected issue list response");
	}
	return result.issue;
}

export function issueTrackerCountsResult(result: IssueTrackerQueryResultV1) {
	return result.kind === "counts" ? result.counts : null;
}

export function issueTrackerWatchInterval(
	workspaceSettings?: Record<string, PluginSettingValueV1>,
	settingKey?: string,
): number {
	const configured = settingKey ? workspaceSettings?.[settingKey] : undefined;
	return typeof configured === "number" && configured >= 5 && configured <= 300
		? configured
		: 30;
}

export function issueTrackerErrorMessage(error: unknown): string {
	const code = String(error);
	if (code.includes("permission_required")) {
		return t("plugins.issueTracker.error.permissionRequired");
	}
	if (code.includes("workspace_has_no_beads")) {
		return t("plugins.issueTracker.error.noData");
	}
	if (code.includes("workspace_has_no_github_remote")) {
		return t("plugins.issueTracker.error.noGithubRemote");
	}
	if (code.includes("github_auth_required")) {
		return t("plugins.issueTracker.error.githubAuthRequired");
	}
	if (code.includes("executable_unavailable")) {
		return t("plugins.issueTracker.error.cliUnavailable");
	}
	if (code.includes("embedded_engine")) {
		return t("plugins.issueTracker.error.embeddedEngine");
	}
	if (code.includes("command_timed_out")) {
		return t("plugins.issueTracker.error.timeout");
	}
	return t("plugins.issueTracker.error.loadFailed");
}

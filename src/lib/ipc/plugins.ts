// ipc/plugins — Dure 플러그인·이슈 트래커 브리지.
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
	IssueTrackerQueryResultV1,
	IssueTrackerQueryV1,
	IssueTrackerWatchEventV1,
	IssueTrackerWatchSubscriptionV1,
	PluginPermissionPlanComparisonV2,
	PluginPermissionPlanV2,
	PluginPermissionReviewDiffV2,
	PluginPermissionReviewProjectionV2,
	PluginSettingScopeV1,
} from "@/contracts/generated/extensionContracts";
import { listenWhenReady as listen } from "@/lib/platform/tauriBridge";
import type {
	DurePluginCatalogSnapshotV2,
	DurePluginLegacyCatalogEntry,
	DurePluginSettingsSnapshot,
	DurePluginSettingsTargetV2,
} from "@/lib/plugins/durePlugins";

export const durePluginCatalog = () =>
	invoke<DurePluginLegacyCatalogEntry[]>("dure_plugin_catalog");

export const durePluginCatalogV2 = () =>
	invoke<DurePluginCatalogSnapshotV2>("dure_plugin_catalog_v2");

export const durePluginSettingsGet = (
	target: DurePluginSettingsTargetV2,
	scope: PluginSettingScopeV1,
	scopeKey?: string,
	workspaceRoot?: string,
) =>
	invoke<DurePluginSettingsSnapshot>("dure_plugin_settings_get", {
		target,
		scope,
		scopeKey,
		workspaceRoot,
	});

export const durePluginSettingsUpdate = (
	snapshot: DurePluginSettingsSnapshot,
	workspaceRoot?: string,
) =>
	invoke<DurePluginSettingsSnapshot>("dure_plugin_settings_update", {
		snapshot,
		workspaceRoot,
	});

export type DurePluginPermissionDecision = "approve" | "defer" | "reject";

export interface DurePluginPermissionTargetRequest {
	plugin_id: string;
	workspace_root: string;
}

export interface DurePluginPermissionMutationRequest
	extends DurePluginPermissionTargetRequest {
	request_id: string;
	expected_record_revision: string;
}

export interface DurePluginPermissionDecisionRequest
	extends DurePluginPermissionMutationRequest {
	decision: DurePluginPermissionDecision;
	expected_plan_digest: string;
}

export interface DurePluginPermissionEnableRequest
	extends DurePluginPermissionMutationRequest {
	expected_plan_digest: string;
}

export interface DurePluginPermissionDisableRequest
	extends DurePluginPermissionTargetRequest {
	request_id: string;
}

export type DurePluginPermissionReviewComparison =
	| { status: "no_reviewed_plan" }
	| {
			status: "matches_reviewed_projection";
			reviewed_plan_digest: string;
	  }
	| {
			status: "changed_since_review";
			reviewed_plan_digest: string;
			diff: PluginPermissionReviewDiffV2;
	  }
	| {
			status: "legacy_digest_only";
			reviewed_plan_digest: string;
	  };

export interface DurePluginPermissionReviewSnapshot {
	current: PluginPermissionReviewProjectionV2;
	comparison: DurePluginPermissionReviewComparison;
}

export interface DurePluginPermissionSnapshot {
	plan: PluginPermissionPlanV2;
	review: DurePluginPermissionReviewSnapshot;
	record_revision: string;
	decision_revision: string;
	enablement_epoch: string;
	decision: DurePluginPermissionDecision | null;
	reviewed_plan_digest: string | null;
	plan_comparison: PluginPermissionPlanComparisonV2;
	enabled: boolean;
}

export type DurePluginPermissionDisableRequestPersistence =
	| "recorded"
	| "retirement_repair_no_transition";

export type DurePluginPermissionRuntimeRetirement = "succeeded" | "failed";

export interface DurePluginPermissionDisableReceipt
	extends DurePluginPermissionSnapshot {
	disable_request_persistence: DurePluginPermissionDisableRequestPersistence;
	runtime_retirement: DurePluginPermissionRuntimeRetirement;
}

export const durePluginPermissionGet = (
	request: DurePluginPermissionTargetRequest,
) =>
	invoke<DurePluginPermissionSnapshot>("dure_plugin_permission_get", {
		request,
	});

export const durePluginPermissionDecide = (
	request: DurePluginPermissionDecisionRequest,
) =>
	invoke<DurePluginPermissionSnapshot>("dure_plugin_permission_decide", {
		request,
	});

export const durePluginPermissionEnable = (
	request: DurePluginPermissionEnableRequest,
) =>
	invoke<DurePluginPermissionSnapshot>("dure_plugin_permission_enable", {
		request,
	});

export const durePluginPermissionDisable = (
	request: DurePluginPermissionDisableRequest,
) =>
	invoke<DurePluginPermissionDisableReceipt>("dure_plugin_permission_disable", {
		request,
	});

export const onDurePluginPermissionEvent = (
	callback: (snapshot: DurePluginPermissionSnapshot) => void,
): Promise<UnlistenFn> =>
	listen<DurePluginPermissionSnapshot>(
		"dure://plugin/permission",
		({ payload }) => callback(payload),
	);

export interface DureIssueTrackerQueryRequest {
	plugin_id: string;
	contribution_id: string;
	workspace_root: string;
	agent_claim_policy_epoch?: number;
	query: IssueTrackerQueryV1;
}

export interface DureIssueTrackerActivationRequest {
	plugin_id: string;
	contribution_id: string;
	workspace_root: string;
}

export interface DureIssueTrackerActivationEvent
	extends DureIssueTrackerActivationRequest {
	active: boolean;
}

export interface DureIssueTrackerWatchSubscribeRequest {
	plugin_id: string;
	contribution_id: string;
	workspace_key: string;
	workspace_root: string;
	subscriber_id: string;
	subscriber_epoch: number;
	interval_seconds: number;
	include_agent_claims: boolean;
	agent_claim_policy_epoch?: number;
}

export interface DureIssueTrackerWatchUnsubscribeRequest {
	plugin_id: string;
	contribution_id: string;
	workspace_root: string;
	subscriber_id: string;
	subscriber_epoch: number;
	generation?: number;
}

export const dureIssueTrackerActivationGet = (
	request: DureIssueTrackerActivationRequest,
) => invoke<boolean>("dure_issue_tracker_activation_get", { request });

export const dureIssueTrackerActivate = (
	request: DureIssueTrackerActivationRequest,
) => invoke<boolean>("dure_issue_tracker_activate", { request });

export const dureIssueTrackerQuery = (request: DureIssueTrackerQueryRequest) =>
	invoke<IssueTrackerQueryResultV1>("dure_issue_tracker_query", { request });

export const dureIssueTrackerWatchSubscribe = (
	request: DureIssueTrackerWatchSubscribeRequest,
) =>
	invoke<IssueTrackerWatchSubscriptionV1>(
		"dure_issue_tracker_watch_subscribe",
		{ request },
	);

export const dureIssueTrackerWatchUnsubscribe = (
	request: DureIssueTrackerWatchUnsubscribeRequest,
) => invoke<boolean>("dure_issue_tracker_watch_unsubscribe", { request });

export const onDureIssueTrackerWatchEvent = (
	callback: (event: IssueTrackerWatchEventV1) => void,
): Promise<UnlistenFn> =>
	listen<IssueTrackerWatchEventV1>(
		"dure://plugin/issue-tracker",
		({ payload }) => callback(payload),
	);

export const onDureIssueTrackerActivationEvent = (
	callback: (event: DureIssueTrackerActivationEvent) => void,
): Promise<UnlistenFn> =>
	listen<DureIssueTrackerActivationEvent>(
		"dure://plugin/issue-tracker-activation",
		({ payload }) => callback(payload),
	);

export const onDurePluginSettingsEvent = (
	callback: (snapshot: DurePluginSettingsSnapshot) => void,
): Promise<UnlistenFn> =>
	listen<DurePluginSettingsSnapshot>("dure://plugin/settings", ({ payload }) =>
		callback(payload),
	);

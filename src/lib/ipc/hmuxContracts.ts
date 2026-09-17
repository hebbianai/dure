// ipc/hmuxContracts — Hmux 제어면의 순수 계약(타입·인터페이스만, invoke 없음).
//
// hmux.ts 1069줄에서 분리(2026-08-01, ipc 분할 2단계). 소비자 호환을 위해
// hmux.ts가 전량 재-export한다 — 계약을 고칠 때는 이 파일만 보면 된다.

import type { HmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { ManagedCreateChainStopReceiptV2 } from "@/lib/hmux/managed/managedCreateChainStopReceipt";
import type { ManagedCreateAdvanceResolution } from "@/lib/hmux/managed/managedCreateResolution";
import type { ManagedRehostTargetReceiptV1 } from "@/lib/hmux/managed/managedRehostTargetReceipt";
import type { Provider, TerminalEnvironment } from "@/types";

export type HmuxWorkingDirectorySource =
	| "launch_fallback"
	| "osc7"
	| "process_inspection";

export interface HmuxWorkingDirectory {
	terminalEpoch: string;
	observedThroughOutputSeq: string;
	path: string;
	source: HmuxWorkingDirectorySource;
}

export interface HmuxAgentIdentity {
	terminalEpoch: string;
	observedThroughOutputSeq: string;
	/** 관찰자가 보내는 문자열은 hmux `AgentProvider::as_str` = 앱 Provider id다. */
	agent: Provider | null;
	source: "process_inspection";
}

export interface HmuxAgentRuntimeState {
	terminalEpoch: string;
	revision: string;
	observedThroughOutputSeq: string;
	lifecycle: "starting" | "running" | "exited";
	activity: "working" | "waiting";
	attention: "none" | "input_required" | "approval_required" | "error";
	attentionId?: string;
	source:
		| "provider_event"
		| "orchestration_event"
		| "controller_input"
		| "process_lifecycle";
	/** Host 완료 카운터(u64 → 10진 문자열). f2s 이전 백엔드는 생략한다. */
	turnCompletedCount?: string;
}

export interface HmuxProviderConversationIdentity
	extends HmuxManagedGenerationV1 {
	sessionId: string;
	workspaceId: string;
	revision: string;
	observedThroughOutputSeq: string;
	providerId: Provider;
	conversationId: string;
	source: "launch_request" | "provider_event";
}

/** hmux Host가 에이전트 상태 보고를 접수한 결과. dropped_exited도 성공 모양이다
 *  — Host가 이미 종료된 epoch임을 증명하고 보고를 폐기했다는 뜻. */
export interface HmuxAgentStateReportReceipt {
	outcome: "applied" | "dropped_exited" | "no_op";
}

export interface HmuxSessionRetirementPolicy {
	kind: "after_graceful_last_client_departure_v1";
	gracePeriodMs: number;
}

export interface HmuxPaneDepartureReceipt {
	state:
		| "policy_updated"
		| "retirement_armed"
		| "eligible"
		| "session_preserved"
		| "refused";
	reason?: string;
	policy?: HmuxSessionRetirementPolicy;
}

export interface HmuxPaneAttachmentStatus {
	ownerId: string;
	sessionId: string;
	workspaceId: string;
	state: "attached" | "detached";
	observerAttached: boolean;
	controllerAttached: boolean;
}

export interface HmuxSessionFailure {
	correlationId: string;
	sessionId: string;
	workspaceId: string;
	terminalEpoch: string;
	code: string;
	phase: "conversation_identity" | "provider_runtime";
	summary: string;
	exitKind:
		| "normal"
		| "usage_limit"
		| "authentication_failed"
		| "provider_error"
		| "signaled";
	exitCode: number | null;
	occurredUnixMs: string;
	retryPosture: "never";
}

export interface HmuxSessionSummary {
	sessionId: string;
	sessionName?: string;
	workspaceId: string;
	/** Omitted only by sidecars from before the standalone attach contract. */
	sessionClass?: "managed" | "standalone";
	lifecycle: "ready" | "exited" | "unavailable";
	/** Present on update-control-plane aware backends. */
	manifestLifecycle?: "ready" | "exited";
	health?:
		| "current_healthy"
		| "compatible_old_healthy"
		| "stale_transport"
		| "incompatible_protocol"
		| "exited"
		| "generation_changed"
		| "unprobed";
	hostBuildVersion?: string;
	clientSelection?: "direct_rust" | "external_cli_required" | "unavailable";
	inputAllowed?: boolean;
	detachOnly?: boolean;
	/** manifest host 프로세스가 확정적으로 죽었을 때만 false. 살아 있는 pid는
	 *  재사용일 수 있어 아무 주장도 없다(undefined) — 죽음 방향만 결정적. */
	hostProcessAlive?: boolean;
	/** Exact live Host has no sockets; native replacement rechecks this evidence. */
	hostSocketOwnerAbsent?: boolean;
	diagnostic?: {
		code:
			| "hmux_stale_transport"
			| "hmux_incompatible_protocol"
			| "hmux_external_cli_bridge_failed"
			| "hmux_version_matched_client_read_only"
			| "hmux_session_generation_changed"
			| "hmux_health_unprobed";
		message: string;
		retry:
			| "detach_only"
			| "version_matched_client_required"
			| "refresh_session_census";
	};
	failure?: HmuxSessionFailure;
	runtimeHost?: string;
	terminalEpoch: string;
	stopFence?: HmuxManagedStopFenceV1;
	outputSeq: string;
	capabilities: string[];
	retirementPolicy?: HmuxSessionRetirementPolicy;
}

export interface HmuxExactSessionTarget {
	sessionId: string;
	workspaceId: string;
}

export type HmuxExactSessionInspectionResult =
	| {
			outcome: "found";
			session: HmuxSessionSummary;
			agentRuntimeState?: HmuxAgentRuntimeState;
	  }
	| ({ outcome: "not_found" | "unprobed" } & HmuxExactSessionTarget)
	| ({ outcome: "lookup_failed"; errorCode: string } & HmuxExactSessionTarget);

export type HmuxManagedStopFenceV1 = HmuxManagedGenerationV1;

export interface HmuxManagedRehostGeneration extends HmuxManagedGenerationV1 {
	sessionId: string;
	workspaceId: string;
}

/** Present only when Hmux knows the final edge's complete launch identity.
 * Missing members are authoritative provider-default / fresh selections; a
 * missing `launchIdentity` means the prepared identity was unavailable. */
export interface HmuxManagedRehostLaunchIdentity {
	launchReference?: string;
	conversationId?: string;
}

export type HmuxManagedRehostResolution =
	| {
			schema: "hmux-managed-rehost-resolution-v1";
			schemaVersion: 1;
			state: "resolved";
			operationIds: string[];
			sourceGeneration: HmuxManagedRehostGeneration;
			currentGeneration: HmuxManagedRehostGeneration;
			providerId: Provider;
			permissionMode: "default" | "bypass_approvals";
			launchIdentity?: HmuxManagedRehostLaunchIdentity;
	  }
	| {
			schema: "hmux-managed-rehost-resolution-v1";
			schemaVersion: 1;
			state: "not_found";
			source: { sessionId: string; workspaceId: string };
	  }
	| {
			schema: "hmux-managed-rehost-resolution-v1";
			schemaVersion: 1;
			state: "retry_required";
			code: "hmux_managed_rehost_retry_required";
			operationId: string;
			source: { sessionId: string; workspaceId: string };
	  };

/** Host-validated final fence for an unattended managed replacement. The
 * source stop fence owns the terminal generation; these fields prove that the
 * provider remained idle and fully observed inside that generation. */
export interface HmuxManagedIdleReplacementGuardV1 {
	runtimeRevision: string;
	outputSequence: string;
	providerId: Provider;
	conversationId: string;
}

/** A legacy terminal can host an inner Hmux client. The adapter flattens the
 *  inner session summary with the runtime projections from the same bounded
 *  screen read so legacy presentation code does not spawn separate cwd/agent
 *  helper processes every few seconds. */
export interface LegacyAttachedHmuxSessionSummary extends HmuxSessionSummary {
	projectionRead: boolean;
	workingDirectory: string | null;
	agent: Provider | null;
}

export interface HmuxManagedConversationIdentity {
	sessionId: string;
	workspaceId: string;
	providerId: Provider;
	conversationId: string;
}

export interface HmuxExistingManagedWriterInspection {
	session: HmuxSessionSummary;
	idempotencyKey: string;
	conversationId: string;
	/** Opaque provider launch reference proven by the Hmux create recipe. */
	launchReference?: string;
	permissionMode: "default" | "bypass_approvals";
}

export interface HmuxRetireExitedGeneration {
	fence: {
		workspaceId: string;
		sessionId: string;
		runnerPrincipal: string;
		runnerInstance: string;
		channelEpoch: string;
		hostInstanceId: string;
		terminalEpoch: string;
	};
	hostProcess: {
		processId: number;
		startMarker: string;
	};
}

export interface HmuxRetireExitedItem {
	workspaceId: string;
	sessionId: string;
	terminalEpoch?: string;
	/** Full preview authority; required when confirmed=true. */
	generation?: HmuxRetireExitedGeneration;
}

export interface HmuxRetireExitedReceipt {
	workspaceId: string;
	sessionId: string;
	/** preview: retirable | skipped, execute: retired | already_retired | skipped */
	outcome: "retirable" | "retired" | "already_retired" | "skipped";
	generation?: HmuxRetireExitedGeneration;
	reason?:
		| "not_found"
		| "not_exited"
		| "not_stale"
		| "recovery_pending"
		| "epoch_changed"
		| "generation_changed"
		| "generation_required"
		| "lifetime_busy"
		| "journal_unavailable"
		| "archive_capacity"
		| "invalid_target"
		| "error";
	message?: string;
}

export interface HmuxControlPlaneCensus {
	policy: {
		currentBuildId?: string;
		previousBuildId?: string;
		activation: "local_bundled_or_installed_current";
		signedReleaseFetch: "not_implemented";
		signedPackageInstall: "blocked_missing_trust_root";
		independentInstall?: {
			source:
				| "independent_installer"
				| "bundled_fallback"
				| "unverified"
				| "unavailable";
			readiness:
				| "ready"
				| "bundled_fallback"
				| "provenance_unknown"
				| "cli_unavailable"
				| "protocol_incompatible"
				| "capability_unavailable"
				| "install_unsafe"
				| "probe_failed"
				| "metadata_inconsistent"
				| "unavailable";
			diagnosticCode: string;
			/** Exact bounded probe stage, present only when readiness is probe_failed. */
			probeFailureStage?: string;
			cliAvailable: boolean;
			protocolCompatible: boolean;
		};
	};
	sessions: HmuxSessionSummary[];
	/** Ref-aware GC must protect every listed immutable build. */
	protectedBuildIds: string[];
	/** Additive adapter timing receipt; absent on older desktop backends. */
	diagnostics?: {
		catalogUs: number;
		healthProjectionUs: number;
		/** Shared session-census execution only; excludes caller wait and IPC work. */
		totalUs: number;
		/** Waited for an existing census; this is not causal ownership. */
		joinedExisting: boolean;
	};
}

export interface HmuxCurrentBuildChangeReceipt {
	action: "activate_installed_build" | "rollback_current_build";
	currentBuildId: string;
	previousBuildId?: string;
}

export interface HmuxRecoveryPlanReceipt {
	sessionId: string;
	sourceBuildId: string;
	targetBuildId?: string;
	action:
		| "none"
		| "restore_plain_shell_with_current_build"
		| "replace_ai_provider_with_explicit_conversation";
	allowed: boolean;
	reason?:
		| "verified_resurrection_recipe_required"
		| "conversation_identity_required"
		| "update_requires_confirmation";
	requiresConfirmation: boolean;
}

export interface HmuxRecoveryExecutionReceipt {
	sourceSessionId: string;
	targetBuildId?: string;
	action:
		| "none"
		| "restore_plain_shell_with_current_build"
		| "replace_ai_provider_with_explicit_conversation"
		| "replace_ai_provider_with_fresh_conversation";
	outcome: "restored" | "replaced" | "refused" | "failed";
	/** True when replay started from a durable completion; an exact target may be recreated. */
	replayed: boolean;
	operationId?: string;
	conversationId?: string;
	/** Opaque provider credential/profile reference; never credential material. */
	launchReference?: string;
	reason?:
		| "verified_resurrection_recipe_required"
		| "update_requires_confirmation"
		| "recovery_source_healthy"
		| "recovery_source_process_live"
		| "incompatible_protocol"
		| "conversation_identity_required"
		| "managed_recovery_launch_required"
		| "managed_recovery_source_missing"
		| "managed_recovery_identity_mismatch"
		| "managed_recovery_credential_unavailable"
		| "managed_recovery_cwd_unavailable"
		| "managed_recovery_exact_resume_unsupported"
		| "managed_recovery_launch_invalid"
		| "managed_recovery_request_invalid"
		| "managed_recovery_source_fence_invalid"
		| "managed_recovery_source_fence_changed"
		| "recovery_journal_invalid"
		| "recovery_source_changed"
		| "recovery_target_build_unavailable"
		| "recovery_identity_conflict";
	/** Present when this transaction retired one exact live managed source. */
	sourceStopReceipt?: HmuxManagedStopReceipt;
	/** Canonical journal-selected target, independent of catalog presentation. */
	replacementTarget?: ManagedRehostTargetReceiptV1;
	replacementSession?: HmuxSessionSummary;
}

export interface HmuxStandaloneUpgradeReceipt {
	sourceSessionId: string;
	sourceWorkspaceId: string;
	sourceBuildId?: string;
	targetBuildId: string;
	action: "none" | "upgrade_standalone_with_current_build";
	outcome: "already_current" | "rehosted" | "refused" | "replacement_failed";
	replayed: boolean;
	reason?: string;
	requiresConfirmation: boolean;
	replacementSession?: HmuxSessionSummary;
}

export interface HmuxSessionConversionReceipt {
	sourceSessionId: string;
	sourceWorkspaceId: string;
	targetClass: "managed" | "standalone";
	targetBuildId?: string;
	replacementIdempotencyKey?: string;
	action:
		| "convert_standalone_to_managed_with_exact_conversation"
		| "convert_managed_to_standalone_with_exact_conversation";
	outcome: "converted" | "refused" | "replacement_failed";
	replayed: boolean;
	reason?: string;
	requiresConfirmation: boolean;
	providerId: Provider;
	conversationId?: string;
	replacementSession?: HmuxSessionSummary;
}

export interface HmuxManagedRecoveryLaunch {
	providerId: Provider;
	permissionMode: "default" | "bypass_approvals";
	credentialId?: string;
	/** Private adapter input; never persisted by Hmux discovery or receipts. */
	credentialDirectory?: string;
	credentialGeneration?: number;
	cwd: string;
	columns: number;
	rows: number;
	terminalEnvironment: TerminalEnvironment;
}

export interface HmuxManagedCreateReceipt {
	session: HmuxSessionSummary;
	idempotencyKey: string;
	/** Backend-canonical launch cwd. Required at an exact worktree reuse boundary;
	 * optional here only for compatibility with pre-contract sidecars. */
	cwd?: string;
	outcome: "created" | "reused";
	/** True only when the provider CLI received the initial prompt in this
	 * idempotent managed launch rather than through a later terminal write. */
	initialPromptAccepted?: boolean;
	/** Provider-adapter reference only. Hmux discovery never receives it. */
	credentialId?: string;
	credentialGeneration?: number;
}

export type HmuxExactManagedCreateReceipt = Omit<
	HmuxManagedCreateReceipt,
	"session"
> & {
	session: HmuxSessionSummary & {
		sessionClass: "managed";
		stopFence: HmuxManagedStopFenceV1;
	};
};

export type HmuxManagedCreateAdvanceResolution =
	ManagedCreateAdvanceResolution<HmuxExactManagedCreateReceipt>;

export type HmuxManagedCreateChainStopReceipt = ManagedCreateChainStopReceiptV2;

export interface HmuxManagedShellPromotionReceipt {
	sourceSessionId: string;
	sourceWorkspaceId: string;
	sourceTerminalEpoch: string;
	cwd: string;
	target: HmuxManagedCreateReceipt;
}

export interface HmuxManagedStopReceipt {
	/** Current Hmux receipts carry this schema identity. Legacy call sites may
	 * omit it until validation at a destructive or recovery boundary. */
	schema?: "hmux-managed-stop-v1";
	schemaVersion?: 2;
	stopId: string;
	sessionId: string;
	workspaceId: string;
	runnerPrincipal: string;
	runnerInstance: string;
	channelEpoch: number;
	hostInstanceId: string;
	terminalEpoch: string;
	requireUntouchedAgent?: boolean;
	outcome: "stopped" | "already_exited";
	exitReason: string;
}

export type HmuxManagedSessionRetirementObservation =
	| { kind: "no_ledger" }
	| { kind: "not_finalized" }
	| { kind: "finalized"; receipt: HmuxManagedStopReceipt };

export interface HmuxExactSessionTerminationReceipt {
	sessionId: string;
	workspaceId: string;
	terminalEpoch: string;
	sessionClass: "managed" | "standalone";
	outcome: "terminated" | "already_exited";
}

export interface HmuxSemanticInputReceipt {
	recordId: string;
	state: "written_to_pty";
}

/** One orchestration command projected from the Host's semantic terminal
 * writer. Text and submit receipts stay independently correlated; there is no
 * controller generation because this path never acquires a controller lease. */
export interface HmuxCommandInputReceipt {
	terminalEpoch: string;
	text?: HmuxSemanticInputReceipt;
	submit?: HmuxSemanticInputReceipt;
}

/** Exact managed runtime identity and fence for one Host-admitted prompt. */
export interface HmuxInitialAgentPromptRequest {
	sessionId: string;
	workspaceId: string;
	expectedFence: HmuxManagedStopFenceV1;
	prompt: string;
}

/** Proof of one Host-admitted fresh-agent prompt write. Numeric protocol
 * counters remain decimal strings across the IPC boundary. */
export interface HmuxInitialAgentPromptReceipt {
	terminalEpoch: string;
	recordId: string;
	inputBaselineOutputSequence: string;
	initialAgentRuntimeRevision?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type ProviderPreflightStatus =
	| "ready"
	| "environment_timeout"
	| "environment_failed"
	| "not_found"
	| "path_missing"
	| "broken_symlink"
	| "not_executable"
	| "version_timeout"
	| "version_failed";

export interface ProviderPreflight {
	provider: Provider;
	command: string;
	ready: boolean;
	status: ProviderPreflightStatus;
	message: string;
	shell: string;
	cwd: string;
	environmentSource: "login_shell";
	path?: string;
	commandPath?: string;
	resolvedPath?: string;
	symlinkChain: string[];
	executable: boolean;
	version?: string;
	versionTimeoutMs: number;
	inheritedNoColor?: string;
	effectiveNoColor?: string;
	recoveryRequiresUserApproval: boolean;
	suggestedRecovery: string[];
}

export interface DirEntry {
	name: string;
	path: string;
	isDir: boolean;
	isRepo: boolean;
	/** git이 무시하는 항목인지. list_dir이 markIgnored로 호출됐을 때만 채워지고,
	 *  원격(ssh) 목록에는 없다 — 판정은 로컬 저장소의 git이 한다. */
	ignored?: boolean;
}

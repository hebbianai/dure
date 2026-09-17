// ipc/hmux — Hmux 제어면 — 세션 census·복구·pane departure.
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).
import { invoke } from "@tauri-apps/api/core";
import { HmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import { hmuxStructuredTerminalAttachError } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import { isManagedCreateChainStopReceiptV2 } from "@/lib/hmux/managed/managedCreateChainStopReceipt";
import { managedCreateInvokeOutcomeUnknown } from "@/lib/hmux/managed/managedCreateResolution";
import type { ManagedCreateDiagnostics } from "@/lib/hmux/managed/managedRefreshTiming";
import { isManagedStopReceiptV2 } from "@/lib/hmux/managed/managedRehostTargetReceipt";
import type {
	RemoteHmuxCatalogSessionV1,
	RemoteHmuxCatalogTargetV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import { hasOnlyKeys, isRecord } from "@/lib/payloadGuards";
import { BACKEND_FEATURES } from "@/lib/platform/backendCompatibility";
import { currentWebviewInstanceIdentity } from "@/lib/platform/webviewInstanceIdentity";
import type { TerminalDefaultColors } from "@/lib/terminal/state/terminalDefaultColors";
import type { Provider, TerminalEnvironment } from "@/types";
import {
	HmuxInputPreDispatchError,
	parseHmuxCommandInputReceipt,
	parseHmuxInitialAgentPromptReceipt,
} from "./hmuxInputReceipt";

// 계약(타입)은 hmuxContracts.ts 소유 — 재-export로 기존 임포트 경로 유지.
export * from "./hmuxContracts";

import { backendSupports } from "./core";
import type {
	HmuxAgentStateReportReceipt,
	HmuxControlPlaneCensus,
	HmuxCurrentBuildChangeReceipt,
	HmuxExactSessionInspectionResult,
	HmuxExactSessionTarget,
	HmuxExactSessionTerminationReceipt,
	HmuxExistingManagedWriterInspection,
	HmuxInitialAgentPromptRequest,
	HmuxManagedConversationIdentity,
	HmuxManagedCreateAdvanceResolution,
	HmuxManagedCreateChainStopReceipt,
	HmuxManagedCreateReceipt,
	HmuxManagedIdleReplacementGuardV1,
	HmuxManagedRecoveryLaunch,
	HmuxManagedRehostResolution,
	HmuxManagedSessionRetirementObservation,
	HmuxManagedShellPromotionReceipt,
	HmuxManagedStopFenceV1,
	HmuxManagedStopReceipt,
	HmuxPaneAttachmentStatus,
	HmuxPaneDepartureReceipt,
	HmuxRecoveryExecutionReceipt,
	HmuxRecoveryPlanReceipt,
	HmuxRetireExitedItem,
	HmuxRetireExitedReceipt,
	HmuxSessionConversionReceipt,
	HmuxSessionSummary,
	HmuxStandaloneUpgradeReceipt,
} from "./hmuxContracts";
import { parseHmuxManagedCreateAdvanceResolutionV1 } from "./hmuxManagedCreatePayload";

export interface AppHomeInfo {
	appRoot: string;
	appRootSource: "env_override" | "renamed" | "legacy";
	cliInstallRoot: string;
	appDataDir?: string | null;
	discoveryRoot?: string | null;
}

export interface HmuxStructuredTerminalAttachReceipt {
	terminalEpoch: string;
	throughOutputSeq: string;
	stateRevision: string;
	/** Ordered raw records available through the initial pull sequence. */
	initialDeliveryRecordCount: number;
	selectedCapabilities: string[];
	/** Tauri adapter command-entry through response construction, in microseconds. */
	backendCommandUs?: number;
	session?: HmuxSessionSummary;
}

export type HmuxStructuredTerminalAccess = "read_only" | "writer";

function parseExactSessionTerminationReceipt(
	expected: {
		sessionId: string;
		workspaceId: string;
		terminalEpoch: string;
		sessionClass: "managed" | "standalone";
	},
	value: unknown,
): HmuxExactSessionTerminationReceipt {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"sessionId",
			"workspaceId",
			"terminalEpoch",
			"sessionClass",
			"outcome",
		]) ||
		value.sessionId !== expected.sessionId ||
		value.workspaceId !== expected.workspaceId ||
		value.terminalEpoch !== expected.terminalEpoch ||
		value.sessionClass !== expected.sessionClass ||
		(value.outcome !== "terminated" && value.outcome !== "already_exited")
	) {
		throw new Error("hmux_exact_termination_receipt_mismatch");
	}
	return {
		...expected,
		outcome: value.outcome,
	};
}

async function invokeAttachWithTerminalFailure<T>(
	command: string,
	arguments_: Record<string, unknown>,
	target: HmuxExactSessionTarget,
): Promise<T> {
	try {
		return await invoke<T>(command, arguments_);
	} catch (cause) {
		try {
			const [inspection] = await invoke<HmuxExactSessionInspectionResult[]>(
				"hmux_inspect_sessions_exact",
				{ targets: [target] },
			);
			const failure =
				inspection?.outcome === "found" && inspection.session.failure;
			if (
				failure &&
				failure.sessionId === target.sessionId &&
				failure.workspaceId === target.workspaceId &&
				failure.terminalEpoch === inspection.session.terminalEpoch
			) {
				throw new HmuxSessionFailureError(failure);
			}
		} catch (inspectionCause) {
			if (inspectionCause instanceof HmuxSessionFailureError) {
				throw inspectionCause;
			}
		}
		throw cause;
	}
}

async function invokeStructuredTerminalAttach(
	command:
		| "hmux_structured_terminal_attach"
		| "remote_hmux_structured_terminal_attach",
	arguments_: Record<string, unknown>,
	target?: HmuxExactSessionTarget,
): Promise<HmuxStructuredTerminalAttachReceipt> {
	try {
		return target
			? await invokeAttachWithTerminalFailure<HmuxStructuredTerminalAttachReceipt>(
					command,
					arguments_,
					target,
				)
			: await invoke<HmuxStructuredTerminalAttachReceipt>(command, arguments_);
	} catch (cause) {
		throw hmuxStructuredTerminalAttachError(cause) ?? cause;
	}
}

/** 설정 › 데이터 위치 — 앱 홈·CLI 설치·앱 상태·discovery root 경로와 해석 근거. */
export const appHomeInfo = () => invoke<AppHomeInfo>("app_home_info");

export const hmux = {
	listSessions: () => invoke<HmuxSessionSummary[]>("hmux_list_sessions"),
	attachStructuredTerminal: (request: {
		observerId: string;
		surfaceId: string;
		sessionId: string;
		workspaceId?: string;
		access: HmuxStructuredTerminalAccess;
	}) => {
		const arguments_ = {
			observerId: request.observerId,
			webviewInstanceId: currentWebviewInstanceIdentity().instanceId,
			surfaceId: request.surfaceId,
			sessionId: request.sessionId,
			workspaceId: request.workspaceId ?? null,
			access: request.access,
		};
		return invokeStructuredTerminalAttach(
			"hmux_structured_terminal_attach",
			arguments_,
			request.workspaceId
				? {
						sessionId: request.sessionId,
						workspaceId: request.workspaceId,
					}
				: undefined,
		);
	},
	attachRemoteStructuredTerminal: (request: {
		observerId: string;
		surfaceId: string;
		access: HmuxStructuredTerminalAccess;
		target: RemoteHmuxCatalogTargetV1;
		session: RemoteHmuxCatalogSessionV1;
	}) => {
		const { schemaVersion: _schemaVersion, ...target } = request.target;
		return invokeStructuredTerminalAttach(
			"remote_hmux_structured_terminal_attach",
			{
				webviewInstanceId: currentWebviewInstanceIdentity().instanceId,
				request: {
					observerId: request.observerId,
					surfaceId: request.surfaceId,
					access: request.access,
					target,
					session: request.session,
				},
			},
		);
	},
	commandInput: async (request: {
		sessionId: string;
		workspaceId: string;
		expectedFence?: HmuxManagedStopFenceV1;
		text: string;
		submit: boolean;
	}) => {
		const value = await invoke<unknown>("hmux_command_input", {
			request: {
				sessionId: request.sessionId,
				workspaceId: request.workspaceId,
				expectedFence: request.expectedFence ?? null,
				text: request.text,
				submit: request.submit,
			},
		});
		return parseHmuxCommandInputReceipt(value, {
			terminalEpoch: request.expectedFence?.terminalEpoch,
			text: request.text.length > 0,
			submit: request.submit,
		});
	},
	initialAgentPrompt: async (request: HmuxInitialAgentPromptRequest) => {
		if (!(await backendSupports(BACKEND_FEATURES.hmuxInitialAgentPrompt))) {
			throw new HmuxInputPreDispatchError(
				"hmux_initial_agent_prompt_backend_unavailable",
			);
		}
		const value = await invoke<unknown>("hmux_initial_agent_prompt", {
			request,
		});
		return parseHmuxInitialAgentPromptReceipt(
			value,
			request.expectedFence.terminalEpoch,
		);
	},
	nextStructuredTerminalRecord: (observerId: string) =>
		invoke<ArrayBuffer>("hmux_structured_terminal_next", {
			observerId,
			webviewInstanceId: currentWebviewInstanceIdentity().instanceId,
		}),
	detachStructuredTerminal: (observerId: string) =>
		invoke<void>("hmux_structured_terminal_detach", { observerId }),
	sendStructuredTerminalRecord: (observerId: string, record: Uint8Array) =>
		invoke<string>("hmux_structured_terminal_upstream", {
			observerId,
			record: Array.from(record),
		}),
	/** 연결 진단 이벤트 append — 이벤트 shape 소유는 도메인(hmuxConnectionDiagnostics). */
	appendConnectionDiagnostics: <T extends object>(events: T[]) =>
		invoke<void>("append_hmux_connection_diagnostics", { events }),
	/** Hmux local-state GC (기본 보존 정책). 스케줄은 maintenance 서비스가,
	 *  적격·보호·잠금 판정은 hmux-client가 소유한다. */
	localStateGc: <T>(mode: "preview" | "apply") =>
		invoke<T>("hmux_local_state_gc", { mode }),
	/** 전역 catalog를 열거하지 않고 workspace/session identity만 유계 조회한다.
	 * 부재, 조회 실패, 예산 미판정을 서로 다른 결과로 보존한다. */
	inspectSessionsExact: (targets: HmuxExactSessionTarget[]) =>
		invoke<HmuxExactSessionInspectionResult[]>("hmux_inspect_sessions_exact", {
			targets,
		}),
	resolveManagedRehost: (sessionId: string, workspaceId: string) =>
		invoke<HmuxManagedRehostResolution>("hmux_resolve_managed_rehost", {
			sessionId,
			workspaceId,
		}),
	resolveNamedSession: (name: string) =>
		invoke<HmuxSessionSummary>("hmux_resolve_named_session", { name }),
	inspectManagedConversationIdentity: (request: {
		sessionId: string;
		workspaceId: string;
		providerId: Provider;
		cwd: string;
	}) =>
		invoke<HmuxManagedConversationIdentity>(
			"hmux_managed_conversation_identity",
			request,
		),
	/** The Tauri command retains its legacy `credentialId` wire member, but the
	 * value is Hmux's opaque launch reference and is named accordingly here. */
	inspectExistingManagedWriter: async (request: {
		sessionId: string;
		workspaceId: string;
		providerId: Provider;
		conversationId: string;
		cwd: string;
		permissionMode: "default" | "bypass_approvals";
		launchReference?: string;
	}) => {
		const { launchReference, ...wireRequest } = request;
		const wire = await invoke<
			Omit<HmuxExistingManagedWriterInspection, "launchReference"> & {
				credentialId?: string;
			}
		>("hmux_existing_managed_writer", {
			request: {
				...wireRequest,
				credentialId: launchReference ?? null,
			},
		});
		const { credentialId, ...inspection } = wire;
		return {
			...inspection,
			...(credentialId === undefined ? {} : { launchReference: credentialId }),
		};
	},
	controlPlaneCensus: () =>
		invoke<HmuxControlPlaneCensus>("hmux_control_plane_census"),
	/** exited 세션의 discovery 포인터 은퇴(hn2t). confirmed=false는 순수 preview.
	 *  apply authority는 preview가 반환한 complete generation이다. */
	retireExitedSessions: (items: HmuxRetireExitedItem[], confirmed: boolean) =>
		invoke<HmuxRetireExitedReceipt[]>("hmux_retire_exited_sessions", {
			items,
			confirmed,
		}),
	/** Remove an exact non-exited generation only after preview proves its
	 * lifetime lock is unowned. This never invokes recovery or Host stop. */
	cleanupStaleSessions: (items: HmuxRetireExitedItem[], confirmed: boolean) =>
		invoke<HmuxRetireExitedReceipt[]>("hmux_cleanup_stale_sessions", {
			items,
			confirmed,
		}),
	activateInstalledBuild: (buildId: string) =>
		invoke<HmuxCurrentBuildChangeReceipt>("hmux_activate_installed_build", {
			buildId,
		}),
	rollbackCurrentBuild: () =>
		invoke<HmuxCurrentBuildChangeReceipt>("hmux_rollback_current_build"),
	planRecovery: (request: {
		sessionId: string;
		workspaceId: string;
		expectedSourceFence?: HmuxManagedStopFenceV1;
		conversationId?: string;
		adapterSupportsExplicitResume: boolean;
		confirmed: boolean;
	}) =>
		invoke<HmuxRecoveryPlanReceipt>("hmux_plan_recovery", {
			request: {
				...request,
				expectedSourceFence: request.expectedSourceFence ?? null,
				conversationId: request.conversationId ?? null,
			},
		}),
	executeRecovery: (request: {
		recoveryId: string;
		kind: "plain_shell" | "managed_provider" | "managed_provider_fresh";
		sessionId: string;
		workspaceId: string;
		expectedSourceFence?: HmuxManagedStopFenceV1;
		requireSocketOwnerAbsent?: true;
		idleReplacementGuard?: HmuxManagedIdleReplacementGuardV1;
		sourceOwnerId?: string;
		expectedTargetBuildId?: string;
		conversationId?: string;
		adapterSupportsExplicitResume: boolean;
		confirmed: boolean;
		managedLaunch?: HmuxManagedRecoveryLaunch;
	}) =>
		invoke<HmuxRecoveryExecutionReceipt>("hmux_execute_recovery", {
			request: {
				...request,
				expectedSourceFence: request.expectedSourceFence ?? null,
				idleReplacementGuard: request.idleReplacementGuard ?? null,
				sourceOwnerId: request.sourceOwnerId ?? null,
				expectedTargetBuildId: request.expectedTargetBuildId ?? null,
				conversationId: request.conversationId ?? null,
				managedLaunch: request.managedLaunch
					? {
							...request.managedLaunch,
							credentialId: request.managedLaunch.credentialId ?? null,
							credentialDirectory:
								request.managedLaunch.credentialDirectory ?? null,
							credentialGeneration:
								request.managedLaunch.credentialGeneration ?? null,
						}
					: null,
			},
		}),
	reconcileManagedRecovery: (request: {
		recoveryId: string;
		sessionId: string;
		workspaceId: string;
	}) =>
		invoke<HmuxRecoveryExecutionReceipt | null>(
			"hmux_reconcile_managed_recovery",
			{ request },
		),
	upgradeStandalone: (request: {
		upgradeId: string;
		sessionId: string;
		workspaceId: string;
		sessionName: string;
		confirmed: boolean;
	}) =>
		invoke<HmuxStandaloneUpgradeReceipt>("hmux_upgrade_standalone", {
			request,
		}),
	createStandalone: (request: {
		operationId: string;
		cwd: string;
		columns: number;
		rows: number;
		terminalEnv?: TerminalEnvironment;
		/** One-shot command line (login/setup command panes) — the adapter runs
		 * it through the user's login shell. Omit for the interactive shell. */
		commandLine?: string;
		terminalDefaultColors: TerminalDefaultColors;
	}) =>
		invoke<HmuxSessionSummary>("hmux_standalone_create", {
			request: {
				...request,
				terminalEnv: request.terminalEnv ?? null,
				commandLine: request.commandLine ?? null,
				terminalDefaultColors: request.terminalDefaultColors,
			},
		}),
	abandonUnpresentedCreation: (sessionId: string, workspaceId: string) =>
		invoke<HmuxPaneDepartureReceipt>("hmux_standalone_abandon_unpresented", {
			sessionId,
			workspaceId,
		}),
	advanceManagedCreate: async (
		request: {
			/** Explicit Resume intent: Hmux attempts one deterministic replacement
			 * root first and consults the exact source only when cleanup is required. */
			replaceCurrent?: boolean;
			idempotencyKey: string;
			sessionId: string;
			workspaceId: string;
			providerId: Provider;
			conversationId?: string;
			permissionMode: "default" | "bypass_approvals";
			credentialId?: string;
			/** Private adapter input; never persisted by Hmux discovery or receipts. */
			credentialDirectory?: string;
			credentialGeneration?: number;
			cwd: string;
			command: string;
			initialPrompt?: string;
			columns: number;
			rows: number;
			terminalEnv?: TerminalEnvironment;
			terminalDefaultColors: TerminalDefaultColors;
		},
		diagnostics?: ManagedCreateDiagnostics,
	) => {
		diagnostics?.timing?.mark("capabilities.start");
		// This reads the current adapter's command surface, not the old Host.
		if (!(await backendSupports(BACKEND_FEATURES.hmuxManagedCreateAdvanceV1))) {
			throw new Error("hmux_managed_create_advance_v1_backend_unavailable");
		}
		const { initialPrompt, ...baseRequest } = request;
		const launchPromptSupported =
			initialPrompt !== undefined &&
			(await backendSupports(BACKEND_FEATURES.hmuxManagedLaunchPromptV1));
		diagnostics?.timing?.mark("capabilities.ready");
		const payload = {
			...baseRequest,
			...(request.replaceCurrent ? { replaceCurrent: true } : {}),
			credentialId: request.credentialId ?? null,
			conversationId: request.conversationId ?? null,
			credentialDirectory: request.credentialDirectory ?? null,
			credentialGeneration: request.credentialGeneration ?? null,
			...(launchPromptSupported ? { initialPrompt } : {}),
			terminalEnv: request.terminalEnv ?? null,
			terminalDefaultColors: request.terminalDefaultColors,
		};
		let value: unknown;
		try {
			diagnostics?.timing?.mark("invoke.start");
			value = await invoke<unknown>("hmux_managed_create_advance_v1", {
				request: payload,
				...(diagnostics?.brokerTiming === true ? { brokerTiming: true } : {}),
			});
			diagnostics?.timing?.mark("invoke.received");
		} catch (error) {
			throw managedCreateInvokeOutcomeUnknown(error);
		}
		const resolution: HmuxManagedCreateAdvanceResolution | undefined =
			parseHmuxManagedCreateAdvanceResolutionV1(value, request);
		if (!resolution) {
			throw managedCreateInvokeOutcomeUnknown(
				new Error("hmux_managed_create_resolution_invalid"),
			);
		}
		diagnostics?.timing?.mark("resolution.ready");
		return resolution;
	},
	createManagedShell: (request: {
		idempotencyKey: string;
		sessionId: string;
		workspaceId: string;
		cwd: string;
		columns: number;
		rows: number;
		terminalEnv?: TerminalEnvironment;
		terminalDefaultColors: TerminalDefaultColors;
	}) =>
		invoke<HmuxManagedCreateReceipt>("hmux_managed_shell_create", {
			...request,
			terminalEnv: request.terminalEnv ?? null,
			terminalDefaultColors: request.terminalDefaultColors,
		}),
	promoteAppStandaloneShell: (request: {
		sourceSessionId: string;
		sourceWorkspaceId: string;
		sourceTerminalEpoch: string;
	}) =>
		invoke<HmuxManagedShellPromotionReceipt>(
			"hmux_promote_app_standalone_shell",
			{ request },
		),
	sweepAppStandaloneShell: (
		sessionId: string,
		workspaceId: string,
		terminalEpoch: string,
		targetSessionId: string,
		targetWorkspaceId: string,
		targetTerminalEpoch: string,
	) =>
		invoke<HmuxPaneDepartureReceipt>("hmux_sweep_app_standalone_shell", {
			sessionId,
			workspaceId,
			terminalEpoch,
			targetSessionId,
			targetWorkspaceId,
			targetTerminalEpoch,
		}),
	/** Exact standalone Host termination. Callers must own the lifecycle action. */
	terminateStandalone: (sessionId: string, workspaceId: string) =>
		invoke<void>("hmux_standalone_terminate", { sessionId, workspaceId }),
	/** Fresh liveness + terminal-generation fenced termination for an unowned catalog row. */
	terminateExact: (
		sessionId: string,
		workspaceId: string,
		terminalEpoch: string,
		sessionClass: "managed" | "standalone",
	) => {
		const request = {
			sessionId,
			workspaceId,
			terminalEpoch,
			sessionClass,
		};
		return invoke<unknown>("hmux_session_terminate_exact", request).then(
			(receipt) => parseExactSessionTerminationReceipt(request, receipt),
		);
	},
	readManagedSessionRetirement: async (
		sessionId: string,
		workspaceId: string,
	): Promise<HmuxManagedSessionRetirementObservation> => {
		const value = await invoke<unknown>("hmux_managed_session_retirement", {
			sessionId,
			workspaceId,
		});
		if (isRecord(value)) {
			if (
				(value.kind === "no_ledger" || value.kind === "not_finalized") &&
				hasOnlyKeys(value, ["kind"])
			) {
				return { kind: value.kind };
			}
			if (
				value.kind === "finalized" &&
				hasOnlyKeys(value, ["kind", "receipt"]) &&
				isManagedStopReceiptV2(value.receipt, { sessionId, workspaceId })
			) {
				return { kind: "finalized", receipt: value.receipt };
			}
		}
		throw new Error("managed_session_retirement_observation_invalid");
	},
	readCompletedManagedStop: (
		stopId: string,
		sessionId: string,
		workspaceId: string,
		expectedFence: HmuxManagedStopFenceV1,
	) =>
		invoke<HmuxManagedStopReceipt | null>("hmux_managed_stop_completed", {
			stopId,
			fence: {
				session_id: sessionId,
				workspace_id: workspaceId,
				runner_principal: expectedFence.runnerPrincipal,
				runner_instance: expectedFence.runnerInstance,
				channel_epoch: expectedFence.channelEpoch,
				host_instance_id: expectedFence.hostInstanceId,
				terminal_epoch: expectedFence.terminalEpoch,
			},
		}),
	stopManaged: (
		stopId: string,
		sessionId: string,
		workspaceId: string,
		expectedFence: HmuxManagedStopFenceV1,
	) =>
		invoke<HmuxManagedStopReceipt>("hmux_managed_stop", {
			stopId,
			sessionId,
			workspaceId,
			expectedFence,
		}),
	stopManagedCreateChain: async (
		idempotencyKey: string,
		sessionId: string,
		workspaceId: string,
	): Promise<HmuxManagedCreateChainStopReceipt> => {
		if (
			!(await backendSupports(BACKEND_FEATURES.hmuxManagedCreateChainStopV2))
		) {
			throw new Error("hmux_managed_create_chain_stop_v2_backend_unavailable");
		}
		const value = await invoke<unknown>("hmux_managed_create_chain_stop_v2", {
			idempotencyKey,
			sessionId,
			workspaceId,
		});
		if (
			!isManagedCreateChainStopReceiptV2(value, {
				idempotencyKey,
				sessionId,
				workspaceId,
			})
		) {
			throw new Error("hmux_managed_create_chain_stop_receipt_invalid");
		}
		return value;
	},
	convertSession: (request: {
		conversionId: string;
		sourceSessionId: string;
		sourceWorkspaceId: string;
		expectedSourceFence?: HmuxManagedStopFenceV1;
		target: "managed" | "standalone";
		providerId: Provider;
		expectedConversationId?: string;
		cwd: string;
		confirmed: boolean;
		permissionMode: "default" | "bypass_approvals";
		credentialId?: string;
		/** Private adapter input; never persisted by Hmux discovery or receipts. */
		credentialDirectory?: string;
		credentialGeneration?: number;
		rows: number;
		columns: number;
		terminalEnvironment: TerminalEnvironment;
		terminalDefaultColors: TerminalDefaultColors;
	}) =>
		invoke<HmuxSessionConversionReceipt>("hmux_convert_session", {
			request: {
				...request,
				expectedSourceFence: request.expectedSourceFence ?? null,
				expectedConversationId: request.expectedConversationId ?? null,
				credentialId: request.credentialId ?? null,
				credentialDirectory: request.credentialDirectory ?? null,
				credentialGeneration: request.credentialGeneration ?? null,
			},
		}),
	/** 훅 4-state 보고를 hmux Host의 AgentStateReport 관측으로 전달한다.
	 *  실패(capability 없음·세션 없음·구식 백엔드)는 reject된다. */
	reportAgentState: (request: {
		sessionId: string;
		workspaceId?: string;
		activity: "working" | "waiting";
		attention: "none" | "input_required" | "approval_required" | "error";
		turnCompleted: boolean;
		turnCompletionId?: string;
		workingTtlMs?: number;
		expectedObservation?: {
			terminalEpoch: string;
			runtimeRevision: string;
			outputSequence: string;
		};
		conversationIdentity?: {
			providerId: Provider;
			conversationId: string;
			expectedFence?: {
				sessionId: string;
				workspaceId: string;
				runnerPrincipal: string;
				runnerInstance: string;
				channelEpoch: string;
				hostInstanceId: string;
				terminalEpoch: string;
			};
		};
	}) =>
		invoke<HmuxAgentStateReportReceipt>("hmux_report_agent_state", {
			request: {
				...request,
				workspaceId: request.workspaceId ?? null,
				turnCompletionId: request.turnCompletionId ?? null,
				workingTtlMs: request.workingTtlMs ?? null,
				conversationIdentity: request.conversationIdentity ?? null,
			},
		}),
	departPaneGracefully: (
		ownerId: string,
		sessionId: string,
		workspaceId: string,
	) =>
		invoke<HmuxPaneDepartureReceipt>("hmux_pane_depart_gracefully", {
			ownerId,
			sessionId,
			workspaceId,
		}),
	paneAttachmentStatus: (
		ownerId: string,
		sessionId: string,
		workspaceId: string,
	) =>
		invoke<HmuxPaneAttachmentStatus>("hmux_pane_attachment_status", {
			ownerId,
			sessionId,
			workspaceId,
		}),
};

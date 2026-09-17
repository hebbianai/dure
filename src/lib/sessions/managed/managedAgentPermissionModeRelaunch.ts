import { emit } from "@tauri-apps/api/event";
import type { HmuxSessionSummary } from "@/lib/ipc";
import {
	createDureWorkflowTransport,
	type DureWorkflowDispatchSessionTransport,
	type WorkflowDispatchSessionRebindReceiptV1,
} from "@/lib/ipc/dureWorkflow";
import { managedAgentDispatchHandoffJournal } from "@/lib/sessions/managed/managedAgentDispatchHandoff";
import {
	executeManagedAgentRehost,
	type ManagedAgentRehostExecution,
	type ManagedAgentRehostInspection,
	managedAgentRehostSyncPayload,
} from "@/lib/sessions/managed/managedAgentRehost";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	commitManagedAgentRehostReceipt,
	type ManagedAgentRehostCommitReceipt,
	type ManagedAgentRehostPaneReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";

export type AgentPermissionModeV1 = "default" | "skip_permissions";

export interface ManagedAgentPermissionModeRelaunchReceiptV1 {
	schema: "dure-agent-permission-mode-relaunch-v1";
	schemaVersion: 1;
	outcome: "relaunched";
	currentMode: AgentPermissionModeV1;
	targetMode: AgentPermissionModeV1;
	restartImpact: "provider_process_restarted";
	operationId: string;
	sourceSessionId: string;
	sourceWorkspaceId: string;
	targetSessionId: string;
	conversationId: string;
	replayed: boolean;
	dispatch: WorkflowDispatchSessionRebindReceiptV1;
}

export type ManagedAgentPermissionModeRelaunchResultV1 = {
	receipt: ManagedAgentPermissionModeRelaunchReceiptV1;
} & (
	| { presentation: "applied"; pane: ManagedAgentRehostPaneReceipt }
	| { presentation: "pending"; pane?: never }
);

export interface ManagedAgentPermissionModeRelaunchRuntime {
	rebindDispatchSession: DureWorkflowDispatchSessionTransport["rebindDispatchSession"];
	execute(
		inspection: ManagedAgentRehostInspection,
		options: {
			permissionMode: "default" | "bypass_approvals";
			beforeStop: () => Promise<void>;
		},
	): Promise<ManagedAgentRehostExecution>;
	syncPayload(
		inspection: ManagedAgentRehostInspection,
		execution: ManagedAgentRehostExecution,
	): ManagedAgentRehostSyncPayload;
	commitReceipt(
		payload: ManagedAgentRehostSyncPayload,
	): Promise<ManagedAgentRehostCommitReceipt | null>;
	emit: typeof emit;
	setMetadata(session: HmuxSessionSummary): void;
	now(): number;
}

export interface ManagedAgentPermissionModeRelaunchPreviewV1 {
	schema: "dure-agent-permission-mode-relaunch-v1";
	schemaVersion: 1;
	outcome: "preview";
	currentMode: AgentPermissionModeV1;
	targetMode: AgentPermissionModeV1;
	restartImpact: "provider_process_restarted";
	requiresConfirmation: true;
	sourceSessionId: string;
	sourceWorkspaceId: string;
	conversationId: string;
}

function externalPermissionMode(
	mode: "default" | "bypass_approvals",
): AgentPermissionModeV1 {
	return mode === "bypass_approvals" ? "skip_permissions" : "default";
}

function internalPermissionMode(
	mode: AgentPermissionModeV1,
): "default" | "bypass_approvals" {
	return mode === "skip_permissions" ? "bypass_approvals" : "default";
}

function assertPermissionModeChange(
	inspection: ManagedAgentRehostInspection,
	targetMode: AgentPermissionModeV1,
) {
	const currentMode = externalPermissionMode(inspection.permissionMode);
	if (targetMode !== "default" && targetMode !== "skip_permissions") {
		throw new PaneCommandError(
			"invalid_request",
			"permissionMode must be default or skip_permissions",
		);
	}
	if (currentMode === targetMode) {
		throw new PaneCommandError("invalid_request", "permission_mode_unchanged");
	}
	return currentMode;
}

export function managedAgentPermissionModeRelaunchPreview(
	inspection: ManagedAgentRehostInspection,
	targetMode: AgentPermissionModeV1,
): ManagedAgentPermissionModeRelaunchPreviewV1 {
	return {
		schema: "dure-agent-permission-mode-relaunch-v1",
		schemaVersion: 1,
		outcome: "preview",
		currentMode: assertPermissionModeChange(inspection, targetMode),
		targetMode,
		restartImpact: "provider_process_restarted",
		requiresConfirmation: true,
		sourceSessionId: inspection.sourceBinding.sessionId,
		sourceWorkspaceId: inspection.sourceBinding.workspaceId,
		conversationId: inspection.conversationId,
	};
}

const workflowTransport = createDureWorkflowTransport();
const defaultRuntime: ManagedAgentPermissionModeRelaunchRuntime = {
	rebindDispatchSession: (routeAuthority, request) =>
		workflowTransport.rebindDispatchSession(routeAuthority, request),
	execute: executeManagedAgentRehost,
	syncPayload: managedAgentRehostSyncPayload,
	commitReceipt: commitManagedAgentRehostReceipt,
	emit,
	setMetadata: (session) => useStore.getState().setHmuxSessionMetadata(session),
	now: Date.now,
};

export async function executeManagedAgentPermissionModeRelaunch(
	inspection: ManagedAgentRehostInspection,
	targetMode: AgentPermissionModeV1,
	runtime: ManagedAgentPermissionModeRelaunchRuntime = defaultRuntime,
): Promise<ManagedAgentPermissionModeRelaunchResultV1> {
	const execution = await runtime.execute(inspection, {
		permissionMode: internalPermissionMode(targetMode),
		beforeStop: async () => {
			assertPermissionModeChange(inspection, targetMode);
		},
	});
	const journal = managedAgentDispatchHandoffJournal(execution.recovery);
	const journalTargetMode = externalPermissionMode(
		execution.recovery.permissionMode,
	);
	if (journalTargetMode !== targetMode) {
		throw new PaneCommandError(
			"invalid_request",
			`journaled permission mode is ${journalTargetMode}, not ${targetMode}`,
		);
	}
	let dispatch = execution.dispatch;
	if (!dispatch) {
		if (!execution.recovery.backendRouteAuthority) {
			throw new PaneCommandError(
				"pane_changed",
				"permission relaunch lost its pre-stop backend route lease",
			);
		}
		dispatch = await runtime.rebindDispatchSession(
			execution.recovery.backendRouteAuthority,
			{
				schemaVersion: 1,
				operationId: journal.operationId,
				source: journal.source,
				target: journal.target,
				reboundAtMs: runtime.now(),
			},
		);
	}
	const payload = runtime.syncPayload(inspection, execution);
	const committed = await runtime.commitReceipt(payload);
	if (!committed) {
		throw new PaneCommandError(
			"pane_changed",
			`agent ${inspection.agentName} changed before permission-mode handoff`,
		);
	}
	runtime.setMetadata(execution.recovery.replacement);
	publishManagedAgentRehostProjection(committed.payload, runtime.emit);
	const receipt: ManagedAgentPermissionModeRelaunchReceiptV1 = {
		schema: "dure-agent-permission-mode-relaunch-v1",
		schemaVersion: 1,
		outcome: "relaunched",
		currentMode:
			journalTargetMode === "skip_permissions" ? "default" : "skip_permissions",
		targetMode: journalTargetMode,
		restartImpact: "provider_process_restarted",
		operationId: journal.operationId,
		sourceSessionId: journal.source.sessionId,
		sourceWorkspaceId: journal.source.workspaceId,
		targetSessionId: journal.target.sessionId,
		conversationId: execution.recovery.conversationId,
		replayed: execution.recovery.receipt.replayed,
		dispatch,
	};
	return committed.presentation === "applied"
		? { receipt, presentation: "applied", pane: committed.pane }
		: { receipt, presentation: "pending" };
}

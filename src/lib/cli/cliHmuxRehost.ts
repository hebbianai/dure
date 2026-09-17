import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import {
	completeManagedAgentFreshStart,
	executeManagedAgentFreshStart,
	inspectManagedAgentFreshStart,
} from "@/lib/sessions/managed/managedAgentFreshStart";
import {
	executeManagedAgentPermissionModeRelaunch,
	type ManagedAgentPermissionModeRelaunchReceiptV1,
	managedAgentPermissionModeRelaunchPreview,
} from "@/lib/sessions/managed/managedAgentPermissionModeRelaunch";
import { runManagedAgentRehostTransaction } from "@/lib/sessions/managed/managedAgentRehostTransaction";
import { inspectManagedAgentRecoveryRequest } from "@/lib/sessions/recovery/exitedManagedAgentRecovery";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";

export interface CliHmuxRehostRuntime {
	claim: typeof claimCliRequest;
	inspect: typeof inspectManagedAgentRecoveryRequest;
	rehost: typeof runManagedAgentRehostTransaction;
	permissionModeRelaunch: typeof executeManagedAgentPermissionModeRelaunch;
	inspectFresh: typeof inspectManagedAgentFreshStart;
	executeFresh: typeof executeManagedAgentFreshStart;
	completeFresh: typeof completeManagedAgentFreshStart;
}

const runtime: CliHmuxRehostRuntime = {
	claim: claimCliRequest,
	inspect: inspectManagedAgentRecoveryRequest,
	rehost: runManagedAgentRehostTransaction,
	permissionModeRelaunch: executeManagedAgentPermissionModeRelaunch,
	inspectFresh: inspectManagedAgentFreshStart,
	executeFresh: executeManagedAgentFreshStart,
	completeFresh: completeManagedAgentFreshStart,
};

export async function handleCliHmuxRehost(
	params: Record<string, unknown>,
	reqId: string,
	deps: CliHmuxRehostRuntime = runtime,
) {
	if (!(await deps.claim(reqId))) return null;
	try {
		const name = String(params.name ?? "").trim();
		if (!name) {
			throw new PaneCommandError("invalid_request", "name is required");
		}
		const targetPanelId =
			String(params.targetPanelId ?? "").trim() || undefined;
		const conversationId =
			String(params.conversationId ?? "").trim() || undefined;
		const existingSessionId = String(params.existingSessionId ?? "").trim();
		const operationId = String(params.operationId ?? "").trim();
		if (params.freshStart === true) {
			if (
				conversationId ||
				existingSessionId ||
				operationId ||
				params.permissionMode !== undefined
			) {
				throw new PaneCommandError(
					"invalid_request",
					"fresh managed replacement cannot select a conversation, writer, recovery operation, or permission-mode relaunch",
				);
			}
			if (params.confirmRestart !== true) {
				return {
					ok: false,
					error: {
						code: "update_requires_confirmation",
						message: `fresh-starting ${name} replaces its exact failed provider; pass --confirm-restart`,
					},
				};
			}
			const freshInspection = await deps.inspectFresh(name, targetPanelId);
			const execution = await deps.executeFresh(freshInspection);
			const committed = await deps.completeFresh(freshInspection, execution);
			return {
				ok: true,
				rehost: {
					action: execution.receipt.action,
					outcome: "rehosted_fresh",
					sourceSessionId: freshInspection.sourceBinding.sessionId,
					sourceWorkspaceId: freshInspection.sourceBinding.workspaceId,
					targetBuildId: execution.receipt.targetBuildId,
					replayed: execution.receipt.replayed,
					replacementSession: execution.replacement,
					presentation: committed.presentation,
				},
				...(committed.presentation === "applied"
					? { pane: committed.pane }
					: {}),
			};
		}
		if (params.permissionMode !== undefined) {
			if (existingSessionId || operationId) {
				throw new PaneCommandError(
					"invalid_request",
					"permission-mode relaunch cannot select an existing writer or recovery operation",
				);
			}
			const inspection = await deps.inspect(
				name,
				targetPanelId,
				conversationId,
			);
			const permissionMode = String(params.permissionMode).trim();
			if (
				permissionMode !== "default" &&
				permissionMode !== "skip_permissions"
			) {
				throw new PaneCommandError(
					"invalid_request",
					"permissionMode must be default or skip_permissions",
				);
			}
			const preview = managedAgentPermissionModeRelaunchPreview(
				inspection,
				permissionMode,
			);
			if (params.confirmRestart !== true) {
				return {
					ok: false,
					error: {
						code: "update_requires_confirmation",
						message: `changing ${name} permission mode restarts its exact live provider; pass --confirm-restart`,
					},
					permissionModeRelaunch: preview,
				};
			}
			const result = await deps.permissionModeRelaunch(
				inspection,
				permissionMode,
			);
			const permissionModeRelaunch: ManagedAgentPermissionModeRelaunchReceiptV1 =
				result.receipt;
			return {
				ok: true,
				permissionModeRelaunch,
				presentation: result.presentation,
				...(result.presentation === "applied" ? { pane: result.pane } : {}),
			};
		}
		if (existingSessionId && operationId) {
			throw new PaneCommandError(
				"invalid_request",
				"existing managed writer handoff cannot also select a recovery operation",
			);
		}
		if (existingSessionId) {
			throw new PaneCommandError(
				"invalid_request",
				"an arbitrary existing writer has no durable source-to-target operation; use operationId",
			);
		}
		const transaction = await deps.rehost({
			name,
			confirmed: params.confirmRestart === true,
			...(targetPanelId ? { panelId: targetPanelId } : {}),
			...(conversationId ? { conversationId } : {}),
			...(operationId ? { operationId } : {}),
		});
		if (transaction.state === "confirmation_required") {
			return {
				ok: false,
				error: {
					code: "update_requires_confirmation",
					message: `rehosting ${name} restarts its exact live provider; pass --confirm-restart`,
				},
				rehost: transaction.rehost,
			};
		}
		return {
			ok: true,
			rehost: transaction.rehost,
			...(transaction.pane ? { pane: transaction.pane } : {}),
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code:
					error instanceof PaneCommandError
						? error.code
						: "hmux_managed_rehost_failed",
				message: `${error instanceof Error ? error.message : String(error)}; the same command can safely retry the exact stop, replacement receipt, and pane handoff`,
			},
		};
	}
}

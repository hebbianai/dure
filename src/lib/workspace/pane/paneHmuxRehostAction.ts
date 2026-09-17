import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { isHmuxProviderSessionSourceBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import { tryUpgradeManagedHmuxShell } from "@/lib/hmux/managed/managedHmuxShellUpgrade";
import {
	commitPreparedHmuxSessionConversion,
	prepareHmuxSessionConversion,
} from "@/lib/hmux/conversion/hmuxSessionConversionWorkflow";
import {
	executeStandaloneHmuxRecovery,
	inspectStandaloneHmuxRecovery,
} from "@/lib/hmux/standalone/standaloneHmuxRecovery";
import { executeManagedBindingRecovery } from "@/lib/sessions/managed/managedAgentRecoveryReceipt";
import {
	hmuxManagedBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";

export type LocalHmuxRehostWorkflow = "managed" | "standalone";

/**
 * Classifies the mounted workflow that owns a local Hmux pane's rehost action.
 *
 * `hmux_session_v1` is a read-only/legacy observer binding, but its source
 * identity still belongs to a standalone session. The standalone pane-set
 * recovery inspector promotes and re-fences that identity after the user
 * clicks, so presentation must not hide the action based on the binding shape.
 */
export function localHmuxRehostWorkflow(
	binding: TerminalPaneBindingV1 | undefined,
): LocalHmuxRehostWorkflow | undefined {
	if (binding?.source !== "local") return undefined;
	if (binding.runtime === "hmux_managed_v1") return "managed";
	if (
		binding.runtime === "hmux_standalone_v1" ||
		binding.runtime === "hmux_session_v1"
	) {
		return "standalone";
	}
	return undefined;
}

export interface LocalHmuxPaneParameters {
	sessionId?: string;
	cwd?: string;
	binding?: TerminalPaneBindingV1;
}

interface LocalHmuxPaneRehostContext {
	panelId: string;
	component: string;
	binding: TerminalPaneBindingV1;
	readParameters: () => LocalHmuxPaneParameters;
	persistParameters: (next: LocalHmuxPaneParameters) => boolean;
}

/** Executes the one local pane-owned rehost path selected by PaneChrome. */
export async function executeLocalHmuxPaneRehost({
	panelId,
	component,
	binding,
	readParameters,
	persistParameters,
}: LocalHmuxPaneRehostContext): Promise<void> {
	const workflow = localHmuxRehostWorkflow(binding);
	if (workflow === "standalone") {
		const inspection = await inspectStandaloneHmuxRecovery(panelId);
		if (!inspection) throw new Error("standalone Hmux pane is not rehostable");
		await executeStandaloneHmuxRecovery(inspection);
		return;
	}
	if (
		workflow !== "managed" ||
		binding.runtime !== "hmux_managed_v1" ||
		binding.source !== "local"
	) {
		throw new Error("local Hmux pane is not rehostable");
	}
	const state = useStore.getState();
	const detectedProvider =
		state.agents.find((agent) => agent.sessionId === binding.sessionId)?.provider ??
		state.sessionAgentPin[binding.sessionId] ??
		state.sessionAgent[binding.sessionId];
	if (
		detectedProvider &&
		isHmuxProviderSessionSourceBinding(binding, component)
	) {
		const prepared = await prepareHmuxSessionConversion({
			sourceSessionId: binding.sessionId,
			sourceWorkspaceId: binding.workspaceId,
			panelId,
			target: "managed",
		});
		await commitPreparedHmuxSessionConversion(prepared);
		return;
	}
	const managedShell = await tryUpgradeManagedHmuxShell(
		{ targetPanelId: panelId, confirmRestart: true, forceRestart: true },
		async () => true,
	);
	if (managedShell) return;

	const recovery = await executeManagedBindingRecovery(binding);
	if (!recovery.replacement.stopFence) {
		throw new Error("managed recovery replacement has no stop fence");
	}
	const target = {
		...hmuxManagedBinding(
			recovery.replacement.sessionId,
			recovery.replacement.workspaceId,
			recovery.credentialId,
			undefined,
			recovery.replacement.stopFence,
			binding.backendProfileId,
		),
		createIdempotencyKey: recovery.createIdempotencyKey,
	};
	const current = readParameters();
	const currentBinding = current.binding;
	if (
		currentBinding?.runtime !== "hmux_managed_v1" ||
		currentBinding.source !== "local"
	) {
		return;
	}
	const sourceStillApplied =
		currentBinding.sessionId === binding.sessionId &&
		currentBinding.workspaceId === binding.workspaceId;
	const targetAlreadyApplied =
		currentBinding.sessionId === target.sessionId &&
		currentBinding.workspaceId === target.workspaceId &&
		currentBinding.createIdempotencyKey === target.createIdempotencyKey &&
		currentBinding.credentialId === target.credentialId &&
		sameHmuxManagedGeneration(currentBinding.stopFence, target.stopFence);
	if (!sourceStillApplied && !targetAlreadyApplied) return;
	if (sourceStillApplied) {
		const committed = persistParameters({
			...current,
			sessionId: target.sessionId,
			binding: target,
		});
		if (committed) {
			useStore.setState((state) => {
				const sessionCwd = { ...state.sessionCwd };
				const cwd = sessionCwd[binding.sessionId] ?? current.cwd;
				delete sessionCwd[binding.sessionId];
				if (cwd) sessionCwd[target.sessionId] = cwd;
				return { sessionCwd };
			});
		}
	}
	useStore.getState().setHmuxSessionMetadata(recovery.replacement);
}

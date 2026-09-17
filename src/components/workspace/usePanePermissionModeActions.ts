import { useCallback, useRef, useState } from "react";
import { useNamedPaneAction } from "@/components/workspace/useNamedPaneAction";
import { agentRuntimePaneActionOwnerKey } from "@/lib/agents/agentRuntimePaneAction";
import {
	type AgentPermissionModeV1,
	executeManagedAgentPermissionModeRelaunch,
	type ManagedAgentPermissionModeRelaunchResultV1,
} from "@/lib/sessions/managed/managedAgentPermissionModeRelaunch";
import {
	inspectManagedAgentRehost,
	type ManagedAgentRehostInspection,
} from "@/lib/sessions/managed/managedAgentRehost";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { PROVIDERS, type Agent } from "@/types";

/** Registers the pane menu's permission relaunch as target-qualified actions.
 * The dialog and external transports share this exact execution lock and
 * handler; only the external path performs its own action-time inspection. */
export function usePanePermissionModeActions({
	agent,
	binding,
	paneId,
}: {
	agent: Agent | undefined;
	binding: TerminalPaneBindingV1 | undefined;
	paneId: string;
}) {
	const [permissionModeBusy, setPermissionModeBusy] = useState(false);
	const busyRef = useRef(false);
	const permissionModeAvailable = Boolean(
		agent &&
			binding?.runtime === "hmux_managed_v1" &&
			binding.source === "local" &&
			agent.runtimeBinding?.runtime === "hmux_managed_v1" &&
			agent.runtimeBinding.source === "local" &&
			agent.runtimeBinding.sessionId === binding.sessionId &&
			agent.runtimeBinding.workspaceId === binding.workspaceId,
	);

	const executePermissionMode = useCallback(
		async (
			inspection: ManagedAgentRehostInspection | undefined,
			targetMode: AgentPermissionModeV1,
		): Promise<ManagedAgentPermissionModeRelaunchResultV1> => {
			if (!permissionModeAvailable || !agent) {
				throw new Error("permission mode action is unavailable");
			}
			if (busyRef.current) {
				throw new Error("permission mode action is already running");
			}
			busyRef.current = true;
			setPermissionModeBusy(true);
			try {
				const current =
					inspection ?? (await inspectManagedAgentRehost(agent.id, paneId));
				return await executeManagedAgentPermissionModeRelaunch(
					current,
					targetMode,
				);
			} finally {
				busyRef.current = false;
				setPermissionModeBusy(false);
			}
		},
		[agent, paneId, permissionModeAvailable],
	);

	const ownerKey = agent ? agentRuntimePaneActionOwnerKey(agent) : undefined;
	useNamedPaneAction(
		paneId,
		"permission_mode:default",
		permissionModeAvailable,
		() => executePermissionMode(undefined, "default"),
		ownerKey,
	);
	useNamedPaneAction(
		paneId,
		"permission_mode:skip_permissions",
		permissionModeAvailable &&
			Boolean(agent && PROVIDERS[agent.provider].skipPermFlag),
		() => executePermissionMode(undefined, "skip_permissions"),
		ownerKey,
	);

	return {
		permissionModeAvailable,
		permissionModeBusy,
		executePermissionMode,
	};
}

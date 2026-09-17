// ManagedAgentRecoveryBar's designated store-wiring point (cluster wiring
// hook). Every global-store subscription the recovery bar needs lives here;
// the component consumes the returned values and keeps rendering only. Saved
// conversation peers follow Agent registration changes, independently of the
// more frequent activity and runtime metadata observations.
import { useMemo } from "react";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { conversationRegistrationPeers } from "@/lib/sessions/recovery/conversationRegistrationPeers";
import { useHmuxPaneHealthPresentation } from "@/lib/terminal/hmuxPaneHealthStore";
import type { HmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import { useStore } from "@/store";

export function useManagedAgentRecoveryBarState({
	agentId,
	panelId,
	binding,
}: {
	agentId: string;
	panelId: string;
	binding: HmuxManagedPaneBindingV1 | undefined;
}) {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const paneHealth = useHmuxPaneHealthPresentation(
		hmuxPaneHealthId(desktopId, panelId),
	);
	const agents = useStore((state) => state.agents);
	const agent = agents.find((candidate) => candidate.id === agentId);
	const conversationPeers = useMemo(
		() => conversationRegistrationPeers(agents, agentId),
		[agents, agentId],
	);
	const metadata = useStore((state) =>
		binding
			? state.hmuxSessionMetadata[
					hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)
				]
			: undefined,
	);
	const activity = useStore(
		(state) => state.agentActivity[agentId] ?? "connecting",
	);
	const accounts = useStore((state) => state.accounts);
	return {
		agent,
		metadata,
		paneHealth,
		activity,
		accounts,
		conversationPeers,
	};
}

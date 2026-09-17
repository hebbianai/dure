import type { AgentRunPresentationWorktree } from "@/lib/agents/agentRunWorkspacePresentation";
import { projectionInput } from "@/lib/cli/managedRunBackgroundPresentation";
import type { CliManagedRunPresentationRequest } from "@/lib/cli/managedRunPresentationModel";
import type { DureNativeAgentRunResultV1 } from "@/lib/ipc/dureAgentRun";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";

export type LocalAgentRunPresentationRequest =
	CliManagedRunPresentationRequest & {
		panePosition?: PanelPosition;
		presentationWorktree: AgentRunPresentationWorktree;
	};

export function localAgentRunPresentationRequest(
	run: DureNativeAgentRunResultV1,
	target: {
		projectPath: string;
		presentationWorktree: AgentRunPresentationWorktree;
		spaceId: string;
		windowLabel: string;
		referencePanelId?: string;
		position?: PanelPosition;
	},
): LocalAgentRunPresentationRequest {
	return {
		...projectionInput(run, target.projectPath),
		presentationWorktree: target.presentationWorktree,
		spaceId: target.spaceId,
		windowLabel: target.windowLabel,
		...(target.referencePanelId
			? { referencePanelId: target.referencePanelId }
			: {}),
		...(target.position ? { panePosition: target.position } : {}),
	};
}

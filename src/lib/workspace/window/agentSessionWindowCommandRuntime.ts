import { appendAgentChatDraft } from "@/lib/agents/chat/agentChatDraftInput";
import { recoverAgentChatDraftMove } from "@/lib/agents/chat/agentChatDraftMoveRecovery";
import { executeAgentChatDraftMove } from "@/lib/agents/chat/agentChatDraftMoveRuntime";
import {
	executeDestinationChatPaneDrop,
	executeSourceChatPaneMove,
} from "@/lib/agents/chat/agentChatPaneDrop";
import { t } from "@/lib/i18n";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import { openAgentPanel } from "@/lib/workspace/dock";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import {
	getDockview,
	waitForDesktopDockview,
} from "@/lib/workspace/dock/dockRegistry";
import {
	isMountedPaneOwned,
	paneAgentId,
} from "@/lib/workspace/pane/paneOwnership";
import { useStore } from "@/store";
import type { Agent } from "@/types";
import type {
	AgentSessionWindowCommandExecution,
	AgentSessionWindowCommandResult,
} from "./agentSessionWindowCommand";
import { activateLargeViewSourcePane } from "./largeViewSourcePane";
import { revalidateMountedPaneWindow } from "./mountedPaneWindow";

interface AgentSessionWindowPresentationState {
	readonly agents: readonly Agent[];
}

export interface AgentSessionWindowCommandRuntime {
	reconcile(desktopId: string): Promise<void>;
	readState(): AgentSessionWindowPresentationState;
	readPaneAgentId(desktopId: string, panelId: string): string | undefined;
	activateSourcePane(desktopId: string, panelId: string): boolean;
	ownsMountedPane(desktopId: string, panelId: string): boolean;
	ownsMountedAgentPane(desktopId: string, agentId: string): boolean;
	waitForDesktop(desktopId: string): Promise<boolean>;
	presentAgent(desktopId: string, agent: Agent): boolean;
}

const runtime: AgentSessionWindowCommandRuntime = {
	reconcile: async (desktopId) => {
		const recovered = await recoverCurrentDurableStoreProjection({
			forceProjection: true,
			requiredProjectionDesktopId: desktopId,
		});
		if (!recovered) throw forkPresentationFailure();
	},
	readState: () => useStore.getState(),
	readPaneAgentId: (desktopId, panelId) => paneAgentId({ desktopId, panelId }),
	activateSourcePane: (desktopId, panelId) =>
		activateLargeViewSourcePane({ desktopId, panelId }),
	ownsMountedPane: (desktopId, panelId) =>
		isMountedPaneOwned({ desktopId, panelId }),
	ownsMountedAgentPane: (desktopId, agentId) => {
		const api = getDockview(desktopId);
		const pane = api && findAgentPanel(api, agentId);
		return Boolean(pane && isMountedPaneOwned({ desktopId, panelId: pane.id }));
	},
	waitForDesktop: async (desktopId) =>
		Boolean(await waitForDesktopDockview(desktopId)),
	presentAgent: (desktopId, agent) => Boolean(openAgentPanel(desktopId, agent)),
};

function forkPresentationFailure(): Error {
	return new Error(t("workspace.agentWindow.forkPresentationFailed"));
}

function requireSourceAgent(
	command: Pick<
		AgentSessionWindowCommandExecution,
		"desktopId" | "panelId" | "agentId" | "action"
	>,
	presentationRuntime: AgentSessionWindowCommandRuntime,
): void {
	if (
		presentationRuntime.readPaneAgentId(command.desktopId, command.panelId) !==
		command.agentId
	) {
		throw new Error(
			command.action === "present_fork"
				? "fork presentation source Agent mismatch"
				: "credential command source Agent mismatch",
		);
	}
}

/** Executes a command inside the window that owns its selected pane. */
export async function executeAgentSessionWindowCommand(
	command: AgentSessionWindowCommandExecution,
	presentationRuntime: AgentSessionWindowCommandRuntime = runtime,
): Promise<AgentSessionWindowCommandResult> {
	if (command.action === "recover_chat_draft") {
		if (
			command.transfer.source.desktopId !== command.desktopId ||
			command.transfer.source.paneId !== command.panelId
		)
			throw new Error("The draft recovery source is inconsistent.");
		return recoverAgentChatDraftMove(command);
	}
	if (command.action === "move_chat_pane") {
		if (
			command.source.desktopId !== command.desktopId ||
			command.source.paneId !== command.panelId
		)
			throw new Error("The chat move source is inconsistent.");
		return executeSourceChatPaneMove(command);
	}
	if (command.action === "drop_chat_pane") {
		if (
			command.transfer.destination.desktopId !== command.desktopId ||
			command.transfer.source.paneId !== command.panelId
		)
			throw new Error("The chat drop destination is inconsistent.");
		return executeDestinationChatPaneDrop(command);
	}
	if (command.action === "draft_move") {
		if (
			command.transfer.destination.desktopId !== command.desktopId ||
			command.transfer.source.paneId !== command.panelId
		)
			throw new Error("The chat draft destination is inconsistent.");
		return executeAgentChatDraftMove(command);
	}
	if (command.action === "append_draft") {
		if (
			command.owner.desktopId !== command.desktopId ||
			command.owner.paneId !== command.panelId ||
			command.target.identity.agentId !== command.agentId
		) {
			throw new Error("The chat draft pane identity is inconsistent.");
		}
		revalidateMountedPaneWindow(command.owner);
		appendAgentChatDraft(command.target, command.text, command.attachments, {
			desktopId: command.desktopId,
			panelId: command.panelId,
		});
		return { kind: "drafted" };
	}
	if (command.action === "present_fork") {
		await presentationRuntime.reconcile(command.desktopId);
		requireSourceAgent(command, presentationRuntime);
		if (
			!presentationRuntime.activateSourcePane(
				command.desktopId,
				command.panelId,
			)
		) {
			throw forkPresentationFailure();
		}
		if (!(await presentationRuntime.waitForDesktop(command.desktopId))) {
			throw forkPresentationFailure();
		}
		requireSourceAgent(command, presentationRuntime);
		if (
			!presentationRuntime.activateSourcePane(
				command.desktopId,
				command.panelId,
			)
		) {
			throw forkPresentationFailure();
		}
		const forkedAgent = presentationRuntime
			.readState()
			.agents.find((candidate) => candidate.id === command.forkedAgentId);
		if (
			!forkedAgent ||
			!presentationRuntime.presentAgent(command.desktopId, forkedAgent)
		) {
			throw forkPresentationFailure();
		}
		await presentationRuntime.reconcile(command.desktopId);
		requireSourceAgent(command, presentationRuntime);
		if (
			!presentationRuntime.ownsMountedPane(
				command.desktopId,
				command.panelId,
			) ||
			!presentationRuntime.ownsMountedAgentPane(
				command.desktopId,
				forkedAgent.id,
			)
		) {
			throw forkPresentationFailure();
		}
		return { kind: "presented" };
	}

	if (command.action === "switch") {
		const credentialTransition = await import(
			"@/lib/agents/agentCredentialTransition"
		);
		requireSourceAgent(command, presentationRuntime);
		return credentialTransition.requestAgentCredentialTransition({
			agentId: command.agentId,
			targetCredentialId: command.targetCredentialId,
			sourcePanelId: command.panelId,
		});
	}

	const credentialRuntime = await import(
		"@/lib/sessions/credentials/deferredCredentialSwitchRuntime"
	);
	requireSourceAgent(command, presentationRuntime);
	if (command.action === "apply_pending") {
		await credentialRuntime.applyDeferredCredentialSwitchNow(command.agentId);
		return { kind: "applied" };
	}
	return {
		kind: "cancelled",
		cancelled: credentialRuntime.cancelDeferredCredentialSwitch(
			command.agentId,
		),
	};
}

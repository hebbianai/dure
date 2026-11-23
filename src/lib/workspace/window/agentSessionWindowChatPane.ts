import {
	parseStructuredAgentPaneCommand,
	parseStructuredAgentPaneCommandOutcome,
	parseStructuredAgentPanePresentation,
	type StructuredAgentPaneCommand,
	type StructuredAgentPaneCommandOutcome,
	type StructuredAgentPanePresentationV1,
	type StructuredAgentPaneSurface,
} from "@/lib/agents/chat/structuredAgentPaneSurface";
import {
	type AgentSessionPaneChannelBackend,
	type AgentSessionPaneChannelCommand,
	type AgentSessionPaneChannelMirror,
	type AgentSessionPaneChannelPublication,
	type AgentSessionPaneChannelResult,
	createAgentSessionPaneChannel,
} from "./agentSessionWindowPaneChannel";

/** A Chat pane's toolbar, recovery and new-conversation steps, sent by its
 * Agent's large window to the window that owns the pane. */
export type AgentSessionChatPaneCommand = AgentSessionPaneChannelCommand<
	"chat_pane",
	StructuredAgentPaneCommand
>;

export type AgentSessionChatPaneResult = AgentSessionPaneChannelResult<
	"chat_pane",
	StructuredAgentPanePresentationV1,
	StructuredAgentPaneCommandOutcome
>;

export type AgentSessionChatPaneMirror = AgentSessionPaneChannelMirror<
	StructuredAgentPanePresentationV1,
	StructuredAgentPaneCommand,
	StructuredAgentPaneCommandOutcome
>;

export type AgentSessionChatPanePublication =
	AgentSessionPaneChannelPublication<StructuredAgentPaneSurface>;

const channel = createAgentSessionPaneChannel<
	"chat_pane",
	StructuredAgentPanePresentationV1,
	StructuredAgentPaneCommand,
	StructuredAgentPaneCommandOutcome
>({
	action: "chat_pane",
	event: "dure://agent-session/chat-pane",
	parsePresentation: parseStructuredAgentPanePresentation,
	parseCommand: parseStructuredAgentPaneCommand,
	parseOutcome: parseStructuredAgentPaneCommandOutcome,
	unavailableCode: "client_chat_pane_unavailable",
	invalidCommand: "The chat pane command is invalid.",
	receiptInvalid: "The chat pane receipt is invalid; the outcome is uncertain.",
});

export const agentSessionChatPaneStepValid = channel.stepValid;
export const agentSessionChatPaneStep = channel.step;
export const executeAgentSessionChatPaneStep = channel.execute;

/** Publishes a Chat pane's surface to the large window that shows the pane.
 * The pane keeps owning it; the large window sends its commands back. */
export function publishAgentSessionChatPane(
	paneId: string,
	initial: StructuredAgentPaneSurface,
	transport?: AgentSessionPaneChannelBackend,
): AgentSessionChatPanePublication {
	return channel.publish(paneId, initial, transport);
}

export function agentSessionChatPaneMirror(
	source: { sourceWindowLabel: string; paneId: string },
	send: (
		command: AgentSessionChatPaneCommand,
	) => Promise<{ readonly kind: string }>,
	transport?: AgentSessionPaneChannelBackend,
): AgentSessionChatPaneMirror {
	return channel.mirror(source, send, transport);
}

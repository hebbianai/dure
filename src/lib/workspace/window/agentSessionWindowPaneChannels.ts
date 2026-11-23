import {
	type AgentSessionChatPaneCommand,
	agentSessionChatPaneStep,
	agentSessionChatPaneStepValid,
} from "./agentSessionWindowChatPane";
import {
	type AgentSessionLaunchSelectionCommand,
	agentSessionLaunchSelectionStep,
	agentSessionLaunchSelectionStepValid,
} from "./agentSessionWindowLaunchSelection";

/** A step on one of the surfaces a source pane publishes and its Agent's
 * large window mirrors: the launch pills, or a Chat pane's toolbar. */
export type AgentSessionPaneChannelStep =
	| AgentSessionLaunchSelectionCommand
	| AgentSessionChatPaneCommand;

type PaneChannelAction = AgentSessionPaneChannelStep["action"];

const CHANNELS: Record<
	PaneChannelAction,
	{
		valid(payload: Record<string, unknown>): boolean;
		step(command: AgentSessionPaneChannelStep): AgentSessionPaneChannelStep;
	}
> = {
	launch_selection: {
		valid: agentSessionLaunchSelectionStepValid,
		step: (command) =>
			agentSessionLaunchSelectionStep(
				command as AgentSessionLaunchSelectionCommand,
			),
	},
	chat_pane: {
		valid: agentSessionChatPaneStepValid,
		step: (command) =>
			agentSessionChatPaneStep(command as AgentSessionChatPaneCommand),
	},
};

export function isAgentSessionPaneChannelAction(
	action: unknown,
): action is PaneChannelAction {
	return action === "launch_selection" || action === "chat_pane";
}

/** Whether an untrusted bridge payload is a well-formed step of its channel. */
export function agentSessionPaneChannelStepValid(
	payload: Record<string, unknown> & { action: PaneChannelAction },
): boolean {
	return CHANNELS[payload.action].valid(payload);
}

/** Only the fields the step's channel defines reach the source pane. */
export function agentSessionPaneChannelStep(
	command: AgentSessionPaneChannelStep,
): AgentSessionPaneChannelStep {
	return CHANNELS[command.action].step(command);
}

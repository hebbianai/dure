import {
	type AgentLaunchSelectionCommand,
	type AgentLaunchSelectionPresentationV1,
	type AgentLaunchSelectionSurface,
	parseAgentLaunchSelectionCommand,
	parseAgentLaunchSelectionPresentation,
} from "@/lib/agents/agentLaunchSelectionSurface";
import {
	type AgentSessionPaneChannelBackend,
	type AgentSessionPaneChannelCommand,
	type AgentSessionPaneChannelMirror,
	type AgentSessionPaneChannelPublication,
	type AgentSessionPaneChannelResult,
	createAgentSessionPaneChannel,
} from "./agentSessionWindowPaneChannel";

/** The launch pills' steps, sent by a large window to the window that owns
 * its source pane. `watch` asks for the pane's presentation now and on every
 * change until `unwatch`; `run` runs one pill command there. */
export type AgentSessionLaunchSelectionCommand = AgentSessionPaneChannelCommand<
	"launch_selection",
	AgentLaunchSelectionCommand
>;

export type AgentSessionLaunchSelectionResult = AgentSessionPaneChannelResult<
	"launch_selection",
	AgentLaunchSelectionPresentationV1
>;

export type AgentSessionLaunchSelectionBackend = AgentSessionPaneChannelBackend;
export type AgentSessionLaunchSelectionPublication =
	AgentSessionPaneChannelPublication<AgentLaunchSelectionSurface>;
export type AgentSessionLaunchSelectionMirror = AgentSessionPaneChannelMirror<
	AgentLaunchSelectionPresentationV1,
	AgentLaunchSelectionCommand,
	void
>;

const channel = createAgentSessionPaneChannel<
	"launch_selection",
	AgentLaunchSelectionPresentationV1,
	AgentLaunchSelectionCommand
>({
	action: "launch_selection",
	event: "dure://agent-session/launch-selection",
	parsePresentation: parseAgentLaunchSelectionPresentation,
	parseCommand: parseAgentLaunchSelectionCommand,
	unavailableCode: "client_launch_selection_unavailable",
	invalidCommand: "The launch selection command is invalid.",
	receiptInvalid:
		"The launch selection receipt is invalid; the outcome is uncertain.",
});

/** Whether an untrusted bridge payload is a well-formed launch pill step. */
export const agentSessionLaunchSelectionStepValid = channel.stepValid;

/** Only the fields a launch pill step defines; nothing else the sender put on
 * the payload reaches the source window's executor. */
export const agentSessionLaunchSelectionStep = channel.step;

/** Publishes a pane's launch pills to the large window that shows the pane.
 * The pane keeps owning them: the large window renders the presentation
 * published here and sends its commands back to run on `surface.run`. */
export function publishAgentSessionLaunchSelection(
	paneId: string,
	initial: AgentLaunchSelectionSurface,
	transport?: AgentSessionLaunchSelectionBackend,
): AgentSessionLaunchSelectionPublication {
	return channel.publish(paneId, initial, transport);
}

/** Runs one launch pill step inside the window that owns the source pane. */
export const executeAgentSessionLaunchSelectionStep = channel.execute;

/** A large window's view of its source pane's launch pills. `send` delivers
 * each step to the window that owns the source pane; presentations arrive
 * from there in sequence, and an older one never replaces a newer one. */
export function agentSessionLaunchSelectionMirror(
	source: { sourceWindowLabel: string; paneId: string },
	send: (
		command: AgentSessionLaunchSelectionCommand,
	) => Promise<{ readonly kind: string }>,
	transport?: AgentSessionLaunchSelectionBackend,
): AgentSessionLaunchSelectionMirror {
	return channel.mirror(source, send, transport);
}

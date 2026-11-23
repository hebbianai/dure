import {
	type AgentSessionWindowCommandBackend,
	type AgentSessionWindowRoute,
	requestAgentSessionPaneChannelStep,
} from "./agentSessionWindowCommand";
import {
	type AgentSessionChatPaneMirror,
	agentSessionChatPaneMirror,
} from "./agentSessionWindowChatPane";
import {
	type AgentSessionLaunchSelectionMirror,
	agentSessionLaunchSelectionMirror,
} from "./agentSessionWindowLaunchSelection";
import type { AgentSessionPaneChannelStep } from "./agentSessionWindowPaneChannels";
import { parseLargeViewSourcePaneOwnerId } from "./largeViewReturnSourceCoordinator";

/** A large window's view of a surface its source pane publishes, followed as
 * it changes, with every command run in the window that owns the source pane.
 * Undefined while the window does not know its source pane. */
function sourcePaneMirror<Command extends AgentSessionPaneChannelStep, Mirror>(
	route: AgentSessionWindowRoute,
	mirror: (
		source: { sourceWindowLabel: string; paneId: string },
		send: (command: Command) => Promise<{ readonly kind: string }>,
	) => Mirror,
	transport?: AgentSessionWindowCommandBackend,
): Mirror | undefined {
	const source = route.sourcePaneOwnerId
		? parseLargeViewSourcePaneOwnerId(route.sourcePaneOwnerId)
		: undefined;
	if (!source) return undefined;
	return mirror(
		{ sourceWindowLabel: route.sourceWindowLabel, paneId: source.panelId },
		(command) => requestAgentSessionPaneChannelStep(route, command, transport),
	);
}

/** A large window's launch pills: the source pane's presentation, followed as
 * it changes, and every pill command run in the window that owns the pane. */
export function agentSessionWindowLaunchSelection(
	route: AgentSessionWindowRoute,
	transport?: AgentSessionWindowCommandBackend,
): AgentSessionLaunchSelectionMirror | undefined {
	return sourcePaneMirror(route, agentSessionLaunchSelectionMirror, transport);
}

/** A large window's Chat pane: the source Chat pane's toolbar, recovery and
 * new-conversation state, with every command run on that pane's handlers. */
export function agentSessionWindowChatPane(
	route: AgentSessionWindowRoute,
	transport?: AgentSessionWindowCommandBackend,
): AgentSessionChatPaneMirror | undefined {
	return sourcePaneMirror(route, agentSessionChatPaneMirror, transport);
}

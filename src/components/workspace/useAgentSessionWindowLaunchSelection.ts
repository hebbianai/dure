import { useMemo, useState } from "react";
import {
	useAgentSessionPaneMirror,
	useAgentSessionPanePublication,
} from "@/components/workspace/useAgentSessionPaneChannel";
import type { AgentLaunchSelectionSurface } from "@/lib/agents/agentLaunchSelectionSurface";
import {
	type AgentRuntimeLaunchFailure,
	agentRuntimeLaunchFailure,
} from "@/lib/agents/agentRuntimeLaunchSelection";
import type { AgentSessionWindowRoute } from "@/lib/workspace/window/agentSessionWindowCommand";
import { publishAgentSessionLaunchSelection } from "@/lib/workspace/window/agentSessionWindowLaunchSelection";
import { agentSessionWindowLaunchSelection } from "@/lib/workspace/window/agentSessionWindowPaneMirrors";

/** Source pane side: publishes the launch pills this pane owns to the large
 * window that shows the pane, for as long as the pane is mounted. */
export function useAgentSessionLaunchSelectionPublication(
	paneId: string,
	surface: AgentLaunchSelectionSurface | undefined,
): void {
	useAgentSessionPanePublication(
		paneId,
		surface,
		publishAgentSessionLaunchSelection,
	);
}

/** Large window side: the source pane's launch pills. The presentation is
 * the one the source pane publishes, and every command runs there. Only a
 * command this window could not deliver is reported here. */
export function useAgentSessionWindowLaunchSelection(
	route: AgentSessionWindowRoute,
): AgentLaunchSelectionSurface | undefined {
	const { agentId, sourceWindowLabel, sourcePaneOwnerId } = route;
	const mirror = useMemo(
		() =>
			agentSessionWindowLaunchSelection({
				agentId,
				sourceWindowLabel,
				...(sourcePaneOwnerId ? { sourcePaneOwnerId } : {}),
			}),
		[agentId, sourceWindowLabel, sourcePaneOwnerId],
	);
	const presentation = useAgentSessionPaneMirror(mirror);
	const [undelivered, setUndelivered] = useState<{
		mirror: typeof mirror;
		failure: AgentRuntimeLaunchFailure;
	}>();
	if (!mirror || !presentation) return undefined;
	const failure =
		undelivered && undelivered.mirror === mirror
			? undelivered.failure
			: undefined;
	return {
		presentation: failure
			? {
					...presentation,
					error: failure.detail,
					errorMessage: failure.message,
				}
			: presentation,
		run: async (command) => {
			if (command.kind === "dismiss_error" && failure) {
				setUndelivered(undefined);
				return;
			}
			setUndelivered(undefined);
			try {
				await mirror.run(command);
			} catch (error) {
				setUndelivered({ mirror, failure: agentRuntimeLaunchFailure(error) });
			}
		},
	};
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	AgentLaunchSelectionPresentationV1,
	AgentLaunchSelectionSurface,
} from "@/lib/agents/agentLaunchSelectionSurface";
import {
	type AgentRuntimeLaunchFailure,
	agentRuntimeLaunchFailure,
} from "@/lib/agents/agentRuntimeLaunchSelection";
import {
	type AgentSessionWindowRoute,
	agentSessionWindowLaunchSelection,
} from "@/lib/workspace/window/agentSessionWindowCommand";
import {
	type AgentSessionLaunchSelectionPublication,
	publishAgentSessionLaunchSelection,
} from "@/lib/workspace/window/agentSessionWindowLaunchSelection";

/** Source pane side: publishes the launch pills this pane owns to the large
 * window that shows the pane, for as long as the pane is mounted. */
export function useAgentSessionLaunchSelectionPublication(
	paneId: string,
	surface: AgentLaunchSelectionSurface | undefined,
): void {
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	const publicationRef =
		useRef<AgentSessionLaunchSelectionPublication>(undefined);
	const published = surface !== undefined;
	useLayoutEffect(() => {
		const initial = surfaceRef.current;
		if (!initial) return;
		const publication = publishAgentSessionLaunchSelection(paneId, initial);
		publicationRef.current = publication;
		return () => {
			publicationRef.current = undefined;
			publication.dispose();
		};
	}, [paneId, published]);
	useLayoutEffect(() => {
		if (surface) publicationRef.current?.update(surface);
	});
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
	const [followed, setFollowed] = useState<{
		mirror: typeof mirror;
		presentation: AgentLaunchSelectionPresentationV1 | null;
	}>();
	const [undelivered, setUndelivered] = useState<{
		mirror: typeof mirror;
		failure: AgentRuntimeLaunchFailure;
	}>();
	useEffect(
		() =>
			mirror?.watch((presentation) => setFollowed({ mirror, presentation })),
		[mirror],
	);
	const presentation =
		followed && followed.mirror === mirror ? followed.presentation : null;
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

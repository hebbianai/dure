// RecentWorkSection's designated store-wiring point (cluster wiring hook):
// the Space facts a card needs to name and target the pane it opens. The list
// itself reaches the section from useRecentSessionsList through the pane.
import { useMemo } from "react";
import {
	type BackgroundWorkSession,
	backgroundWorkSession,
} from "@/lib/agents/chat/backgroundWork";
import { useStore } from "@/store";

export function useRecentWorkSectionState() {
	const spaces = useStore((state) => state.spaces);
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	return { spaces, activeSpaceId };
}

/** The session of the managed agent a card's conversation may still run in:
 *  its background work decides which of the card's subagents run. */
export function useRecentWorkBackgroundWorkSession(
	agentId: string | undefined,
): BackgroundWorkSession | null {
	const binding = useStore((state) =>
		agentId
			? state.agents.find((agent) => agent.id === agentId)?.runtimeBinding
			: undefined,
	);
	return useMemo(() => backgroundWorkSession(binding), [binding]);
}

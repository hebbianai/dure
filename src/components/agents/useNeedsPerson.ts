// The needs-person map for React surfaces. The window's one cached map keeps
// its reference until its content changes, so a surface re-renders when an
// agent starts or stops needing a person — never on terminal output or on a
// display-state change that leaves the map as it was.
import { useSyncExternalStore } from "react";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { NeedsPersonMap } from "@/lib/agents/needsPerson";
import { readNeedsPerson } from "@/lib/agents/needsPersonFacts";
import { useStore } from "@/store";

function subscribe(listener: () => void): () => void {
	const stopApp = useStore.subscribe(listener);
	const stopAttention = useAgentAttention.subscribe(listener);
	return () => {
		stopApp();
		stopAttention();
	};
}

export function useNeedsPerson(): NeedsPersonMap {
	return useSyncExternalStore(subscribe, readNeedsPerson, readNeedsPerson);
}

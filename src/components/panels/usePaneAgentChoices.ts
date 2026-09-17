import { useStore } from "@/store";

/** Current recipients for editable feedback drafts from preview panes. */
export function usePaneAgentChoices() {
	return useStore((state) => state.agents);
}

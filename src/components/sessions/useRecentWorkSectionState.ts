// RecentWorkSection's designated store-wiring point (cluster wiring hook):
// the Space facts a card needs to name and target the pane it opens. The list
// itself reaches the section from useRecentSessionsList through the pane.
import { useStore } from "@/store";

export function useRecentWorkSectionState() {
	const spaces = useStore((state) => state.spaces);
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	return { spaces, activeSpaceId };
}

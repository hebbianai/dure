import { useStore } from "@/store";

function currentSpaceId(): string {
	return useStore.getState().activeSpaceId;
}

/** Store-backed state and live lookups consumed by the search cluster. */
export function useSearchPaneState() {
	return {
		focus: useStore((state) => state.focusCtx),
		currentSpaceId,
	};
}

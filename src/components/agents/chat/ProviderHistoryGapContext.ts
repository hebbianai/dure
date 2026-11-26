import { createContext, useContext } from "react";
import type { ProviderHistoryPagesState } from "@/components/agents/chat/useOlderProviderHistory";

/** The gaps a Chat timeline pages provider history into, by the item of the
 * boundary row that marks each: its pages and whether they load. The row
 * offers the history it leaves out while this names it. */
export interface ProviderHistoryGaps {
	readonly states: ReadonlyMap<string, ProviderHistoryPagesState>;
	load(itemId: string): Promise<void>;
}

export const ProviderHistoryGapContext = createContext<
	ProviderHistoryGaps | undefined
>(undefined);

export function useProviderHistoryGap(itemId: string) {
	const gaps = useContext(ProviderHistoryGapContext);
	const state = gaps?.states.get(itemId);
	return gaps && state ? { state, load: () => gaps.load(itemId) } : undefined;
}

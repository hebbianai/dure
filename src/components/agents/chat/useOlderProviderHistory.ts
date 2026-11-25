import { useCallback, useRef, useState } from "react";
import {
	type ProviderHistoryPages,
	providerHistoryPages,
	withOlderProviderPage,
} from "@/lib/agents/chat/providerHistoryPages";
import type { ProviderConversationActivity } from "@/lib/ipc/conversations";

/** Reads the provider transcript page that ends `before` a cursor. Null means
 * the reader cannot read this conversation's older history at all. */
export type OlderProviderHistoryReader = (
	before: number,
) => Promise<ProviderConversationActivity | null>;

interface OlderProviderHistoryState {
	key: string;
	pages: ProviderHistoryPages;
	loading: boolean;
	failed: boolean;
	unavailable: boolean;
}

/** Loads a provider transcript's older pages on request, above history a view
 * already shows from `anchor` on, through the reader of the view's own
 * source: the desktop's transcript reader for a terminal Agent's
 * conversation view, the backend that owns the session for Chat. A new
 * conversation or anchor starts new pages; an answer for an earlier one is
 * dropped. Without a source or anchor there is nothing older to load here. */
export function useOlderProviderHistory(
	source: { provider: string; conversationId: string } | undefined,
	anchor: number | undefined,
	read: OlderProviderHistoryReader,
) {
	const provider = source?.provider;
	const conversationId = source?.conversationId;
	const key =
		provider && conversationId && anchor !== undefined
			? JSON.stringify([provider, conversationId, anchor])
			: undefined;
	const [state, setState] = useState<OlderProviderHistoryState>();
	const current: OlderProviderHistoryState | undefined =
		key === undefined || anchor === undefined
			? undefined
			: state?.key === key
				? state
				: {
						key,
						pages: providerHistoryPages(anchor),
						loading: false,
						failed: false,
						unavailable: false,
					};
	const currentRef = useRef(current);
	currentRef.current = current;
	const readRef = useRef(read);
	readRef.current = read;

	const loadOlder = useCallback(async () => {
		const at = currentRef.current;
		const before = at?.pages.before;
		if (
			!at ||
			at.loading ||
			at.unavailable ||
			before === null ||
			before === undefined
		) {
			return;
		}
		setState({ ...at, loading: true, failed: false });
		let next: Partial<OlderProviderHistoryState>;
		try {
			const page = await readRef.current(before);
			// A page of another conversation is never this one's history.
			if (
				page &&
				(page.provider !== provider || page.conversationId !== conversationId)
			) {
				throw new Error("provider_history_page_invalid");
			}
			next = page
				? { pages: withOlderProviderPage(at.pages, before, page) }
				: { unavailable: true };
		} catch {
			next = { failed: true };
		}
		setState((latest) =>
			latest?.key !== at.key ? latest : { ...latest, ...next, loading: false },
		);
	}, [provider, conversationId]);

	return {
		pages: current?.pages,
		loading: current?.loading ?? false,
		failed: current?.failed ?? false,
		/** The reader cannot read older history: the view keeps showing where
		 * its history starts. */
		unavailable: current?.unavailable ?? false,
		loadOlder,
	};
}

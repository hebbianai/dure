import { useCallback, useRef, useState } from "react";
import {
	type ProviderHistoryPages,
	providerHistoryPages,
	withOlderProviderPage,
} from "@/lib/agents/chat/providerHistoryPages";
import { readProviderConversationTranscript } from "@/lib/ipc/conversations";

interface OlderProviderHistoryState {
	key: string;
	pages: ProviderHistoryPages;
	loading: boolean;
	failed: boolean;
}

/** Loads a provider transcript's older pages on request, above history a view
 * already shows from `anchor` on. A new conversation or anchor starts new
 * pages; an answer for an earlier one is dropped. Without a source or anchor
 * there is nothing older to load here. */
export function useOlderProviderHistory(
	source: { provider: string; conversationId: string } | undefined,
	anchor: number | undefined,
	read: typeof readProviderConversationTranscript = readProviderConversationTranscript,
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
					};
	const currentRef = useRef(current);
	currentRef.current = current;

	const loadOlder = useCallback(async () => {
		const at = currentRef.current;
		const before = at?.pages.before;
		if (
			!at ||
			at.loading ||
			before === null ||
			before === undefined ||
			!provider ||
			!conversationId
		) {
			return;
		}
		setState({ ...at, loading: true, failed: false });
		let pages: ProviderHistoryPages | undefined;
		try {
			pages = withOlderProviderPage(
				at.pages,
				before,
				await read(provider, conversationId, { includeTools: true, before }),
			);
		} catch {
			pages = undefined;
		}
		setState((latest) =>
			latest?.key !== at.key
				? latest
				: pages
					? { ...latest, pages, loading: false }
					: { ...latest, loading: false, failed: true },
		);
	}, [provider, conversationId, read]);

	return {
		pages: current?.pages,
		loading: current?.loading ?? false,
		failed: current?.failed ?? false,
		loadOlder,
	};
}

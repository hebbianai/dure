import { useCallback, useMemo, useRef, useState } from "react";
import {
	type ProviderHistoryAnchor,
	type ProviderHistoryPages,
	providerHistoryPages,
	withOlderProviderPage,
} from "@/lib/agents/chat/providerHistoryPages";
import type { ProviderConversationActivity } from "@/lib/ipc/conversations";

/** Reads the provider transcript page that ends `before` a cursor and starts
 * no earlier than `after`. Null means the reader cannot read that history at
 * all. */
export type ProviderHistoryReader = (
	before: number,
	after: number,
) => Promise<ProviderConversationActivity | null>;

/** Reads the provider transcript page that ends `before` a cursor. Null means
 * the reader cannot read this conversation's older history at all. */
export type OlderProviderHistoryReader = (
	before: number,
) => Promise<ProviderConversationActivity | null>;

export interface ProviderHistoryPagesState {
	readonly pages: ProviderHistoryPages;
	readonly loading: boolean;
	readonly failed: boolean;
	/** The reader cannot read this history: the view keeps showing the
	 * boundary where it is left out. */
	readonly unavailable: boolean;
}

interface KeyedAnchor {
	readonly key: string;
	readonly anchor: ProviderHistoryAnchor;
}

function freshState(anchor: ProviderHistoryAnchor): ProviderHistoryPagesState {
	return {
		pages: providerHistoryPages(anchor.before, anchor.after),
		loading: false,
		failed: false,
		unavailable: false,
	};
}

/** Loads provider transcript pages on request at each anchor of a view's
 * history, through the reader of the view's own source: the desktop's
 * transcript reader for a terminal Agent's conversation view, the backend
 * that owns the session for Chat. An anchor that moves, or another
 * conversation, starts new pages; an answer for one no longer shown is
 * dropped. Without a source there is nothing to load here. */
export function useProviderHistoryPages(
	source: { provider: string; conversationId: string } | undefined,
	anchors: readonly ProviderHistoryAnchor[],
	read: ProviderHistoryReader,
) {
	const provider = source?.provider;
	const conversationId = source?.conversationId;
	const scoped = provider && conversationId ? anchors : [];
	// Anchors are rebuilt with every timeline page; their keys say whether
	// any of them moved.
	const signature = JSON.stringify(
		scoped.map((anchor) => [
			provider,
			conversationId,
			anchor.kind,
			anchor.itemId,
			anchor.before,
			anchor.after,
		]),
	);
	const keyed = useMemo<readonly KeyedAnchor[]>(
		() =>
			scoped.map((anchor) => ({
				key: JSON.stringify([
					provider,
					conversationId,
					anchor.kind,
					anchor.itemId,
					anchor.before,
					anchor.after,
				]),
				anchor,
			})),
		[signature],
	);
	const [stored, setStored] = useState<
		ReadonlyMap<string, ProviderHistoryPagesState>
	>(() => new Map());
	const states = useMemo(() => {
		const current = new Map<string, ProviderHistoryPagesState>();
		for (const { key, anchor } of keyed) {
			current.set(anchor.itemId, stored.get(key) ?? freshState(anchor));
		}
		return current;
	}, [keyed, stored]);
	const keyedRef = useRef(keyed);
	keyedRef.current = keyed;
	const statesRef = useRef(states);
	statesRef.current = states;
	const readRef = useRef(read);
	readRef.current = read;

	const load = useCallback(
		async (itemId: string) => {
			const key = keyedRef.current.find(
				({ anchor }) => anchor.itemId === itemId,
			)?.key;
			const at = statesRef.current.get(itemId);
			const before = at?.pages.before;
			if (
				key === undefined ||
				!at ||
				at.loading ||
				at.unavailable ||
				before === null ||
				before === undefined
			) {
				return;
			}
			// Only anchors still shown keep their pages.
			const settle = (change: Partial<ProviderHistoryPagesState>) =>
				setStored((latest) => {
					const shown = new Set(keyedRef.current.map((entry) => entry.key));
					const kept = new Map(
						[...latest].filter(([stale]) => shown.has(stale)),
					);
					if (shown.has(key)) {
						kept.set(key, { ...(latest.get(key) ?? at), ...change });
					}
					return kept;
				});
			settle({ loading: true, failed: false });
			let next: Partial<ProviderHistoryPagesState>;
			try {
				const page = await readRef.current(before, at.pages.floor);
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
			settle({ ...next, loading: false });
		},
		[provider, conversationId],
	);

	return { states, load };
}

const OLDER = "older";

/** Loads a provider transcript's older pages on request, above history a view
 * already shows from `anchor` on: {@link useProviderHistoryPages} at the one
 * place a view's history starts. Without an anchor there is nothing older to
 * load here. */
export function useOlderProviderHistory(
	source: { provider: string; conversationId: string } | undefined,
	anchor: number | undefined,
	read: OlderProviderHistoryReader,
) {
	const anchors = useMemo<ProviderHistoryAnchor[]>(
		() =>
			anchor === undefined
				? []
				: [{ kind: "opening", itemId: OLDER, before: anchor, after: 0 }],
		[anchor],
	);
	const readRef = useRef(read);
	readRef.current = read;
	const readOlder = useCallback<ProviderHistoryReader>(
		(before) => readRef.current(before),
		[],
	);
	const { states, load } = useProviderHistoryPages(source, anchors, readOlder);
	const current = states.get(OLDER);
	const loadOlder = useCallback(() => load(OLDER), [load]);
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

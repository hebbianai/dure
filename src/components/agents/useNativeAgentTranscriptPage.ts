import { useEffect, useMemo, useRef } from "react";
import { useOlderProviderHistory } from "@/components/agents/chat/useOlderProviderHistory";
import { useDocumentVisible } from "@/components/common/useDocumentVisible";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import {
	type NativeAgentChatPendingPrompt,
	type NativeAgentChatSnapshot,
	nativeAgentChatPage,
	nativeAgentChatRefreshCursor,
} from "@/lib/agents/chat/nativeAgentChat";
import {
	followNativeTranscript,
	readFollowedTranscript,
} from "@/lib/agents/chat/nativeTranscriptFollow";
import {
	followProviderConversationTranscript,
	readProviderConversationTranscript,
} from "@/lib/ipc/conversations";
import type { NativeAgentTranscriptSource } from "../../../cli/lib/agent-transcript.mjs";

/** Where the newest transcript read lives. The pane keeps it in its runtime
 * owned state, so showing its conversation again at the same cursor reuses
 * the read; a view of its own (the Work view) keeps it for as long as it is
 * shown. */
export interface NativeAgentTranscriptRead {
	readonly snapshot: NativeAgentChatSnapshot | undefined;
	setSnapshot(snapshot: NativeAgentChatSnapshot): void;
	setReadFailed(failed: boolean): void;
}

/** A native terminal Agent's provider transcript as the shared chat page,
 * with older history loading on request. The transcript is read whole when
 * the refresh cursor moves (a new conversation or terminal generation, a
 * turn the Host completed, work starting or stopping). While the Agent works
 * and the view is on screen it also follows what the provider writes: each
 * change the desktop reports on the transcript's file reads what was
 * appended since the newest read, at most once a second. Neither runs on a
 * timer. `page` is undefined before the first read and null when the
 * transcript cannot be projected. */
export function useNativeAgentTranscriptPage({
	source,
	terminalEpoch,
	turnCompletedCount,
	working,
	read,
	pending,
}: {
	source: NativeAgentTranscriptSource;
	terminalEpoch: string;
	turnCompletedCount: string | undefined;
	working: boolean;
	read: NativeAgentTranscriptRead;
	/** A sent prompt the transcript has not shown yet. */
	pending?: NativeAgentChatPendingPrompt;
}) {
	const { agentId, provider, conversationId } = source;
	const { snapshot, setSnapshot, setReadFailed } = read;
	const cursor = nativeAgentChatRefreshCursor({
		conversationId,
		terminalEpoch,
		turnCompletedCount,
		working,
	});

	// The cursor is the refresh contract: it changes exactly when the inputs
	// read below (conversation, terminal generation, Host count) change. A new
	// owner of the read also re-reads, since its setters are new.
	const readCursor = snapshot?.cursor;
	useEffect(() => {
		if (readCursor === cursor) return;
		let current = true;
		void readProviderConversationTranscript(provider, conversationId, {
			includeTools: true,
		}).then(
			(transcript) => {
				if (!current) return;
				setSnapshot({ transcript, turnCompletedCount, cursor });
				setReadFailed(false);
			},
			() => {
				if (current) setReadFailed(true);
			},
		);
		return () => {
			current = false;
		};
	}, [cursor, setSnapshot, setReadFailed]);

	// The follow continues the newest read, and a read that answers after a
	// newer one is dropped. With no read yet (a new conversation whose
	// provider had not written its transcript when the cursor moved), its
	// first read is the whole read at the current cursor.
	const snapshotRef = useRef(snapshot);
	snapshotRef.current = snapshot;
	const currentRef = useRef({ cursor, turnCompletedCount });
	currentRef.current = { cursor, turnCompletedCount };
	const onScreen = useDocumentVisible();
	const following = working && onScreen;
	useEffect(() => {
		if (!following) return;
		const readPage = (after?: number) =>
			readProviderConversationTranscript(provider, conversationId, {
				includeTools: true,
				after,
			});
		return followNativeTranscript({
			follow: (onChange) =>
				followProviderConversationTranscript(
					provider,
					conversationId,
					onChange,
				),
			read: async () => {
				const base = snapshotRef.current;
				const at = currentRef.current;
				const transcript = base
					? await readFollowedTranscript(base.transcript, readPage)
					: await readPage();
				if (snapshotRef.current !== base || transcript === base?.transcript) {
					return;
				}
				setSnapshot(base ? { ...base, transcript } : { transcript, ...at });
				setReadFailed(false);
			},
		});
	}, [following, provider, conversationId, setSnapshot, setReadFailed]);

	// Older history loads on request above the newest read, from where that
	// read starts; a newer read that starts elsewhere starts the pages again.
	const older = useOlderProviderHistory(
		{ provider, conversationId },
		snapshot?.transcript.olderCursor,
		(before) =>
			readProviderConversationTranscript(provider, conversationId, {
				includeTools: true,
				before,
			}),
	);
	const olderPages = older.pages?.pages;
	const page = useMemo((): AgentTimelinePageV1 | null | undefined => {
		if (!snapshot) return undefined;
		try {
			return nativeAgentChatPage({
				source: { kind: "local", agentId, provider, conversationId },
				transcript: snapshot.transcript,
				older: olderPages,
				canLoadOlder: true,
				terminalEpoch,
				working,
				pending,
			});
		} catch {
			return null;
		}
	}, [
		agentId,
		provider,
		conversationId,
		snapshot,
		olderPages,
		terminalEpoch,
		working,
		pending,
	]);
	return { page, older };
}

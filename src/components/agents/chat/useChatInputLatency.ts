import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
	type ChatInputLatencyHandle,
	chatInputLatency,
} from "@/lib/agents/chat/chatInputLatency";
import { schedulePostPaint } from "@/lib/scheduling/postPaint";

/** Joins the composer's existing change boundary to its next commit and paint. */
export function useChatInputLatency(draft: string): () => void {
	const handle = useRef<ChatInputLatencyHandle | null>(null);
	const cancelPaint = useRef<(() => void) | null>(null);

	useLayoutEffect(() => {
		const pending = handle.current;
		if (!pending || !chatInputLatency.markCommitted(pending)) return;
		cancelPaint.current = schedulePostPaint(
			window,
			() => {
				chatInputLatency.markPaint(pending);
				handle.current = null;
				cancelPaint.current = null;
			},
			{
				onFrame: () => {
					chatInputLatency.markFrame(pending);
				},
			},
		);
	}, [draft]);

	useEffect(
		() => () => {
			cancelPaint.current?.();
			const pending = handle.current;
			if (pending) chatInputLatency.cancel(pending);
			handle.current = null;
			cancelPaint.current = null;
		},
		[],
	);

	return useCallback(() => {
		handle.current ??= chatInputLatency.beginInput() ?? null;
	}, []);
}

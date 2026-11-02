import { useEffect, useState } from "react";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import {
	type NativeAgentChatPendingPrompt,
	type NativeAgentChatSnapshot,
	type NativeAgentInputFailure,
	nativeAgentChatPendingIdleDeadline,
} from "@/lib/agents/chat/nativeAgentChat";

/** The conversation view's runtime-owned state, kept by the pane rather than
 * the view: hiding the view or a brief runtime drop (reconnect, a transition)
 * must not forget a sent prompt and offer the composer for it again. The
 * owner is one conversation of one terminal generation; a new owner starts
 * empty, and a late write from an older one is dropped. */
export function useNativeAgentChatState(ownerKey: string, idle: boolean) {
	const [snapshot, setSnapshot] =
		useRuntimeOwnedValue<NativeAgentChatSnapshot>(ownerKey);
	const [readFailed, setReadFailed] = useRuntimeOwnedValue<boolean>(ownerKey);
	const [pending, setPending] =
		useRuntimeOwnedValue<NativeAgentChatPendingPrompt>(ownerKey);
	const [sendError, setSendError] =
		useRuntimeOwnedValue<NativeAgentInputFailure>(ownerKey);
	const [sending, setSending] = useRuntimeOwnedValue<boolean>(ownerKey);
	const [idleSinceMs, setIdleSinceMs] = useState<number>();

	useEffect(() => {
		setIdleSinceMs(idle ? Date.now() : undefined);
	}, [idle]);

	// A prompt nothing recorded (TUI-only input) releases the composer once
	// the runtime has stayed idle through the grace period; its row stays as a
	// sent message. Leaving idle cancels the timer.
	const idleDeadline = pending
		? nativeAgentChatPendingIdleDeadline(pending, idleSinceMs)
		: undefined;
	useEffect(() => {
		if (!pending || idleDeadline === undefined) return;
		const timer = setTimeout(
			() => setPending({ ...pending, released: true }),
			Math.max(0, idleDeadline - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [pending, idleDeadline, setPending]);

	return {
		snapshot,
		setSnapshot,
		readFailed: readFailed === true,
		setReadFailed,
		pending,
		setPending,
		sendError,
		setSendError,
		sending: sending === true,
		setSending,
	};
}

export type NativeAgentChatState = ReturnType<typeof useNativeAgentChatState>;

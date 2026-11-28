import {
	nativeTranscriptToolCalls,
	nativeTranscriptToolResults,
} from "@/lib/agents/chat/nativeAgentChat";
import type {
	ProviderConversationActivity,
	ProviderToolCall,
} from "@/lib/ipc/conversations";

/** A shown terminal Agent's transcript follows what the provider writes while
 * the Agent works: each change the desktop reports on the transcript's file
 * reads what was appended since the newest read, at most once per this many
 * milliseconds. A whole read still happens whenever the refresh cursor
 * moves (see `nativeAgentChatRefreshCursor`). */
const NATIVE_TRANSCRIPT_FOLLOW_INTERVAL_MS = 1_000;

function transcriptCursor(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function holdsTools(tools: unknown): boolean {
	return Array.isArray(tools) && tools.length > 0;
}

/** The newest final answer once `newer` is read after `base`: a user message
 * clears it, as it does within one read. */
function joinedFinalResponse(
	base: ProviderConversationActivity,
	newer: ProviderConversationActivity,
): string | null | undefined {
	if (typeof newer.finalResponse === "string") return newer.finalResponse;
	return newer.entries.some((entry) => entry.role === "user")
		? null
		: base.finalResponse;
}

/** `newer`, read after `base`'s newer cursor, joined onto `base` as one read:
 * its messages follow, its calls sit after `base`'s messages, a call it
 * records again keeps its place and takes the newer state, and its results
 * end `base`'s calls. `base` itself when nothing was appended; undefined
 * when only a whole read continues: `newer` does not reach back to where
 * `base` ended (it names an older cursor) or names no newer cursor. */
export function appendNewerTranscriptRead(
	base: ProviderConversationActivity,
	newer: ProviderConversationActivity,
): ProviderConversationActivity | undefined {
	if (newer.olderCursor !== undefined || !transcriptCursor(newer.newerCursor)) {
		return undefined;
	}
	const results = nativeTranscriptToolResults(newer.results);
	if (
		newer.entries.length === 0 &&
		!holdsTools(newer.tools) &&
		results.size === 0 &&
		newer.newerCursor === base.newerCursor
	) {
		return base;
	}
	const tools = nativeTranscriptToolCalls(base.tools, base.entries.length).map(
		(call): ProviderToolCall => {
			const state = results.get(call.callId);
			return state ? { ...call, state } : call;
		},
	);
	const position = new Map(tools.map((call, index) => [call.callId, index]));
	for (const call of nativeTranscriptToolCalls(
		newer.tools,
		newer.entries.length,
	)) {
		const earlier = position.get(call.callId);
		if (earlier === undefined) {
			tools.push({
				...call,
				afterEntries: base.entries.length + call.afterEntries,
			});
		} else {
			tools[earlier] = {
				...(tools[earlier] as ProviderToolCall),
				state: call.state,
				input: call.input,
			};
		}
	}
	return {
		...base,
		entries: [...base.entries, ...newer.entries],
		finalResponse: joinedFinalResponse(base, newer),
		tools,
		newerCursor: newer.newerCursor,
	};
}

/** The next read of a followed transcript: what was appended since `base`,
 * joined onto it, when `base` names where that starts; otherwise, or when
 * that read fails or cannot join (the file was replaced, rewritten or grew
 * past one read), the whole newest read. `read(after)` reads after a newer
 * cursor, `read()` the newest read. */
export async function readFollowedTranscript(
	base: ProviderConversationActivity,
	read: (after?: number) => Promise<ProviderConversationActivity>,
): Promise<ProviderConversationActivity> {
	if (transcriptCursor(base.newerCursor)) {
		const newer = await read(base.newerCursor).catch(() => undefined);
		const joined = newer && appendNewerTranscriptRead(base, newer);
		if (joined) return joined;
	}
	return read();
}

/** The longest wait between two tries to start a follow. */
const MAX_FOLLOW_RETRY_MS = 8_000;

/** Reads a followed transcript after the changes its file reports: once the
 * follow begins (for what was written before it did), then after each
 * change, at most once per `intervalMs` and never two reads at once; a
 * change during a read is read after it. A follow that cannot start yet (a
 * new conversation whose provider has not written its transcript) is tried
 * again, each wait twice the last up to MAX_FOLLOW_RETRY_MS; nothing is read
 * until it starts. Returns the function that ends the follow. */
export function followNativeTranscript({
	follow,
	read,
	intervalMs = NATIVE_TRANSCRIPT_FOLLOW_INTERVAL_MS,
	now = Date.now,
}: {
	/** Starts the change reports; resolves to the function that ends them. */
	follow: (onChange: () => void) => Promise<() => void>;
	read: () => Promise<void>;
	intervalMs?: number;
	now?: () => number;
}): () => void {
	let ended = false;
	let changed = false;
	let reading = false;
	let lastReadAt = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let unfollow: (() => void) | undefined;

	const schedule = () => {
		if (ended || reading || !changed || timer !== undefined) return;
		timer = setTimeout(
			readChanges,
			Math.max(0, lastReadAt + intervalMs - now()),
		);
	};
	const readChanges = () => {
		timer = undefined;
		if (ended || !changed) return;
		changed = false;
		reading = true;
		lastReadAt = now();
		void read()
			.catch(() => {})
			.finally(() => {
				reading = false;
				schedule();
			});
	};
	const onChange = () => {
		changed = true;
		schedule();
	};

	const start = (wait: number) => {
		void follow(onChange).then(
			(end) => {
				if (ended) {
					end();
					return;
				}
				unfollow = end;
				onChange();
			},
			() => {
				if (ended) return;
				retry = setTimeout(
					() => start(Math.min(wait * 2, MAX_FOLLOW_RETRY_MS)),
					wait,
				);
			},
		);
	};
	start(intervalMs);
	return () => {
		ended = true;
		if (timer !== undefined) clearTimeout(timer);
		if (retry !== undefined) clearTimeout(retry);
		unfollow?.();
	};
}

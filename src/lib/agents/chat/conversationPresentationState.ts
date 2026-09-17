import { sanitizeSessionTitle } from "@/lib/sessions/sessionTitle";

/** Shared provider presentation for headers and Spaces. Structured timelines
 * contribute titles; exact native snapshots contribute titles and activity.
 * No pane owns a filesystem reader or an independent activity registry. */

interface ConversationPresentation {
	title?: string;
	conversationId?: string;
	activityAt?: number;
	prompt?: string;
}

const presentations = new Map<string, ConversationPresentation>();
const listeners = new Set<() => void>();
let revision = 0;

export function publishConversationTitle(
	agentId: string,
	title: string | null,
): void {
	const normalized = sanitizeSessionTitle(title);
	if (!normalized || presentations.get(agentId)?.title === normalized) return;
	presentations.set(agentId, {
		...presentations.get(agentId),
		title: normalized,
	});
	revision += 1;
	for (const listener of listeners) listener();
}

export function conversationTitle(
	agentId: string | undefined,
): string | undefined {
	return agentId ? presentations.get(agentId)?.title : undefined;
}

/** Complete native snapshots replace file-derived presentation. Exact identity
 * prevents a switched pane from borrowing the previous conversation's activity. */
export function publishConversationMetadata(
	agentId: string,
	conversationId: string,
	metadata: { title: string | null; activityAt: string | null; recentPrompts?: string[] },
): void {
	const previous = presentations.get(agentId);
	const parsedAt =
		metadata.activityAt === null ? NaN : Date.parse(metadata.activityAt);
	const next = {
		conversationId,
		title:
			sanitizeSessionTitle(metadata.title) ||
			(previous?.conversationId === conversationId
				? previous.title
				: undefined),
		activityAt:
			Number.isFinite(parsedAt) && parsedAt >= 0 ? parsedAt : undefined,
		prompt: metadata.recentPrompts?.map(sanitizeSessionTitle).filter(Boolean).pop()?.slice(0, 200),
	};
	if (
		previous?.conversationId === next.conversationId &&
		previous?.title === next.title &&
		previous?.activityAt === next.activityAt &&
		previous?.prompt === next.prompt
	)
		return;
	presentations.set(agentId, next);
	revision += 1;
	for (const listener of listeners) listener();
}

export function conversationPrompt(
	agentId: string,
	conversationId: string | undefined,
): string | undefined {
	const value = presentations.get(agentId);
	return conversationId && value?.conversationId === conversationId
		? value.prompt
		: undefined;
}

export function conversationActivityAt(
	agentId: string,
	conversationId: string | undefined,
): number | undefined {
	const value = presentations.get(agentId);
	return conversationId && value?.conversationId === conversationId
		? value.activityAt
		: undefined;
}

/** Monotonic change counter — the useSyncExternalStore snapshot. */
export function conversationPresentationRevision(): number {
	return revision;
}

export function subscribeConversationPresentation(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

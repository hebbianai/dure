import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import {
	type ProviderConversationProjectLocation,
	providerConversationTargetForAgent,
	providerConversationTargetKey,
} from "@/lib/agents/providerConversationTarget";
import type { RecentAgentActivity } from "@/lib/spaces/spacesDisplay";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import {
	observedTitle,
	resolveAgentPaneTitle,
} from "@/lib/workspace/pane/paneTitle";
import { type Agent, PROVIDERS } from "@/types";

export type UnopenedAgentConversationIndex = ReadonlyMap<
	string,
	ProviderConversationRecord
>;

/** Index a bounded provider inventory once; duplicate observations converge to
 * the newest record for the same exact provider/location identity. */
export function indexUnopenedAgentConversations(
	records: readonly ProviderConversationRecord[],
): UnopenedAgentConversationIndex {
	const indexed = new Map<string, ProviderConversationRecord>();
	for (const record of records) {
		const key = providerConversationTargetKey({
			provider: record.provider,
			conversationId: record.id,
			executionLocation: record.executionLocation,
			...(record.hostId ? { hostId: record.hostId } : {}),
		});
		const previous = indexed.get(key);
		if (!previous || record.mtime > previous.mtime) indexed.set(key, record);
	}
	return indexed;
}

export function unopenedAgentConversation(
	index: UnopenedAgentConversationIndex,
	agent: Agent,
	project: ProviderConversationProjectLocation | undefined,
): ProviderConversationRecord | undefined {
	const target = providerConversationTargetForAgent(agent, project);
	return target ? index.get(providerConversationTargetKey(target)) : undefined;
}

function timestamp(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/** Only semantic observations count as activity; inventory mtime describes
 * filesystem freshness, never conversation work. All inputs are milliseconds. */
export function agentRowActivityAt(
	promptActivity?: RecentAgentActivity,
	conversationActivityAt?: number,
): number | undefined {
	const promptAt = timestamp(promptActivity?.at);
	const conversationAt = timestamp(conversationActivityAt);
	if (promptAt === undefined) return conversationAt;
	return conversationAt === undefined
		? promptAt
		: Math.max(promptAt, conversationAt);
}

/** One presentation decision for every unopened-agent consumer. Explicit user
 * names retain authority; replaceable runtime observations then precede the
 * provider-owned history snapshot and stable directory fallback. */
export function resolveUnopenedAgentPresentation({
	agent,
	liveConversationTitle,
	liveSessionTitle,
	conversation,
	promptActivity,
	conversationActivityAt,
}: {
	agent: Agent;
	liveConversationTitle?: string;
	liveSessionTitle?: string;
	conversation?: ProviderConversationRecord;
	promptActivity?: RecentAgentActivity;
	conversationActivityAt?: number;
}): { title: string; activityAt?: number } {
	const conversationId = managedConversationId(agent);
	const runtimeTitle = [
		liveConversationTitle,
		liveSessionTitle,
		conversation?.title === PROVIDERS[agent.provider].label
			? undefined
			: conversation?.title,
	]
		.map((candidate) => observedTitle(candidate, conversationId))
		.find((candidate): candidate is string => Boolean(candidate));
	const activityAt = agentRowActivityAt(promptActivity, conversationActivityAt);

	return {
		title: resolveAgentPaneTitle({
			name: agent.name,
			displayName: agent.displayName,
			runtimeTitle,
			opaqueConversationId: conversationId,
			directoryCandidates: [conversation?.cwd, agent.worktreePath],
		}),
		...(activityAt === undefined ? {} : { activityAt }),
	};
}

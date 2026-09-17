// Session-scoped cache for one-conversation provider record reads.
//
// UnopenedAgentDetails re-read the provider-owned history files on every
// expand of the same row even when nothing had happened in the conversation.
// This module keys one in-flight/settled promise per exact conversation
// identity (provider + conversationId + executionLocation + hostId) and
// declares its invalidation conditions explicitly:
//
// - fingerprint mismatch: the caller passes the latest known activity
//   timestamp for the session (checkpoint/prompt `at`); newer activity means
//   the transcript may have grown, so the cached record is stale.
// - failure: a rejected load is evicted immediately so the next expand
//   retries instead of pinning the error.
//
// The ssh host *list* is deliberately not part of the key: the record is a
// per-conversation transcript and hosts only parameterize transport. A host
// config edit therefore does not invalidate cached records — the next
// activity fingerprint change does.
import {
	loadProviderConversationRecord,
	type ProviderConversationDetailsTarget,
	type ProviderConversationRecord,
} from "@/lib/agents/providerConversationDiscovery";
import { providerConversationTargetKey } from "@/lib/agents/providerConversationTarget";
import type { SshHostConfig } from "@/types";

interface CacheEntry {
	readonly fingerprint: number | undefined;
	readonly promise: Promise<ProviderConversationRecord | undefined>;
}

const MAX_ENTRIES = 64;
const cache = new Map<string, CacheEntry>();

/** Cached read of one exact conversation record; see invalidation rules above. */
export function readProviderConversationRecord(
	target: ProviderConversationDetailsTarget,
	hosts: readonly SshHostConfig[],
	fingerprint: number | undefined,
): Promise<ProviderConversationRecord | undefined> {
	const key = providerConversationTargetKey(target);
	const hit = cache.get(key);
	if (hit && hit.fingerprint === fingerprint) return hit.promise;
	const promise = loadProviderConversationRecord(target, hosts).catch(
		(error) => {
			// Evict only our own entry — a newer load may already own the key.
			if (cache.get(key)?.promise === promise) cache.delete(key);
			throw error;
		},
	);
	if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
		// Bounded: drop the oldest insertion — this is a small comfort cache,
		// not an authority, so eviction only costs one re-read.
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { fingerprint, promise });
	return promise;
}

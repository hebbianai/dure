import {
	listProviderConversations,
	type ProviderConversationRecord,
} from "@/lib/agents/providerConversationDiscovery";
import { createBroadcast } from "@/lib/state/broadcast";
import { sshHostSecretId } from "@/lib/ssh/sshCredentialClaim";
import type { SshHostConfig } from "@/types";

const RECENT_SESSION_HISTORY_STALE_MS = 30_000;

interface RecentSessionHistorySnapshot {
	entries: readonly ProviderConversationRecord[];
	loadState: "idle" | "loading" | "ready" | "error";
}

export interface RecentSessionHistoryResource {
	subscribe(listener: () => void): () => void;
	getSnapshot(scopeKey: string): RecentSessionHistorySnapshot;
	ensureLoaded(hosts: readonly SshHostConfig[]): Promise<void>;
	refresh(hosts: readonly SshHostConfig[]): Promise<void>;
}

interface ScopeState {
	snapshot: RecentSessionHistorySnapshot;
	lastAttemptAt: number | null;
	requestGeneration: number;
	inFlight: Promise<void> | null;
}

const EMPTY_SNAPSHOT: RecentSessionHistorySnapshot = {
	entries: [],
	loadState: "idle",
};

/** A scope contains only connection identity, never plaintext credentials. */
export function recentSessionHistoryScopeKey(
	hosts: readonly SshHostConfig[],
): string {
	return JSON.stringify(
		hosts.map((host) => [
			host.id,
			host.host,
			host.port,
			host.user,
			host.auth,
			sshHostSecretId(host) ?? "",
			host.keyPath ?? "",
			Boolean(host.password),
		]),
	);
}

/**
 * Shared stale-while-revalidate projection of provider-owned session files.
 * Provider files remain authoritative; this resource only avoids rescanning
 * them when sidebar surfaces remount within the freshness window.
 */
export function createRecentSessionHistoryResource(
	load: (
		hosts: readonly SshHostConfig[],
	) => Promise<readonly ProviderConversationRecord[]>,
	options: {
		now?: () => number;
		staleAfterMs?: number;
	} = {},
): RecentSessionHistoryResource {
	const now = options.now ?? Date.now;
	const staleAfterMs =
		options.staleAfterMs ?? RECENT_SESSION_HISTORY_STALE_MS;
	const changed = createBroadcast<void>();
	const scopes = new Map<string, ScopeState>();

	const scopeState = (scopeKey: string): ScopeState => {
		const existing = scopes.get(scopeKey);
		if (existing) return existing;
		const created: ScopeState = {
			snapshot: EMPTY_SNAPSHOT,
			lastAttemptAt: null,
			requestGeneration: 0,
			inFlight: null,
		};
		scopes.set(scopeKey, created);
		return created;
	};

	const publish = (scope: ScopeState, snapshot: RecentSessionHistorySnapshot) => {
		scope.snapshot = snapshot;
		changed.publish();
	};

	const refresh = (hosts: readonly SshHostConfig[]): Promise<void> => {
		const scope = scopeState(recentSessionHistoryScopeKey(hosts));
		const generation = ++scope.requestGeneration;
		scope.lastAttemptAt = now();
		publish(scope, {
			entries: scope.snapshot.entries,
			loadState: "loading",
		});
		const operation = (async () => {
			try {
				const entries = await load(hosts);
				if (generation !== scope.requestGeneration) return;
				if (!Array.isArray(entries)) {
					throw new Error("invalid_provider_conversation_list_response");
				}
				scope.lastAttemptAt = now();
				publish(scope, { entries: [...entries], loadState: "ready" });
			} catch {
				if (generation !== scope.requestGeneration) return;
				publish(scope, {
					entries: scope.snapshot.entries,
					loadState: "error",
				});
			}
		})();
		scope.inFlight = operation;
		void operation.then(() => {
			if (scope.inFlight === operation) scope.inFlight = null;
		});
		return operation;
	};

	return {
		subscribe: (listener) => changed.subscribe(listener),
		getSnapshot(scopeKey) {
			return scopes.get(scopeKey)?.snapshot ?? EMPTY_SNAPSHOT;
		},
		ensureLoaded(hosts) {
			const scope = scopeState(recentSessionHistoryScopeKey(hosts));
			if (scope.snapshot.loadState === "loading") {
				return scope.inFlight ?? Promise.resolve();
			}
			if (scope.lastAttemptAt !== null) {
				const age = now() - scope.lastAttemptAt;
				if (age >= 0 && age < staleAfterMs) return Promise.resolve();
			}
			return refresh(hosts);
		},
		refresh,
	};
}

function createSharedResource(options: { now?: () => number } = {}) {
	return createRecentSessionHistoryResource(
		(hosts) => listProviderConversations(hosts),
		options,
	);
}

let sharedResource = createSharedResource();

export function subscribeRecentSessionHistory(listener: () => void) {
	return sharedResource.subscribe(listener);
}

export function recentSessionHistorySnapshot(scopeKey: string) {
	return sharedResource.getSnapshot(scopeKey);
}

export function ensureRecentSessionHistory(hosts: readonly SshHostConfig[]) {
	return sharedResource.ensureLoaded(hosts);
}

export function refreshRecentSessionHistory(hosts: readonly SshHostConfig[]) {
	return sharedResource.refresh(hosts);
}

/** Test-only: all resource consumers must be unmounted before resetting. A
 *  test that exercises the freshness window passes its own clock instead of
 *  patching the global Date. */
export function resetRecentSessionHistoryForTests(
	options: { now?: () => number } = {},
) {
	sharedResource = createSharedResource(options);
}

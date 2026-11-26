// Keeps one chat runtime tier subscription per backend profile that hosts
// this window's chat Agents, and withdraws a backend's tier the moment its
// subscription ends, so its Agents read `unknown` rather than a stale state.
// Installed beside the attention watch in every window, since each window
// resolves display states from its own store.
//
// A healthy subscription costs no timers or reads here: the backend pushes
// changes. Only a failed or refused subscription is retried, with backoff.

import { structuredAgentBackendProfiles } from "@/lib/agents/structuredAgentRuntime";
import {
	type DureAgentActivityEventV1,
	type DureAgentActivitySubscriptionV1,
	subscribeDureAgentActivity,
} from "@/lib/ipc/dureAgentActivity";
import { useStore } from "@/store";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;

export type SubscribeDureAgentActivity = (
	profileId: string,
	onEvent: (event: DureAgentActivityEventV1) => void,
) => Promise<DureAgentActivitySubscriptionV1 | null>;

export function structuredAgentRuntimeRetryDelayMs(failures: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.min(failures, 16), RETRY_MAX_MS);
}

interface BackendTierWatch {
	stop(): void;
}

function watchBackendTier(
	profileId: string,
	subscribe: SubscribeDureAgentActivity,
): BackendTierWatch {
	let stopped = false;
	let failures = 0;
	let attempt = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let subscription: DureAgentActivitySubscriptionV1 | undefined;
	const apply = (
		update: Parameters<
			ReturnType<typeof useStore.getState>["applyStructuredAgentRuntime"]
		>[1],
	) => useStore.getState().applyStructuredAgentRuntime(profileId, update);
	const release = () => {
		const closing = subscription;
		subscription = undefined;
		void closing?.close().catch(() => {});
	};
	const retry = () => {
		if (stopped || retryTimer !== undefined) return;
		const delay = structuredAgentRuntimeRetryDelayMs(failures);
		failures += 1;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			void open();
		}, delay);
	};
	// Ends the current attempt: nothing it delivers later applies.
	const fail = () => {
		attempt += 1;
		apply(null);
		release();
		retry();
	};
	const open = async () => {
		if (stopped) return;
		const current = ++attempt;
		const isCurrent = () => !stopped && current === attempt;
		const onEvent = (event: DureAgentActivityEventV1) => {
			if (!isCurrent()) return;
			if (event.kind === "error") {
				fail();
				return;
			}
			if (event.kind === "snapshot") failures = 0;
			apply(event);
		};
		try {
			const opened = await subscribe(profileId, onEvent);
			if (!isCurrent()) {
				void opened?.close().catch(() => {});
				return;
			}
			// The backend predates the tier: its chat Agents stay unobserved
			// until it is upgraded.
			if (opened === null) {
				fail();
				return;
			}
			subscription = opened;
		} catch {
			if (isCurrent()) fail();
		}
	};
	void open();
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			if (retryTimer !== undefined) clearTimeout(retryTimer);
			retryTimer = undefined;
			release();
			apply(null);
		},
	};
}

export function installStructuredAgentRuntimeWatch(
	subscribe: SubscribeDureAgentActivity = subscribeDureAgentActivity,
): () => void {
	const active = new Map<string, BackendTierWatch>();
	let disposed = false;
	const reconcile = () => {
		if (disposed) return;
		const wanted = structuredAgentBackendProfiles(useStore.getState().agents);
		for (const [profileId, watch] of active) {
			if (wanted.has(profileId)) continue;
			watch.stop();
			active.delete(profileId);
		}
		for (const profileId of wanted) {
			if (!active.has(profileId)) {
				active.set(profileId, watchBackendTier(profileId, subscribe));
			}
		}
	};
	const unsubscribe = useStore.subscribe((state, previous) => {
		if (state.agents !== previous.agents) reconcile();
	});
	reconcile();
	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		for (const watch of active.values()) watch.stop();
		active.clear();
	};
}

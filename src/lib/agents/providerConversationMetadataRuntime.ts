import { conversationHistoryCredentialProfile } from "@/lib/agents/agentConversationHistory";
import { publishConversationMetadata } from "@/lib/agents/chat/conversationPresentationState";
import {
	type ProviderConversationMetadata,
	type ProviderConversationMetadataTarget,
	providerConversationMetadata,
	sshProviderConversationMetadata,
} from "@/lib/ipc/conversations";
import { hostToOpts } from "@/lib/ipc/sessions";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { useStore } from "@/store";
import type { AccountProfile, Agent, SshHostConfig } from "@/types";

const REFRESH_INTERVAL_MS = 5_000;
/** A remote lookup opens one SSH connection per host, so the same target set
 * is re-read at a slower cadence than the local filesystem backstop. */
export const REMOTE_REFRESH_INTERVAL_MS = 15_000;
const LOOKUP_BATCH_SIZE = 128;
/** Bounded by the SSH transport's combined-output cap: eight 4096-character
 * prompts per target in UTF-8 stay well below it at this size. */
const REMOTE_LOOKUP_BATCH_SIZE = 32;

interface ConversationMetadataState {
	agents: readonly Agent[];
	accounts: readonly AccountProfile[];
	sshHosts: readonly SshHostConfig[];
}

interface AgentMetadataTarget {
	agentId: string;
	/** The registered host whose filesystem owns the transcript; local when absent. */
	host?: SshHostConfig;
	lookup: ProviderConversationMetadataTarget;
}

export interface ProviderConversationMetadataRuntimeDependencies {
	readState: () => ConversationMetadataState;
	subscribe: (listener: () => void) => () => void;
	load: (
		targets: readonly ProviderConversationMetadataTarget[],
		host: SshHostConfig | undefined,
	) => Promise<Array<ProviderConversationMetadata | null>>;
	publish: (
		agentId: string,
		conversationId: string,
		metadata: ProviderConversationMetadata,
	) => void;
	setInterval: (
		listener: () => void,
		intervalMs: number,
	) => ReturnType<typeof setInterval>;
	clearInterval: (timer: ReturnType<typeof setInterval>) => void;
	now: () => number;
}

const defaultDependencies: ProviderConversationMetadataRuntimeDependencies = {
	readState: () => useStore.getState(),
	subscribe: (listener) =>
		useStore.subscribe((state, previous) => {
			if (
				state.accounts !== previous.accounts ||
				state.sshHosts !== previous.sshHosts ||
				// Presentation edits do not change the files being observed. Keep
				// identity invalidation separate from the filesystem backstop.
				(state.agents !== previous.agents &&
					targetsForState(state).map(targetKey).sort().join("\n") !==
						targetsForState(previous).map(targetKey).sort().join("\n"))
			) {
				listener();
			}
		}),
	load: (targets, host) =>
		host
			? sshProviderConversationMetadata(hostToOpts(host), targets)
			: providerConversationMetadata(targets),
	publish: publishConversationMetadata,
	setInterval: (listener, intervalMs) => setInterval(listener, intervalMs),
	clearInterval: (timer) => clearInterval(timer),
	now: () => Date.now(),
};

function targetsForState(
	state: ConversationMetadataState,
): AgentMetadataTarget[] {
	return state.agents.flatMap((agent) => {
		// Structured sessions publish provider timeline evidence directly.
		// This filesystem projection exists only for native CLIs, whose
		// provider rename does not cross the terminal protocol boundary — on
		// the local disk or on the registered host that runs the CLI.
		if (agent.interactionProfile?.kind === "structured_protocol") return [];
		const conversationId = managedConversationId(agent);
		if (!conversationId) return [];
		const binding = agent.runtimeBinding;
		const remote = binding?.source === "ssh";
		const host = remote
			? state.sshHosts.find((candidate) => candidate.id === binding.hostId)
			: undefined;
		if (remote && !host) return [];
		let credentialProfile: ReturnType<
			typeof conversationHistoryCredentialProfile
		>;
		try {
			credentialProfile = conversationHistoryCredentialProfile({
				agent,
				accounts: state.accounts,
				remote,
			});
		} catch {
			return [];
		}
		return [
			{
				agentId: agent.id,
				...(host ? { host } : {}),
				lookup: {
					provider: agent.provider,
					conversationId,
					cwd: agent.worktreePath,
					...(credentialProfile ? { credentialProfile } : {}),
				},
			},
		];
	});
}

/** Identity of one lookup, including the host generation that serves it, so
 * an edited host row or a moved conversation is read again at once. */
function targetKey(target: AgentMetadataTarget): string {
	return JSON.stringify([
		target.agentId,
		target.host?.id,
		target.host?.registrationGeneration,
		target.lookup,
	]);
}

interface HostGroup {
	host?: SshHostConfig;
	targets: AgentMetadataTarget[];
}

function groupByHost(targets: readonly AgentMetadataTarget[]): HostGroup[] {
	const groups = new Map<string | undefined, HostGroup>();
	for (const target of targets) {
		const key = target.host?.id;
		const group = groups.get(key);
		if (group) group.targets.push(target);
		else groups.set(key, { host: target.host, targets: [target] });
	}
	return [...groups.values()];
}

interface RemoteRead {
	/** The exact target set the last completed read covered. */
	key: string;
	/** When that read completed (or failed); the cadence counts from here. */
	at: number;
	inflight?: Promise<void>;
}

/** One app-scoped native metadata projection. Provider files can change without
 * a store event (`/rename`), so a single cheap backstop timer refreshes exact
 * active ids; panes themselves never poll and never own a second registry. */
export function installProviderConversationMetadataRuntime(
	deps: ProviderConversationMetadataRuntimeDependencies = defaultDependencies,
): () => void {
	let disposed = false;
	let refreshing = false;
	let refreshAgain = false;
	const remoteReads = new Map<string, RemoteRead>();
	/** Change tokens per remote lookup, echoed so an unchanged transcript is
	 * answered by one stat on the host instead of a bounded re-read. */
	const remoteObserved = new Map<string, string>();

	const publishBatch = (
		batch: readonly AgentMetadataTarget[],
		metadata: ReadonlyArray<ProviderConversationMetadata | null>,
	) => {
		const currentTargets = new Map(
			targetsForState(deps.readState()).map((target) => [
				target.agentId,
				targetKey(target),
			]),
		);
		for (const [index, target] of batch.entries()) {
			const observation = metadata[index];
			if (
				!observation ||
				currentTargets.get(target.agentId) !== targetKey(target)
			) {
				continue;
			}
			if (target.host) {
				if (observation.unchanged) continue;
				if (observation.observed !== undefined) {
					remoteObserved.set(targetKey(target), observation.observed);
				}
			}
			deps.publish(target.agentId, target.lookup.conversationId, observation);
		}
	};

	const loadGroup = async (group: HostGroup) => {
		const batchSize = group.host ? REMOTE_LOOKUP_BATCH_SIZE : LOOKUP_BATCH_SIZE;
		for (let offset = 0; offset < group.targets.length; offset += batchSize) {
			const batch = group.targets.slice(offset, offset + batchSize);
			let metadata: Array<ProviderConversationMetadata | null>;
			try {
				metadata = await deps.load(
					batch.map((target) => {
						const observed = group.host
							? remoteObserved.get(targetKey(target))
							: undefined;
						return observed !== undefined
							? { ...target.lookup, observed }
							: target.lookup;
					}),
					group.host,
				);
			} catch {
				continue;
			}
			if (disposed) return;
			publishBatch(batch, metadata);
		}
	};

	/** Remote hosts run detached from the local loop: one in-flight read per
	 * host, and a host that stalls in the SSH handshake never delays local
	 * files. The cadence counts from completion, so an unhealthy host is
	 * redialled every REMOTE_REFRESH_INTERVAL_MS, not back-to-back. */
	const startRemoteRead = (group: HostGroup, host: SshHostConfig) => {
		const key = group.targets.map(targetKey).join("\n");
		const previous = remoteReads.get(host.id);
		if (previous?.inflight) return;
		if (
			previous?.key === key &&
			deps.now() - previous.at < REMOTE_REFRESH_INTERVAL_MS
		) {
			return;
		}
		const inflight = loadGroup(group).then(
			() => {
				remoteReads.set(host.id, { key, at: deps.now() });
			},
			() => {
				remoteReads.set(host.id, { key, at: deps.now() });
			},
		);
		remoteReads.set(host.id, { key, at: previous?.at ?? 0, inflight });
	};

	const refresh = async () => {
		if (disposed) return;
		if (refreshing) {
			refreshAgain = true;
			return;
		}
		refreshing = true;
		try {
			do {
				refreshAgain = false;
				const groups = groupByHost(targetsForState(deps.readState()));
				const liveHosts = new Set<string>();
				const liveTargets = new Set<string>();
				for (const group of groups) {
					if (!group.host) continue;
					liveHosts.add(group.host.id);
					for (const target of group.targets)
						liveTargets.add(targetKey(target));
					startRemoteRead(group, group.host);
				}
				for (const [hostId, read] of remoteReads) {
					if (!liveHosts.has(hostId) && !read.inflight) {
						remoteReads.delete(hostId);
					}
				}
				for (const key of remoteObserved.keys()) {
					if (!liveTargets.has(key)) remoteObserved.delete(key);
				}
				const local = groups.find((group) => !group.host);
				if (local) await loadGroup(local);
				if (disposed) return;
			} while (refreshAgain && !disposed);
		} finally {
			refreshing = false;
		}
	};

	const unsubscribe = deps.subscribe(() => void refresh());
	const timer = deps.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
	void refresh();

	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		deps.clearInterval(timer);
	};
}

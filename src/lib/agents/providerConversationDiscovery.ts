import {
	getProviderConversationDetails,
	getRemoteProviderConversationDetails,
	hostToOpts,
	listProviderConversationRecords,
	listRemoteProviderConversationRecords,
} from "@/lib/ipc";
import { sshHostSecretId } from "@/lib/ssh/sshCredentialClaim";
import type { Provider, SshHostConfig } from "@/types";

const MAX_AUTOMATIC_REMOTE_HOSTS = 8;
const MAX_DISCOVERED_SESSIONS = 600;

export interface ProviderConversationRecord {
	provider: Provider;
	id: string;
	cwd: string;
	title: string;
	mtime: number;
	resumeCapability: "exact";
	interactionKind?: "interactive" | "non_interactive";
	workingDirectoryAvailable?: boolean;
	executionLocation: "local" | "ssh";
	hostId?: string;
	repositoryRoot?: string;
	repositoryCommonDir?: string;
	repositoryRemoteIdentity?: string;
	branch?: string;
	model?: string;
	effort?: string;
	recentTurns?: readonly ProviderConversationTurn[];
	subagentCount?: number;
}

export interface ProviderConversationTurn {
	role: "user" | "agent";
	text: string;
}

export interface ProviderConversationSubagent {
	id: string;
	title: string;
	kind?: string;
	status: "running" | "completed" | "failed" | "unknown";
	mtime: number;
}

export type ProviderConversationInputAuthority =
	| { kind: "independent" }
	| { kind: "controlled_by_parent"; parentConversationId: string }
	| { kind: "unverified" };

export interface ProviderConversationDetails {
	inputAuthority: ProviderConversationInputAuthority;
	subagents: readonly ProviderConversationSubagent[];
	totalCount: number;
}

export interface ProviderConversationDetailsTarget {
	provider: Provider;
	conversationId: string;
	executionLocation: "local" | "ssh";
	hostId?: string;
}

export interface ProviderConversationDiscoverySource {
	key: string;
	kind: "local" | "ssh";
	label?: string;
	hostId?: string;
	status: "pending" | "succeeded" | "failed";
	count: number;
}

export interface ProviderConversationDiscoverySnapshot {
	records: readonly ProviderConversationRecord[];
	sources: readonly ProviderConversationDiscoverySource[];
	complete: boolean;
}

function canScanWithoutInteraction(host: SshHostConfig): boolean {
	if (host.auth === "password") return Boolean(sshHostSecretId(host));
	if (host.auth === "key") return Boolean(host.keyPath?.trim());
	return host.auth === "auto";
}

function recordIdentity(record: ProviderConversationRecord): string {
	const location =
		record.executionLocation === "ssh"
			? `ssh:${record.hostId ?? "unknown"}`
			: "local";
	return `${location}\0${record.provider}\0${record.id}`;
}

function mergeRecords(
	recordsBySource: ReadonlyMap<string, readonly ProviderConversationRecord[]>,
): ProviderConversationRecord[] {
	const seen = new Set<string>();
	return [...recordsBySource.values()]
		.flat()
		.filter((record) => {
			const identity = recordIdentity(record);
			if (seen.has(identity)) return false;
			seen.add(identity);
			return true;
		})
		.sort(
			(left, right) =>
				right.mtime - left.mtime ||
				left.provider.localeCompare(right.provider) ||
				left.id.localeCompare(right.id),
		)
		.slice(0, MAX_DISCOVERED_SESSIONS);
}

/** Emit local and per-host remote results as soon as each bounded source
 * settles. A source failure never erases another source's records and is
 * represented without exposing raw connection or credential errors. */
export async function discoverProviderConversationsProgressively(
	hosts: readonly SshHostConfig[],
	onUpdate: (snapshot: ProviderConversationDiscoverySnapshot) => void,
	signal?: AbortSignal,
): Promise<ProviderConversationDiscoverySnapshot> {
	const seenHostIds = new Set<string>();
	const eligibleHosts: { host: SshHostConfig; hostId: string }[] = [];
	for (const host of hosts) {
		if (eligibleHosts.length >= MAX_AUTOMATIC_REMOTE_HOSTS) break;
		const hostId = host.id.trim();
		if (
			!hostId ||
			seenHostIds.has(hostId) ||
			!canScanWithoutInteraction(host)
		) {
			continue;
		}
		seenHostIds.add(hostId);
		eligibleHosts.push({ host, hostId });
	}
	const sources: ProviderConversationDiscoverySource[] = [
		{
			key: "local",
			kind: "local",
			status: "pending",
			count: 0,
		},
		...eligibleHosts.map(({ host, hostId }) => ({
			key: `ssh:${hostId}`,
			kind: "ssh" as const,
			label: host.name.trim() || hostId,
			hostId,
			status: "pending" as const,
			count: 0,
		})),
	];
	const recordsBySource = new Map<
		string,
		readonly ProviderConversationRecord[]
	>();
	let latest: ProviderConversationDiscoverySnapshot = {
		records: [],
		sources: sources.map((source) => ({ ...source })),
		complete: false,
	};
	const emit = () => {
		latest = {
			records: mergeRecords(recordsBySource),
			sources: sources.map((source) => ({ ...source })),
			complete: sources.every((source) => source.status !== "pending"),
		};
		if (!signal?.aborted) onUpdate(latest);
	};
	const settle = async (
		source: ProviderConversationDiscoverySource,
		request: Promise<ProviderConversationRecord[]>,
	) => {
		try {
			const records = (await request).slice(0, MAX_DISCOVERED_SESSIONS);
			recordsBySource.set(source.key, records);
			source.status = "succeeded";
			source.count = records.length;
		} catch {
			source.status = "failed";
			source.count = 0;
		}
		emit();
	};

	emit();
	await Promise.all([
		settle(
			sources[0],
			listProviderConversationRecords<ProviderConversationRecord>(),
		),
		...eligibleHosts.map(({ host, hostId }, index) =>
			settle(
				sources[index + 1],
				listRemoteProviderConversationRecords<ProviderConversationRecord>(
					hostId,
					hostToOpts(host),
				),
			),
		),
	]);
	return latest;
}

/** Read bounded provider-owned histories from this device and eligible saved
 * SSH hosts. Remote failures are isolated per host: a sleeping machine must
 * never hide usable local or other-host records. No provider CLI is invoked. */
export async function listProviderConversations(
	hosts: readonly SshHostConfig[] = [],
): Promise<ProviderConversationRecord[]> {
	const snapshot = await discoverProviderConversationsProgressively(
		hosts,
		() => undefined,
	);
	return [...snapshot.records];
}

function remoteTargetHost(
	target: ProviderConversationDetailsTarget,
	hosts: readonly SshHostConfig[],
): { hostId: string; host: SshHostConfig } {
	const hostId = target.hostId?.trim();
	const host = hosts.find((candidate) => candidate.id === hostId);
	if (!hostId || !host) {
		throw new Error("provider_conversation_host_unavailable");
	}
	return { hostId, host };
}

/** Read one exact source inventory only when a live Agent's Details opens. */
export async function loadProviderConversationRecord(
	target: ProviderConversationDetailsTarget,
	hosts: readonly SshHostConfig[],
): Promise<ProviderConversationRecord | undefined> {
	const records =
		target.executionLocation === "local"
			? await listProviderConversationRecords<ProviderConversationRecord>()
			: await (async () => {
					const { hostId, host } = remoteTargetHost(target, hosts);
					return listRemoteProviderConversationRecords<ProviderConversationRecord>(
						hostId,
						hostToOpts(host),
					);
				})();
	return records.find(
		(record) =>
			record.provider === target.provider &&
			record.id === target.conversationId &&
			record.executionLocation === target.executionLocation &&
			(target.executionLocation === "local" ||
				record.hostId === target.hostId?.trim()),
	);
}

/** Load bounded provider-native details for one exact conversation. The exact
 * execution host is part of the lookup identity, so equal provider
 * conversation IDs on two machines can never cross-read one another. */
export async function loadProviderConversationDetails(
	target: ProviderConversationDetailsTarget,
	hosts: readonly SshHostConfig[],
): Promise<ProviderConversationDetails> {
	if (target.executionLocation === "local") {
		return getProviderConversationDetails<ProviderConversationDetails>(
			target.provider,
			target.conversationId,
		);
	}
	const { hostId, host } = remoteTargetHost(target, hosts);
	return getRemoteProviderConversationDetails<ProviderConversationDetails>(
		hostId,
		hostToOpts(host),
		target.provider,
		target.conversationId,
	);
}

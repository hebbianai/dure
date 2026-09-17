import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxCatalogReceiptV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import type {
	HmuxManagedIdleReplacementGuardV1,
	HmuxSessionSummary,
} from "@/lib/ipc";
import { remoteHmuxCatalog, remoteHmuxKnownHostTrust } from "@/lib/ipc";
import {
	clearMaintenanceLaneInterval,
	requestMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import { requestRemoteManagedBuildRehost } from "@/lib/sessions/credentials/remoteManagedCredentialSwitch";
import {
	type AutomaticManagedRehostCandidate,
	type AutomaticManagedRehostPaneSnapshot,
	assessAutomaticManagedRehost,
} from "@/lib/sessions/managed/automaticManagedRehostPolicy";
import {
	AutomaticManagedRehostCoordinator,
	type AutomaticManagedRehostCoordinatorDependencies,
} from "@/lib/sessions/managed/automaticManagedRehostRuntime";
import {
	executeManagedAgentRehost,
	executeUnavailableManagedAgentRecovery,
	inspectDisconnectedManagedAgentRecovery,
	inspectManagedAgentRehost,
	type ManagedAgentRehostExecution,
	type ManagedAgentRehostInspection,
	managedAgentRehostSyncPayload,
	reconcileManagedAgentRehost,
} from "@/lib/sessions/managed/managedAgentRehost";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	commitManagedAgentRehostReceipt,
	commitReconciledManagedAgentRehostReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import {
	MANAGED_OBSERVATION_SHARE_MS,
	type ManagedControlPlaneObservation,
	observeManagedControlPlane,
} from "@/lib/sessions/managed/managedControlPlaneObservation";
import { automaticManagedRebootRecoveryCandidates } from "@/lib/sessions/managed/managedRebootRecovery";
import { projectRemoteAutomaticManagedRehostSession } from "@/lib/sessions/managed/remoteAutomaticManagedRehost";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { sshHostSecretId } from "@/lib/ssh/sshCredentialClaim";
import {
	getHmuxPaneHealth,
	publishHmuxPaneHealthObservation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const AUTOMATIC_MANAGED_REHOST_PASS_MS = 5_000;
const AUTOMATIC_MANAGED_REHOST_INITIAL_DELAY_MS = 2_000;
const AUTOMATIC_MANAGED_REHOST_DWELL_MS = 15_000;
const AUTOMATIC_MANAGED_REHOST_FAILURE_COOLDOWN_MS = 15_000;
const REMOTE_AUTOMATIC_REHOST_CATALOG_TTL_MS = 30_000;

type AutomaticManagedRehostObservation = ManagedControlPlaneObservation;

interface RemoteCatalogCacheEntry {
	key: string;
	expiresAt: number;
	receipt?: RemoteHmuxCatalogReceiptV1;
}

const remoteCatalogCache = new Map<string, RemoteCatalogCacheEntry>();

class AutomaticManagedRehostRaceError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "AutomaticManagedRehostRaceError";
	}
}

function exactSession(
	sessions: readonly HmuxSessionSummary[],
	agent: Agent,
): HmuxSessionSummary | undefined {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1") return undefined;
	return sessions.find(
		(session) =>
			session.sessionId === binding.sessionId &&
			session.workspaceId === binding.workspaceId &&
			(binding.source === "local"
				? session.runtimeHost === undefined || session.runtimeHost === "local"
				: session.runtimeHost === binding.hostId),
	);
}

function exactPane(
	state: ReturnType<typeof useStore.getState>,
	agent: Agent,
): AutomaticManagedRehostPaneSnapshot | undefined {
	const matches = agentPaneLocations(state.layouts, mountedDockviewEntries())
		.filter((pane) => pane.agentId === agent.id)
		.flatMap(({ desktopId, panelId }) => {
			const health = getHmuxPaneHealth(hmuxPaneHealthId(desktopId, panelId));
			return health ? [{ desktopId, panelId, health }] : [];
		});
	return matches.length === 1 ? matches[0] : undefined;
}

function remoteCatalogCacheKey(
	host: ReturnType<typeof useStore.getState>["sshHosts"][number],
): string {
	return JSON.stringify([
		host.id,
		host.host,
		host.port,
		host.user,
		host.auth,
		sshHostSecretId(host) ?? null,
		host.keyPath ?? null,
	]);
}

async function catalogForAutomaticManagedRehost(
	hostId: string,
	forceRefresh: boolean,
): Promise<RemoteHmuxCatalogReceiptV1 | undefined> {
	const state = useStore.getState();
	const host = state.sshHosts.find((candidate) => candidate.id === hostId);
	if (!host) return undefined;
	const key = remoteCatalogCacheKey(host);
	const now = Date.now();
	const cached = remoteCatalogCache.get(hostId);
	if (!forceRefresh && cached?.key === key && cached.expiresAt > now) {
		return cached.receipt;
	}
	try {
		const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
		const target = planRemoteHmuxCatalogTarget(state.sshHosts, host.id, trust);
		const receipt = await remoteHmuxCatalog(target);
		remoteCatalogCache.set(hostId, {
			key,
			expiresAt: now + REMOTE_AUTOMATIC_REHOST_CATALOG_TTL_MS,
			receipt,
		});
		return receipt;
	} catch (error) {
		remoteCatalogCache.set(hostId, {
			key,
			expiresAt: now + REMOTE_AUTOMATIC_REHOST_CATALOG_TTL_MS,
		});
		console.warn("[automatic managed rehost] remote catalog deferred", {
			hostId,
			error,
		});
		return undefined;
	}
}

async function observeRemoteManagedSessions(
	visibleDesktopIds: ReadonlySet<string>,
	forceRefresh: boolean,
): Promise<HmuxSessionSummary[]> {
	const state = useStore.getState();
	const agents = state.agents.filter((agent) => {
		const binding = agent.runtimeBinding;
		const pane = exactPane(state, agent);
		const runtime = state.sessionAgentRuntimeState[agent.sessionId];
		return (
			binding?.runtime === "hmux_managed_v1" &&
			binding.source === "ssh" &&
			pane !== undefined &&
			!visibleDesktopIds.has(pane.desktopId) &&
			state.agentActivity[agent.id] !== "working" &&
			runtime?.lifecycle === "running" &&
			runtime.activity === "waiting" &&
			runtime.attention === "none" &&
			!agent.pendingCredentialSwitch
		);
	});
	const hostIds = [
		...new Set(
			agents.flatMap((agent) => {
				const binding = agent.runtimeBinding;
				return binding?.runtime === "hmux_managed_v1" ? [binding.hostId] : [];
			}),
		),
	];
	const catalogs = new Map<string, RemoteHmuxCatalogReceiptV1>();
	await Promise.all(
		hostIds.map(async (hostId) => {
			const receipt = await catalogForAutomaticManagedRehost(
				hostId,
				forceRefresh,
			);
			if (receipt) catalogs.set(hostId, receipt);
		}),
	);
	return agents.flatMap((agent) => {
		const binding = agent.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1") return [];
		const receipt = catalogs.get(binding.hostId);
		const attached =
			state.hmuxSessionMetadata[
				hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)
			];
		const projected = receipt
			? projectRemoteAutomaticManagedRehostSession(agent, attached, receipt)
			: undefined;
		return projected ? [projected] : [];
	});
}

/** Local exact Host/window observation is shared with the shell service.
 * Remote catalog projections extend it without opening a global local census;
 * the destructive boundary forces both sources fresh. */
async function observeAutomaticManagedRehost(options: {
	maxAgeMs: number;
	forceRemoteCatalog?: boolean;
}): Promise<AutomaticManagedRehostObservation | undefined> {
	const local = await observeManagedControlPlane({
		maxAgeMs: options.maxAgeMs,
	});
	if (!local) return undefined;
	const remoteSessions = await observeRemoteManagedSessions(
		local.visibleDesktopIds,
		options.forceRemoteCatalog === true,
	);
	for (const session of remoteSessions) {
		useStore.getState().setHmuxSessionMetadata(session);
	}
	return {
		...local,
		sessions: [...local.sessions, ...remoteSessions],
	};
}

function eligibleCandidates(
	observation: AutomaticManagedRehostObservation,
): AutomaticManagedRehostCandidate[] {
	const state = useStore.getState();
	const candidates: AutomaticManagedRehostCandidate[] = [];
	for (const agent of state.agents) {
		const assessment = assessAutomaticManagedRehost({
			agent,
			session: exactSession(observation.sessions, agent),
			runtime: state.sessionAgentRuntimeState[agent.sessionId],
			pane: exactPane(state, agent),
			inputWorking: state.agentActivity[agent.id] === "working",
			visibleDesktopIds: observation.visibleDesktopIds,
		});
		if (assessment.eligible) candidates.push(assessment);
	}
	return candidates;
}

async function findEligibleAutomaticManagedRehosts(): Promise<
	readonly AutomaticManagedRehostCandidate[]
> {
	const observation = await observeAutomaticManagedRehost({
		maxAgeMs: MANAGED_OBSERVATION_SHARE_MS,
	});
	return observation ? eligibleCandidates(observation) : [];
}

type AutomaticManagedRehostInspection =
	| (ManagedAgentRehostInspection & { kind: "local" })
	| {
			kind: "remote";
			agentId: string;
			desktopId: string;
			panelId: string;
			sourceBinding: {
				sessionId: string;
				workspaceId: string;
			};
	  };

type AutomaticManagedRehostExecution =
	| { kind: "local"; execution: ManagedAgentRehostExecution }
	| { kind: "remote"; conversationId: string };

type AutomaticManagedRehostPayload =
	| { kind: "local"; payload: ManagedAgentRehostSyncPayload }
	| { kind: "remote"; agentId: string; conversationId: string };

async function inspectAutomaticManagedRehost(
	agentId: string,
	panelId: string,
): Promise<AutomaticManagedRehostInspection> {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const binding = agent?.runtimeBinding;
	if (!agent || binding?.runtime !== "hmux_managed_v1") {
		throw new AutomaticManagedRehostRaceError(
			"automatic_managed_rehost_agent_missing",
		);
	}
	if (binding.source === "local") {
		return {
			...(await inspectManagedAgentRehost(agentId, panelId)),
			kind: "local",
		};
	}
	const pane = exactPane(state, agent);
	if (!pane || pane.panelId !== panelId) {
		throw new AutomaticManagedRehostRaceError(
			"automatic_managed_rehost_pane_missing",
		);
	}
	return {
		kind: "remote",
		agentId,
		desktopId: pane.desktopId,
		panelId,
		sourceBinding: {
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		},
	};
}

async function assertAutomaticManagedRehostStillEligible(
	candidate: AutomaticManagedRehostCandidate,
	inspection: AutomaticManagedRehostInspection,
): Promise<HmuxManagedIdleReplacementGuardV1> {
	const observation = await observeAutomaticManagedRehost({
		maxAgeMs: 0,
		forceRemoteCatalog: candidate.source === "ssh",
	});
	if (!observation) {
		throw new AutomaticManagedRehostRaceError(
			"automatic_managed_rehost_visibility_unknown",
		);
	}
	const state = useStore.getState();
	const agent = state.agents.find(
		(current) => current.id === candidate.agentId,
	);
	const binding = agent?.runtimeBinding;
	if (!agent || binding?.runtime !== "hmux_managed_v1") {
		throw new AutomaticManagedRehostRaceError(
			"automatic_managed_rehost_agent_missing",
		);
	}
	const assessment = assessAutomaticManagedRehost({
		agent,
		session: exactSession(observation.sessions, agent),
		runtime: state.sessionAgentRuntimeState[agent.sessionId],
		pane: exactPane(state, agent),
		inputWorking: state.agentActivity[agent.id] === "working",
		visibleDesktopIds: observation.visibleDesktopIds,
	});
	if (
		!assessment.eligible ||
		assessment.identity !== candidate.identity ||
		assessment.desktopId !== inspection.desktopId ||
		assessment.panelId !== inspection.panelId ||
		assessment.source !== candidate.source ||
		assessment.hostId !== candidate.hostId ||
		(inspection.kind === "local" && inspection.sourceLifecycle !== "ready") ||
		inspection.sourceBinding.sessionId !== agent.sessionId ||
		inspection.sourceBinding.workspaceId !== binding.workspaceId ||
		(inspection.kind === "local" &&
			inspection.conversationId !== agent.conversationId?.trim())
	) {
		throw new AutomaticManagedRehostRaceError(
			"automatic_managed_rehost_no_longer_eligible",
		);
	}
	return assessment.idleReplacementGuard;
}

function automaticManagedRehostDependencies(): AutomaticManagedRehostCoordinatorDependencies<
	AutomaticManagedRehostInspection,
	AutomaticManagedRehostExecution,
	AutomaticManagedRehostPayload
> {
	return {
		now: Date.now,
		convergeInterrupted: createAutomaticManagedRebootConvergence(),
		findEligible: findEligibleAutomaticManagedRehosts,
		inspect: inspectAutomaticManagedRehost,
		assertStillEligible: assertAutomaticManagedRehostStillEligible,
		execute: async (inspection, options) => {
			if (inspection.kind === "local") {
				return {
					kind: "local",
					execution: await executeManagedAgentRehost(inspection, options),
				};
			}
			const idleReplacementGuard = await options.beforeStop();
			const result = await requestRemoteManagedBuildRehost(
				inspection.agentId,
				inspection.panelId,
				{ idleReplacementGuard },
			);
			return { kind: "remote", conversationId: result.conversationId };
		},
		payload: (inspection, execution) => {
			if (inspection.kind === "local" && execution.kind === "local") {
				return {
					kind: "local",
					payload: managedAgentRehostSyncPayload(
						inspection,
						execution.execution,
					),
				};
			}
			if (inspection.kind === "remote" && execution.kind === "remote") {
				return {
					kind: "remote",
					agentId: inspection.agentId,
					conversationId: execution.conversationId,
				};
			}
			throw new Error("automatic_managed_rehost_execution_source_changed");
		},
		synchronize: async (payload) => {
			if (payload.kind === "remote") return payload;
			const committed = await commitManagedAgentRehostReceipt(payload.payload, {
				activate: false,
			});
			return committed
				? { kind: "local" as const, payload: committed.payload }
				: null;
		},
		emit: (payload) => {
			if (payload.kind === "local") {
				publishManagedAgentRehostProjection(payload.payload);
			}
			return Promise.resolve();
		},
		onError: (error, candidate) => {
			if (error instanceof AutomaticManagedRehostRaceError) return;
			console.warn("[automatic managed rehost]", {
				error,
				agentId: candidate?.agentId,
				identity: candidate?.identity,
			});
		},
	};
}

function createAutomaticManagedRebootConvergence(): () => Promise<boolean> {
	const cooldownUntil = new Map<string, number>();
	const publishPaneRecoveryState = (
		candidate: ReturnType<
			typeof automaticManagedRebootRecoveryCandidates
		>[number],
		state: "recovering" | "error",
		reason: string,
	) => {
		const paneHealthId = hmuxPaneHealthId(
			candidate.desktopId,
			candidate.panelId,
		);
		publishHmuxPaneHealthObservation(paneHealthId, {
			kind: "connection",
			state,
			reason,
		});
	};
	return async () => {
		const observation = await observeAutomaticManagedRehost({
			maxAgeMs: MANAGED_OBSERVATION_SHARE_MS,
		});
		if (!observation) return false;
		const snapshot = useStore.getState();
		const candidates = automaticManagedRebootRecoveryCandidates({
			agents: snapshot.agents,
			projects: snapshot.projects,
			layouts: snapshot.layouts,
			mounted: mountedDockviewEntries(),
			sessions: observation.sessions,
			visibleDesktopIds: observation.visibleDesktopIds,
		}).sort((left, right) => left.identity.localeCompare(right.identity));
		const now = Date.now();
		for (const candidate of candidates) {
			if ((cooldownUntil.get(candidate.identity) ?? 0) > now) continue;
			publishPaneRecoveryState(
				candidate,
				"recovering",
				"automatic_reboot_recovery",
			);
		}
		let changed = false;
		for (const candidate of candidates) {
			if ((cooldownUntil.get(candidate.identity) ?? 0) > Date.now()) continue;
			let replacement: HmuxSessionSummary | undefined;
			try {
				const reconciled = await reconcileManagedAgentRehost(
					candidate.agentId,
					candidate.panelId,
				);
				if (reconciled) {
					replacement = reconciled.replacement;
					const committed = await commitReconciledManagedAgentRehostReceipt(
						reconciled,
						{
							activate: false,
						},
					);
					publishManagedAgentRehostProjection(committed.payload);
					cooldownUntil.delete(candidate.identity);
					changed = true;
					continue;
				}

				const freshObservation = await observeAutomaticManagedRehost({
					maxAgeMs: 0,
				});
				if (!freshObservation) continue;
				const freshState = useStore.getState();
				const stillEligible = automaticManagedRebootRecoveryCandidates({
					agents: freshState.agents,
					projects: freshState.projects,
					layouts: freshState.layouts,
					mounted: mountedDockviewEntries(),
					sessions: freshObservation.sessions,
					visibleDesktopIds: freshObservation.visibleDesktopIds,
				}).find((current) => current.identity === candidate.identity);
				if (!stillEligible) continue;
				const inspection = await inspectDisconnectedManagedAgentRecovery(
					stillEligible.agentId,
					stillEligible.conversationId,
					stillEligible.panelId,
				);
				if (
					inspection.sourceLifecycle !== "unavailable" ||
					inspection.desktopId !== stillEligible.desktopId ||
					inspection.sourceBinding.sessionId !==
						freshState.agents.find(
							(agent) => agent.id === stillEligible.agentId,
						)?.sessionId
				) {
					continue;
				}
				const execution = await executeUnavailableManagedAgentRecovery(
					inspection,
					{
						requireSocketOwnerAbsent: stillEligible.requireSocketOwnerAbsent,
					},
				);
				replacement = execution.recovery.replacement;
				const payload = managedAgentRehostSyncPayload(inspection, execution);
				useStore.getState().setHmuxSessionMetadata(replacement);
				const committed = await commitManagedAgentRehostReceipt(payload, {
					activate: false,
				});
				if (!committed) {
					throw new Error("automatic_managed_reboot_commit_deferred");
				}
				publishManagedAgentRehostProjection(committed.payload);
				cooldownUntil.delete(candidate.identity);
				changed = true;
			} catch (error) {
				// A completed successor is not a failed recovery. Leave attachment
				// health with its owner, including any live frame received meanwhile.
				if (!replacement) {
					publishPaneRecoveryState(
						candidate,
						"error",
						"automatic_reboot_recovery_failed",
					);
				}
				cooldownUntil.set(
					candidate.identity,
					Date.now() + AUTOMATIC_MANAGED_REHOST_FAILURE_COOLDOWN_MS,
				);
				console.warn("[automatic managed reboot recovery]", {
					error,
					phase: replacement ? "synchronization" : "replacement",
					replacementSessionId: replacement?.sessionId,
					agentId: candidate.agentId,
					identity: candidate.identity,
				});
			}
		}
		return changed;
	};
}

/** Main-window-only service. All eligibility is recomputed from fresh exact
 * Host session observations and fresh workspace-window leases again at the
 * destructive boundary. */
export function installAutomaticManagedRehostService(): () => void {
	const coordinator = new AutomaticManagedRehostCoordinator(
		automaticManagedRehostDependencies(),
		{
			eligibilityDwellMs: AUTOMATIC_MANAGED_REHOST_DWELL_MS,
			failureCooldownMs: AUTOMATIC_MANAGED_REHOST_FAILURE_COOLDOWN_MS,
		},
	);
	let disposed = false;
	const runPass = () => {
		if (disposed || document.visibilityState === "hidden") return;
		void coordinator.runPass();
	};
	const interval = setMaintenanceLaneInterval(
		runPass,
		AUTOMATIC_MANAGED_REHOST_PASS_MS,
		"managed-rehost-pass",
	);
	const wake = () => requestMaintenanceLaneInterval(interval);
	const initial = window.setTimeout(
		wake,
		AUTOMATIC_MANAGED_REHOST_INITIAL_DELAY_MS,
	);
	const unsubscribeStore = useStore.subscribe((state, previous) => {
		if (
			state.agents !== previous.agents ||
			state.agentActivity !== previous.agentActivity ||
			state.activeDesktopId !== previous.activeDesktopId
		) {
			wake();
		}
	});
	window.addEventListener("focus", wake);
	document.addEventListener("visibilitychange", wake);
	return () => {
		disposed = true;
		window.clearTimeout(initial);
		clearMaintenanceLaneInterval(interval);
		unsubscribeStore();
		window.removeEventListener("focus", wake);
		document.removeEventListener("visibilitychange", wake);
	};
}

import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { tryUpgradeManagedHmuxShell } from "@/lib/hmux/managed/managedHmuxShellUpgrade";
import {
	clearMaintenanceLaneInterval,
	requestMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import { hmuxManagedShellReady } from "@/lib/hmux/standalone/hmuxStandaloneRollout";
import {
	executeStandaloneHmuxRecovery,
	inspectStandaloneHmuxRecovery,
} from "@/lib/hmux/standalone/standaloneHmuxRecovery";
import { hmux } from "@/lib/ipc";
import {
	type AutomaticManagedShellCandidate,
	assessAutomaticManagedShell,
} from "@/lib/sessions/managed/automaticManagedShellPolicy";
import {
	MANAGED_OBSERVATION_SHARE_MS,
	type ManagedControlPlaneObservation,
	observeManagedControlPlane,
} from "@/lib/sessions/managed/managedControlPlaneObservation";
import {
	automaticManagedShellRebootRecoveryCandidates,
	automaticStandaloneRebootRecoveryCandidates,
} from "@/lib/sessions/managed/managedRebootRecovery";
import {
	clearManagedShellMigrationLayout,
	type ManagedShellMigrationPayloadV1,
	managedShellMigrationPayloadFromPanel,
	managedShellMigrationTargetBinding,
	projectManagedShellMigrationLayout,
} from "@/lib/sessions/managed/managedShellMigration";
import { publishHmuxPaneHealthObservation } from "@/lib/terminal/hmuxPaneHealthStore";
import { isTerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { publishLayoutPush } from "@/lib/workspace/layout/layoutPushChannel";
import { useStore } from "@/store";

const INITIAL_DELAY_MS = 2_000;
const PASS_MS = 5_000;
const DWELL_MS = 15_000;
const FAILURE_COOLDOWN_MS = 15_000;

type Observation = ManagedControlPlaneObservation;

function sourceKey(workspaceId: string, sessionId: string): string {
	return JSON.stringify([workspaceId, sessionId]);
}

function publishPaneRecoveryState(
	candidate: { desktopId: string; panelId: string },
	state: "recovering" | "error",
	reason: string,
): void {
	const paneHealthId = hmuxPaneHealthId(
		candidate.desktopId,
		candidate.panelId,
	);
	publishHmuxPaneHealthObservation(paneHealthId, {
		kind: "connection",
		state,
		reason,
	});
}

/** 주기 패스는 rehost 서비스와 exact 관측을 공유한다(짧은 TTL). promote의
 *  파괴 경계 재확인은 maxAgeMs: 0으로 신선 관측을 강제한다. */
function observe(options: {
	maxAgeMs: number;
}): Promise<Observation | undefined> {
	return observeManagedControlPlane(options);
}

function pendingMigrations(): ManagedShellMigrationPayloadV1[] {
	return Object.entries(useStore.getState().layouts).flatMap(
		([desktopId, layout]) =>
			panelsFromLayout(layout).flatMap((panel) => {
				const payload = managedShellMigrationPayloadFromPanel(
					desktopId,
					panel.id,
					panel.params,
				);
				return payload ? [payload] : [];
			}),
	);
}

function retirementSettled(state: string, reason?: string): boolean {
	return (
		state === "retirement_armed" ||
		reason === "source_absent" ||
		reason === "source_exited" ||
		reason === "generation_changed"
	);
}

async function retryPendingMigration(
	payload: ManagedShellMigrationPayloadV1,
): Promise<void> {
	const receipt = await hmux.sweepAppStandaloneShell(
		payload.source.sessionId,
		payload.source.workspaceId,
		payload.sourceTerminalEpoch,
		payload.target.sessionId,
		payload.target.workspaceId,
		payload.targetTerminalEpoch,
	);
	if (!retirementSettled(receipt.state, receipt.reason)) return;
	const current = useStore.getState().layouts[payload.desktopId];
	const cleared = clearManagedShellMigrationLayout(current, payload);
	if (!cleared.cleared) return;
	useStore.getState().saveLayout(payload.desktopId, cleared.layout);
	publishLayoutPush([payload.desktopId]);
}

function candidates(
	observation: Observation,
): AutomaticManagedShellCandidate[] {
	const state = useStore.getState();
	const mountedDesktopIds = new Set(
		mountedDockviewEntries().map(([desktopId]) => desktopId),
	);
	const panes = Object.entries(state.layouts).flatMap(([desktopId, layout]) =>
		panelsFromLayout(layout).flatMap((panel) => {
			const binding = isTerminalPaneBindingV1(panel.params.binding)
				? panel.params.binding
				: undefined;
			return binding?.runtime === "hmux_standalone_v1" &&
				binding.source === "local"
				? [{ desktopId, panel, binding }]
				: [];
		}),
	);
	const consumerCounts = new Map<string, number>();
	for (const pane of panes) {
		const key = sourceKey(pane.binding.workspaceId, pane.binding.sessionId);
		consumerCounts.set(key, (consumerCounts.get(key) ?? 0) + 1);
	}
	const bySession = new Map(
		observation.sessions.map((session) => [
			hmuxSessionMetadataKey(session.workspaceId, session.sessionId),
			session,
		]),
	);
	return panes.flatMap(({ desktopId, panel, binding }) => {
		const assessment = assessAutomaticManagedShell({
			desktopId,
			panelId: panel.id,
			source: binding,
			session: bySession.get(
				hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId),
			),
			sourceConsumerCount:
				consumerCounts.get(sourceKey(binding.workspaceId, binding.sessionId)) ??
				0,
			agentDetected: Boolean(
				state.sessionAgentPin[binding.sessionId] ??
					state.sessionAgent[binding.sessionId] ??
					state.agents.some((agent) => agent.sessionId === binding.sessionId),
			),
			desktopVisible:
				observation.visibleDesktopIds.has(desktopId) ||
				mountedDesktopIds.has(desktopId),
			migrationPending: panel.params.managedShellMigration !== undefined,
		});
		return assessment.eligible ? [assessment] : [];
	});
}

async function promote(
	candidate: AutomaticManagedShellCandidate,
): Promise<void> {
	const observation = await observe({ maxAgeMs: 0 });
	const current = observation
		? candidates(observation).find(
				(next) => next.identity === candidate.identity,
			)
		: undefined;
	if (!current) return;
	const receipt = await hmux.promoteAppStandaloneShell({
		sourceSessionId: current.source.sessionId,
		sourceWorkspaceId: current.source.workspaceId,
		sourceTerminalEpoch: current.sourceTerminalEpoch,
	});
	if (
		receipt.sourceSessionId !== current.source.sessionId ||
		receipt.sourceWorkspaceId !== current.source.workspaceId ||
		receipt.sourceTerminalEpoch !== current.sourceTerminalEpoch ||
		receipt.target.session.sessionClass !== "managed" ||
		!receipt.target.session.stopFence
	) {
		throw new Error("managed shell promotion receipt identity mismatch");
	}
	const payload: ManagedShellMigrationPayloadV1 = {
		schemaVersion: 1,
		operationId: receipt.target.idempotencyKey,
		source: current.source,
		sourceTerminalEpoch: current.sourceTerminalEpoch,
		target: managedShellMigrationTargetBinding({
			sessionId: receipt.target.session.sessionId,
			workspaceId: receipt.target.session.workspaceId,
			idempotencyKey: receipt.target.idempotencyKey,
			stopFence: receipt.target.session.stopFence,
		}),
		targetTerminalEpoch: receipt.target.session.terminalEpoch,
		desktopId: current.desktopId,
		panelId: current.panelId,
		cwd: receipt.cwd,
	};
	const layout = useStore.getState().layouts[current.desktopId];
	const projected = projectManagedShellMigrationLayout(layout, payload);
	if (projected.state !== "source" && projected.state !== "target") {
		if (receipt.target.outcome === "created") {
			await hmux.stopManaged(
				`cancel_${receipt.target.idempotencyKey}`,
				receipt.target.session.sessionId,
				receipt.target.session.workspaceId,
				receipt.target.session.stopFence,
			);
		}
		return;
	}
	useStore.getState().setHmuxSessionMetadata(receipt.target.session);
	useStore.getState().saveLayout(current.desktopId, projected.layout);
	publishLayoutPush([current.desktopId]);
	await retryPendingMigration(payload);
}

async function recoverRebootStaleShells(
	observation: Observation,
	failedAt: Map<string, number>,
): Promise<boolean> {
	const snapshot = useStore.getState();
	const claimedSessionIds = new Set([
		...snapshot.agents.map((agent) => agent.sessionId),
		...Object.keys(snapshot.sessionAgent),
		...Object.keys(snapshot.sessionAgentPin),
	]);
	const managedCandidates = automaticManagedShellRebootRecoveryCandidates({
		layouts: snapshot.layouts,
		sessions: observation.sessions,
		visibleDesktopIds: observation.visibleDesktopIds,
		claimedSessionIds,
	});
	const standaloneCandidates = automaticStandaloneRebootRecoveryCandidates({
		layouts: snapshot.layouts,
		sessions: observation.sessions,
		visibleDesktopIds: observation.visibleDesktopIds,
	});
	const now = Date.now();
	for (const candidate of [...managedCandidates, ...standaloneCandidates]) {
		if (now - (failedAt.get(candidate.identity) ?? 0) < FAILURE_COOLDOWN_MS) {
			continue;
		}
		publishPaneRecoveryState(
			candidate,
			"recovering",
			"automatic_reboot_recovery",
		);
	}
	let changed = false;
	for (const candidate of managedCandidates) {
		if (
			Date.now() - (failedAt.get(candidate.identity) ?? 0) <
			FAILURE_COOLDOWN_MS
		) {
			continue;
		}
		try {
			const result = await tryUpgradeManagedHmuxShell(
				{
					targetPanelId: candidate.panelId,
					confirmRestart: true,
					forceRestart: true,
					activate: false,
				},
				async () => {
					const freshObservation = await observe({ maxAgeMs: 0 });
					if (!freshObservation) return false;
					const freshState = useStore.getState();
					const freshClaimedSessionIds = new Set([
						...freshState.agents.map((agent) => agent.sessionId),
						...Object.keys(freshState.sessionAgent),
						...Object.keys(freshState.sessionAgentPin),
					]);
					return automaticManagedShellRebootRecoveryCandidates({
						layouts: freshState.layouts,
						sessions: freshObservation.sessions,
						visibleDesktopIds: freshObservation.visibleDesktopIds,
						claimedSessionIds: freshClaimedSessionIds,
					}).some((entry) => entry.identity === candidate.identity);
				},
			);
			if (!result) continue;
			failedAt.delete(candidate.identity);
			changed = true;
		} catch (error) {
			publishPaneRecoveryState(
				candidate,
				"error",
				"automatic_managed_shell_recovery_failed",
			);
			failedAt.set(candidate.identity, Date.now());
			console.warn("[automatic managed-shell reboot recovery]", {
				error,
				identity: candidate.identity,
				panelId: candidate.panelId,
			});
		}
	}

	for (const candidate of standaloneCandidates) {
		if (
			Date.now() - (failedAt.get(candidate.identity) ?? 0) <
			FAILURE_COOLDOWN_MS
		) {
			continue;
		}
		try {
			const freshObservation = await observe({ maxAgeMs: 0 });
			const current = freshObservation
				? automaticStandaloneRebootRecoveryCandidates({
						layouts: useStore.getState().layouts,
						sessions: freshObservation.sessions,
						visibleDesktopIds: freshObservation.visibleDesktopIds,
					}).find((entry) => entry.identity === candidate.identity)
				: undefined;
			if (!current) continue;
			const inspection = await inspectStandaloneHmuxRecovery(current.panelId);
			if (
				!inspection ||
				inspection.source.desktopId !== current.desktopId ||
				inspection.source.panelId !== current.panelId ||
				inspection.source.sessionId !== current.source.sessionId ||
				inspection.source.workspaceId !== current.source.workspaceId
			) {
				continue;
			}
			await executeStandaloneHmuxRecovery(inspection);
			failedAt.delete(candidate.identity);
			changed = true;
		} catch (error) {
			publishPaneRecoveryState(
				candidate,
				"error",
				"automatic_standalone_recovery_failed",
			);
			failedAt.set(candidate.identity, Date.now());
			console.warn("[automatic standalone reboot recovery]", {
				error,
				identity: candidate.identity,
				panelId: candidate.panelId,
			});
		}
	}
	return changed;
}

/** Main-window service. It never takes focus or input ownership. Existing
 * standalone shells migrate only while unmounted/offscreen, and Host-side
 * preview/sweep checks remain the mutation authority. */
export function installAutomaticManagedShellService(): () => void {
	const seenAt = new Map<string, number>();
	const failedAt = new Map<string, number>();
	let disposed = false;
	let inFlight = false;
	const runPass = async () => {
		if (disposed || inFlight) return;
		inFlight = true;
		try {
			const observation = await observe({
				maxAgeMs: MANAGED_OBSERVATION_SHARE_MS,
			});
			if (!observation) return;
			if (await recoverRebootStaleShells(observation, failedAt)) return;
			if (!(await hmuxManagedShellReady())) return;
			for (const pending of pendingMigrations()) {
				await retryPendingMigration(pending).catch((error) => {
					console.warn("[automatic managed shell retirement]", error);
				});
			}
			const now = Date.now();
			const eligible = candidates(observation);
			const identities = new Set(
				eligible.map((candidate) => candidate.identity),
			);
			for (const identity of seenAt.keys()) {
				if (!identities.has(identity)) seenAt.delete(identity);
			}
			for (const candidate of eligible) {
				const first = seenAt.get(candidate.identity) ?? now;
				seenAt.set(candidate.identity, first);
				if (now - first < DWELL_MS) continue;
				if (
					now - (failedAt.get(candidate.identity) ?? 0) <
					FAILURE_COOLDOWN_MS
				) {
					continue;
				}
				try {
					await promote(candidate);
					seenAt.delete(candidate.identity);
				} catch (error) {
					failedAt.set(candidate.identity, Date.now());
					console.warn("[automatic managed shell]", error);
				}
				break;
			}
		} finally {
			inFlight = false;
		}
	};
	const interval = setMaintenanceLaneInterval(
		() => void runPass(),
		PASS_MS,
		"managed-shell-pass",
	);
	const wake = () => requestMaintenanceLaneInterval(interval);
	const initial = window.setTimeout(wake, INITIAL_DELAY_MS);
	window.addEventListener("focus", wake);
	document.addEventListener("visibilitychange", wake);
	return () => {
		disposed = true;
		window.clearTimeout(initial);
		clearMaintenanceLaneInterval(interval);
		window.removeEventListener("focus", wake);
		document.removeEventListener("visibilitychange", wake);
	};
}

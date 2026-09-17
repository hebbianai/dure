import { createDockview } from "dockview-react";
import { registerAgentDurably } from "@/lib/agents/durableAgentRegistration";
import {
	type CliHmuxStopRuntime,
	handleCliHmuxStop,
	resolveCliHmuxStopTarget,
} from "@/lib/cli/cliHmuxStop";
import { type HmuxRetireExitedItem, hmux } from "@/lib/ipc";
import { agentClaimPanesFromLayouts } from "@/lib/plugins/agentClaimPaneRegistry";
import { cleanupExitedManagedAgentRegistration } from "@/lib/sessions/cleanup/exitedManagedAgentCleanupRuntime";
import {
	finalizeManagedAgentRemoval,
	prepareManagedAgentStopOperation,
	prepareManagedAgentStopTarget,
	reconcileManagedAgentStop,
	stopManagedAgentProvider,
	stopPreparedManagedAgentProvider,
} from "@/lib/sessions/managed/managedAgentStop";
import { isAgentPaneMounted } from "@/lib/workspace/layout/agentPaneLocations";
import { createSpacesPaneProjection } from "@/lib/spaces/spacesPaneProjection";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import type { Project } from "@/types";

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export async function archiveStoppedSession(
	target: HmuxRetireExitedItem & { terminalEpoch: string },
) {
	const deadline = performance.now() + 20_000;
	let admitted: HmuxRetireExitedItem | undefined;
	while (true) {
		if (admitted) {
			const [receipt] = await hmux.retireExitedSessions([admitted], true);
			const sameTarget =
				receipt?.sessionId === target.sessionId &&
				receipt.workspaceId === target.workspaceId;
			if (sameTarget && receipt.outcome === "retired") return receipt;
			check(
				sameTarget &&
					receipt.outcome === "skipped" &&
					receipt.reason === "lifetime_busy" &&
					performance.now() < deadline,
				`QA discovery retirement failed: ${JSON.stringify(receipt)}`,
			);
			// Preview does not reserve the Host lifetime. Retry only its explicit
			// busy receipt with the same generation, never an uncertain response.
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			continue;
		}
		const [preview] = await hmux.retireExitedSessions([target], false);
		check(
			preview?.sessionId === target.sessionId &&
				preview.workspaceId === target.workspaceId,
			"QA retirement preview returned a different session",
		);
		if (preview.outcome === "retirable") {
			check(
				preview.generation?.fence.terminalEpoch === target.terminalEpoch,
				"QA retirement preview did not preserve the stopped generation",
			);
			admitted = { ...target, generation: preview.generation };
			continue;
		}
		check(
			preview.outcome === "skipped" &&
				(preview.reason === "lifetime_busy" ||
					preview.reason === "not_exited") &&
				performance.now() < deadline,
			`QA stopped generation is not retirable: ${JSON.stringify(preview)}`,
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 250));
	}
}

export interface AgentRemovalPaneStopProbe {
	scenario:
		| "exact"
		| "exact-cleanup-retry"
		| "exact-stale-binding-retry"
		| "exact-fenceless-retry"
		| "chain-cleanup-retry"
		| "exact-archived-cleanup-retry"
		| "chain-archived-cleanup-retry";
	sessionId: string;
	panelId: string;
	registeredTerminalEpoch: string | null;
	runtimeTerminalEpoch: string;
	stopCalls: number;
	cleanupCalls: number;
	readerAgentIds?: { mounted: boolean; spaces?: string; plugin?: string };
	first?: Awaited<ReturnType<typeof handleCliHmuxStop>>;
	replay?: Awaited<ReturnType<typeof handleCliHmuxStop>>;
	retirement?: Awaited<ReturnType<typeof hmux.readManagedSessionRetirement>>;
	preparedReplayKind?: string;
	preparedReplayReceipt?: Awaited<
		ReturnType<typeof stopPreparedManagedAgentProvider>
	>;
	archival?: Awaited<ReturnType<typeof archiveStoppedSession>>;
	discoveryAbsentBeforeReplay?: boolean;
	sourceLifecycle?: string;
}

/** Invoked only inside the removal runner's verified disposable home. The
 * request claim is a fixture; pane lookup, native stop and durable cleanup are real. */
export async function probeAgentRemovalPaneStop(
	runId: string,
	project: Project,
	results: AgentRemovalPaneStopProbe[],
) {
	for (const scenario of [
		"exact",
		"exact-cleanup-retry",
		"exact-stale-binding-retry",
		"exact-fenceless-retry",
		"chain-cleanup-retry",
		"exact-archived-cleanup-retry",
		"chain-archived-cleanup-retry",
	] as const) {
		const chain =
			scenario === "chain-cleanup-retry" ||
			scenario === "chain-archived-cleanup-retry";
		const archive =
			scenario === "exact-archived-cleanup-retry" ||
			scenario === "chain-archived-cleanup-retry";
		const sessionId = `qa-pane-stop-${runId}-${scenario}`;
		const workspaceId = `qa-pane-stop-${runId}`;
		const created = await hmux.createManagedShell({
			idempotencyKey: sessionId,
			sessionId,
			workspaceId,
			cwd: project.path,
			columns: 80,
			rows: 24,
			terminalDefaultColors: { foregroundRgb: 0xffffff, backgroundRgb: 0 },
		});
		check(
			created.session.sessionId === sessionId &&
				created.session.workspaceId === workspaceId &&
				created.session.stopFence,
			"Unexpected QA managed shell identity",
		);
		const runtimeFence = created.session.stopFence;
		// Only the saved projection is stale; the managed shell and its exact
		// native stop are real. This fixture does not simulate a provider rehost.
		const registeredFence =
			scenario === "exact-fenceless-retry" ||
			scenario === "exact-archived-cleanup-retry"
				? undefined
				: scenario === "exact-stale-binding-retry"
					? {
							...runtimeFence,
							terminalEpoch: `${runtimeFence.terminalEpoch}-previous`,
						}
					: runtimeFence;
		const agent = await registerAgentDurably(
			{
				id: `agent-${sessionId}`,
				name: sessionId,
				provider: "codex",
				projectId: project.id,
				worktreePath: project.path,
				branch: "main",
				sessionKind: "pty",
				sessionId,
				started: true,
				runtimeBinding: {
					...hmuxManagedBinding(sessionId, workspaceId),
					...(registeredFence ? { stopFence: registeredFence } : {}),
					...(chain ? { createIdempotencyKey: created.idempotencyKey } : {}),
				},
			},
			project,
		);
		check(
			agent.runtimeBinding?.runtime === "hmux_managed_v1" &&
				agent.runtimeBinding.stopFence?.terminalEpoch ===
					registeredFence?.terminalEpoch,
			"QA registration did not preserve the intended saved generation",
		);
		const container = document.createElement("div");
		container.style.cssText =
			"position:fixed;width:900px;height:600px;visibility:hidden";
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
			}),
		});
		api.layout(900, 600);
		registerDockview(sessionId, api);
		try {
			const panelId = `slot-${runId}-${scenario}`;
			const panel = api.addPanel({
				id: panelId,
				component: "agent",
				params: { agentRef: { agentId: agent.id } },
			});
			let stopCalls = 0;
			let cleanupCalls = 0;
			let failPublication = scenario !== "exact";
			const runtime: CliHmuxStopRuntime = {
				claim: async () => true,
				resolve: resolveCliHmuxStopTarget,
				prepare: prepareManagedAgentStopTarget,
				reconcile: reconcileManagedAgentStop,
				cleanupExited: (target) => {
					cleanupCalls += 1;
					return cleanupExitedManagedAgentRegistration(target);
				},
				stop: async (target) => {
					stopCalls += 1;
					return stopManagedAgentProvider(target);
				},
				finalize: async (target, receipt) => {
					if (failPublication) {
						failPublication = false;
						api.removePanel(panel);
						throw new Error(
							"QA publication failure after accepted native stop",
						);
					}
					await finalizeManagedAgentRemoval(target, receipt);
				},
			};
			const input = { name: agent.id, targetPanelId: panelId };
			const observation: AgentRemovalPaneStopProbe = {
				scenario,
				sessionId,
				panelId,
				registeredTerminalEpoch:
					agent.runtimeBinding.stopFence?.terminalEpoch ?? null,
				runtimeTerminalEpoch: runtimeFence.terminalEpoch,
				stopCalls,
				cleanupCalls,
			};
			results.push(observation);
			const rows = createSpacesPaneProjection()(
				{},
				sessionId,
				[sessionId],
				api.panels.map((pane) => ({
					...dockPanelReference(pane),
					isVisible: pane.api.isVisible,
				})),
			);
			observation.readerAgentIds = {
				mounted: isAgentPaneMounted(agent.id, [[sessionId, api]]),
				spaces: rows.find((row) => row.key === panelId)?.agentId,
				plugin: agentClaimPanesFromLayouts({ [sessionId]: api.toJSON() }).find(
					(pane) => pane.id === panelId,
				)?.agentId,
			};
			check(
				observation.readerAgentIds.mounted &&
					observation.readerAgentIds.spaces === agent.id &&
					observation.readerAgentIds.plugin === agent.id,
				`Neutral pane readers disagree: ${JSON.stringify(observation.readerAgentIds)}`,
			);
			const first = await handleCliHmuxStop(
				input,
				`${sessionId}-first`,
				runtime,
			);
			observation.first = first;
			observation.stopCalls = stopCalls;
			observation.cleanupCalls = cleanupCalls;
			check(
				first &&
					"stop" in first &&
					first.stop &&
					first.agent?.panelId === panelId,
				`Missing exact CLI stop receipt: ${JSON.stringify(first)}`,
			);
			const exactStop =
				"chain" in first.stop ? first.stop.stopReceipt : first.stop;
			check(
				exactStop?.terminalEpoch === runtimeFence.terminalEpoch,
				"Native stop did not use the current runtime generation",
			);
			if (!chain) {
				const retirement = await hmux.readManagedSessionRetirement(
					sessionId,
					workspaceId,
				);
				observation.retirement = retirement;
				check(
					retirement.kind === "finalized" &&
						JSON.stringify(retirement.receipt) === JSON.stringify(exactStop),
					"Permanent retirement did not preserve the accepted native stop",
				);
			}
			let replay: Awaited<ReturnType<typeof handleCliHmuxStop>> | undefined;
			if (scenario !== "exact") {
				check(
					!first.ok && !api.getPanel(panelId),
					"Expected accepted stop with a vanished pane and failed publication",
				);
				if (archive) {
					observation.archival = await archiveStoppedSession({
						sessionId,
						workspaceId,
						terminalEpoch: runtimeFence.terminalEpoch,
					});
					observation.discoveryAbsentBeforeReplay = !(
						await hmux.listSessions()
					).some((session) => session.sessionId === sessionId);
					check(
						observation.discoveryAbsentBeforeReplay,
						"Archived session remains discoverable",
					);
					check(
						useStore
							.getState()
							.agents.some((current) => current.id === agent.id),
						"QA archival removed the Agent before completion replay",
					);
				}
				const prepared = await prepareManagedAgentStopOperation(agent);
				observation.preparedReplayKind = prepared.kind;
				check(
					prepared.kind === "completed",
					"GUI stop preparation did not reuse the accepted native result",
				);
				observation.preparedReplayReceipt =
					await stopPreparedManagedAgentProvider(prepared);
				check(
					JSON.stringify(observation.preparedReplayReceipt) ===
						JSON.stringify(first.stop),
					"GUI preparation changed the accepted stop receipt",
				);
				replay = await handleCliHmuxStop(
					input,
					`${sessionId}-cleanup`,
					runtime,
				);
				observation.replay = replay;
				observation.stopCalls = stopCalls;
				observation.cleanupCalls = cleanupCalls;
				check(
					replay?.ok &&
						"stop" in replay &&
						JSON.stringify(replay.stop) === JSON.stringify(first.stop) &&
						replay.agent?.panelId === panelId,
					`Cleanup-only replay failed: ${JSON.stringify(replay)}`,
				);
			} else check(first.ok, "Exact native stop did not finalize");
			check(stopCalls === 1, "Cleanup replay repeated native stop");
			check(
				cleanupCalls === 1,
				"Completed stop attempted discovery archival again",
			);
			check(
				!useStore.getState().agents.some((current) => current.id === agent.id),
				"Stopped Agent registration remains",
			);
			const source = (await hmux.listSessions()).find(
				(entry) =>
					entry.sessionId === sessionId && entry.workspaceId === workspaceId,
			);
			check(
				!source || source.lifecycle === "exited",
				"Stopped native session is still live",
			);
			observation.sourceLifecycle = source?.lifecycle ?? "absent";
		} finally {
			unregisterDockview(sessionId, api);
			api.dispose();
			container.remove();
		}
	}
}

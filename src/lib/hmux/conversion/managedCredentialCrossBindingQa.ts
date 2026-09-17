import { requestAgentCredentialTransition } from "@/lib/agents/agentCredentialTransition";
import { addAgent } from "@/lib/agents/agentRegistration";
import { removeAgentWithResources } from "@/lib/agents/resourceLifecycle";
import { compareCanonicalDecimalStrings } from "@/lib/decimalString";
import { inspectHmuxSessionsExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { hmux, homeDir, listDir } from "@/lib/ipc";
import { isAuthoritativeIdleRuntimeState } from "@/lib/sessions/credentials/deferredCredentialSwitch";
import {
	sendHmuxAgentCommandInput,
	sendHmuxInitialAgentPrompt,
} from "@/lib/sessions/managed/managedAgentInput";
import {
	ensureManagedAgentRuntime,
	ensureManagedConversationIdentity,
	MANAGED_BOOTSTRAP_GEOMETRY,
} from "@/lib/sessions/managed/managedAgentRuntime";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import type { StructuredTerminalQaInputObservation } from "@/lib/terminal/qa/structuredTerminalQaProbe";
import { openAgentPanel } from "@/lib/workspace/dock";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import type { AccountProfile, Agent } from "@/types";
import {
	ManagedCredentialQaSurface,
	managedCredentialTargetSurfaceStayedContinuous,
	sameTerminalGrid,
	structuredTerminalGrid,
} from "./managedCredentialQaSurface";

const MANAGED_LAUNCH_READY_MARKER = ".qa-managed-launch-ready";

function managedCredentialQaMarker(
	runId: string,
	surface: "A" | "B",
	sequence: number,
): string {
	return `HMUX_WINDOW_QA_${runId}_${surface}_${sequence.toString().padStart(4, "0")}`;
}

function managedCredentialQaInputProof(
	marker: string,
	observation: StructuredTerminalQaInputObservation,
) {
	return {
		marker,
		requestId: observation.receipt.requestId,
		state: observation.receipt.state,
		markerCounts: observation.markerCounts,
	};
}

async function cleanupManagedCredentialQaResources(
	resources: readonly ManagedCredentialQaResource[],
) {
	const failures: Error[] = [];
	let removedAgents = 0;
	let surfaceRetirements = 0;
	for (const { agentId, surface } of [...resources].reverse()) {
		const retirement = surface?.waitForRetirement();
		try {
			await removeAgentWithResources(agentId);
			removedAgents += 1;
		} catch (error) {
			failures.push(asError(error));
		}
		if (retirement) {
			const result = await settleQaStep(retirement);
			if (result.ok) surfaceRetirements += 1;
			else failures.push(result.error);
		}
	}
	const surfaces = resources.flatMap(({ surface }) =>
		surface ? [surface] : [],
	);
	const probeDisconnections = surfaces.reduce(
		(total, surface) => total + surface.snapshot().disconnections,
		0,
	);
	for (const error of surfaces.flatMap(
		(surface) => surface.snapshot().errors,
	)) {
		failures.push(new Error(`managed structured surface failed: ${error}`));
	}
	for (const surface of surfaces) {
		try {
			surface.dispose();
		} catch (error) {
			failures.push(asError(error));
		}
	}
	if (failures.length > 0) {
		throw combinedError("managed credential QA cleanup failed", failures);
	}
	return {
		probesDisposed: surfaces.length,
		probeDisconnections,
		removedAgents,
		surfaceRetirements,
	};
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function combinedError(message: string, errors: Error[]): Error {
	return new Error(
		`${message}: ${errors.map((error) => error.message).join("; ")}`,
	);
}

async function waitForManagedLaunchFixture(): Promise<void> {
	const home = await homeDir();
	const markerDirectory = `${home.replace(/\/+$/u, "")}/.dure`;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		const ready = await listDir(markerDirectory, true)
			.then((entries) =>
				entries.some((entry) => entry.name === MANAGED_LAUNCH_READY_MARKER),
			)
			.catch(() => false);
		if (ready) return;
		await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
	}
	throw new Error("timed out waiting for selected-account launch fixture");
}

function currentAgent(agentId: string): Agent {
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
	if (!agent) {
		throw new Error(`managed credential QA agent disappeared: ${agentId}`);
	}
	return agent;
}

function managedAgentSnapshot(agent: Agent) {
	const api = getDockview(useStore.getState().activeSpaceId);
	const pane = api && findAgentPanel(api, agent.id);
	if (!pane)
		throw new Error(`managed credential QA lost its Agent pane: ${agent.id}`);
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
		throw new Error(`managed credential QA lost runtime binding: ${agent.id}`);
	}
	const conversationId = managedConversationId(agent);
	if (!conversationId) {
		throw new Error(
			`managed credential QA lacks exact conversation: ${agent.id}`,
		);
	}
	return {
		agentId: agent.id,
		panelId: pane.id,
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		conversationId,
		credentialId: binding.credentialId ?? null,
		createIdempotencyKey: binding.createIdempotencyKey ?? null,
		stopFence: binding.stopFence ?? null,
	};
}

async function waitForManagedTurnAfter(
	snapshot: ReturnType<typeof managedAgentSnapshot>,
	completedTurnCount: string,
): Promise<string> {
	const deadline = Date.now() + 90_000;
	let lastRuntime: unknown;
	while (Date.now() < deadline) {
		const [inspection] = await inspectHmuxSessionsExact([
			{
				sessionId: snapshot.sessionId,
				workspaceId: snapshot.workspaceId,
			},
		]);
		if (inspection?.outcome === "found") {
			const runtime = inspection.agentRuntimeState;
			lastRuntime = runtime;
			if (
				runtime &&
				isAuthoritativeIdleRuntimeState(runtime) &&
				runtime.turnCompletedCount !== undefined &&
				compareCanonicalDecimalStrings(
					runtime.turnCompletedCount,
					completedTurnCount,
				) > 0
			) {
				return runtime.turnCompletedCount;
			}
		}
		await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
	}
	throw new Error(
		`managed turn after ${completedTurnCount} did not complete: ${snapshot.agentId}; ${JSON.stringify(lastRuntime ?? null)}`,
	);
}

async function launchManagedConversation(
	projectId: string,
	name: string,
	accountId: string | null,
	prompt: string,
	resources: ManagedCredentialQaResource[],
) {
	const agent = await addAgent({
		projectId,
		name,
		provider: "codex",
		useWorktree: false,
		accountId,
	});
	const resource: ManagedCredentialQaResource = { agentId: agent.id };
	resources.push(resource);
	const receipt = await ensureManagedAgentRuntime(agent, {
		...MANAGED_BOOTSTRAP_GEOMETRY,
		initialPrompt: prompt,
	});
	const launched = currentAgent(agent.id);
	const desktopId = useStore.getState().activeSpaceId;
	const panelId = openAgentPanel(desktopId, launched);
	if (!panelId)
		throw new Error(
			`managed credential QA could not present Agent: ${agent.id}`,
		);
	const surface = new ManagedCredentialQaSurface(desktopId, panelId);
	resource.surface = surface;
	if (!receipt.initialPromptAccepted) {
		await sendHmuxInitialAgentPrompt(launched, prompt);
	}
	let conversationId = await ensureManagedConversationIdentity(launched);
	// Product code observes one Host-owned stream. This QA wait only gives the
	// provider time to publish its first identity into that stream.
	const deadline = Date.now() + 60_000;
	while (!conversationId && Date.now() < deadline) {
		await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
		conversationId = managedConversationId(currentAgent(agent.id));
	}
	if (!conversationId) {
		const current = currentAgent(agent.id);
		throw new Error(
			`timed out waiting for exact Codex conversation: ${name}; ` +
				JSON.stringify({
					conversationId: current.conversationId ?? null,
					conversationIdentity: current.conversationIdentity ?? null,
				}),
		);
	}
	const completedTurnCount = await waitForManagedTurnAfter(
		managedAgentSnapshot(currentAgent(agent.id)),
		"0",
	);
	return {
		receipt,
		agent: currentAgent(agent.id),
		surface,
		completedTurnCount,
	};
}

async function assertLiveConversation(
	snapshot: ReturnType<typeof managedAgentSnapshot>,
) {
	const evidence = await hmux.inspectManagedConversationIdentity({
		sessionId: snapshot.sessionId,
		workspaceId: snapshot.workspaceId,
		providerId: "codex",
		cwd: currentAgent(snapshot.agentId).worktreePath,
	});
	if (
		evidence.sessionId !== snapshot.sessionId ||
		evidence.workspaceId !== snapshot.workspaceId ||
		evidence.conversationId !== snapshot.conversationId
	) {
		throw new Error(`live Codex conversation mismatch: ${snapshot.agentId}`);
	}
}

interface ManagedCredentialQaResource {
	readonly agentId: string;
	surface?: ManagedCredentialQaSurface;
}

type QaStepResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: Error };

async function settleQaStep<T>(step: Promise<T>): Promise<QaStepResult<T>> {
	try {
		return { ok: true, value: await step };
	} catch (error) {
		return { ok: false, error: asError(error) };
	}
}

async function collectManagedCredentialCrossBindingEvidence(
	projectId: string,
	account: AccountProfile,
	log: (...args: unknown[]) => void,
	resources: ManagedCredentialQaResource[],
) {
	const markerRunId = globalThis.crypto
		.randomUUID()
		.replace(/-/g, "")
		.slice(0, 12)
		.toUpperCase();
	const target = await launchManagedConversation(
		projectId,
		`qa-crossbind-target-${Date.now()}`,
		null,
		"Reply exactly HMUX_CROSSBIND_TARGET_READY and do not run tools.",
		resources,
	);
	const sibling = await launchManagedConversation(
		projectId,
		`qa-crossbind-sibling-${Date.now()}`,
		account.id,
		"Reply exactly HMUX_CROSSBIND_SIBLING_READY and do not run tools.",
		resources,
	);
	const targetBefore = managedAgentSnapshot(target.agent);
	const siblingBefore = managedAgentSnapshot(sibling.agent);
	if (targetBefore.conversationId === siblingBefore.conversationId) {
		throw new Error("concurrent Codex panes resolved the same conversation");
	}
	for (const [kind, launch, expectedCredential] of [
		["default", target, null],
		["selected", sibling, account.id],
	] as const) {
		if (
			launch.receipt.session.sessionClass !== "managed" ||
			launch.receipt.session.lifecycle !== "ready" ||
			(launch.receipt.credentialId ?? null) !== expectedCredential
		) {
			throw new Error(`initial managed create receipt mismatch for ${kind}`);
		}
	}
	log("hmuxcredential-launches", {
		ok: true,
		launches: [
			{
				kind: "default",
				credentialId: target.receipt.credentialId ?? null,
				sessionId: target.receipt.session.sessionId,
				outcome: target.receipt.outcome,
			},
			{
				kind: "selected",
				credentialId: sibling.receipt.credentialId ?? null,
				sessionId: sibling.receipt.session.sessionId,
				outcome: sibling.receipt.outcome,
			},
		],
	});

	const siblingSessionBefore = (await hmux.listSessions()).find(
		(candidate) =>
			candidate.sessionId === siblingBefore.sessionId &&
			candidate.workspaceId === siblingBefore.workspaceId,
	);
	if (!siblingSessionBefore) {
		throw new Error("sibling Hmux Host disappeared before credential switch");
	}
	const liveTargetSurface = target.surface;
	const liveSiblingSurface = sibling.surface;
	await Promise.all([
		liveTargetSurface.waitUntilReady(),
		liveSiblingSurface.waitUntilReady(),
	]);
	await liveTargetSurface.focus();
	const targetBeforeMarker = managedCredentialQaMarker(markerRunId, "A", 1);
	const targetInputBefore =
		await liveTargetSurface.observeMarker(targetBeforeMarker);
	const targetSurfaceBefore = liveTargetSurface.snapshot();
	const targetGridBefore = structuredTerminalGrid(targetInputBefore);
	await liveSiblingSurface.focus();
	const beforeMarker = managedCredentialQaMarker(markerRunId, "B", 1);
	const siblingInputBefore =
		await liveSiblingSurface.observeMarker(beforeMarker);
	const siblingSurfaceBefore = liveSiblingSurface.snapshot();
	const siblingGridBefore = structuredTerminalGrid(siblingInputBefore);
	const siblingBaselineGrid =
		siblingSurfaceBefore.gridTransitions[
			siblingSurfaceBefore.gridTransitions.length - 1
		];
	if (
		siblingSurfaceBefore.synchronizations < 1 ||
		!siblingBaselineGrid ||
		!sameTerminalGrid(siblingBaselineGrid, siblingGridBefore) ||
		siblingInputBefore.markerCounts.painted !== 1 ||
		siblingInputBefore.markerCounts.projection !== 1 ||
		siblingSurfaceBefore.errors.length > 0
	) {
		throw new Error("sibling structured surface baseline is incomplete");
	}
	// Submit only the QA-owned draft. The preceding turn's idle event does not
	// authorize replacing a Host that still owns unsubmitted input.
	await sendHmuxAgentCommandInput(target.agent, "", true);
	await waitForManagedTurnAfter(targetBefore, target.completedTurnCount);
	const result = await requestAgentCredentialTransition({
		agentId: targetBefore.agentId,
		targetCredentialId: account.id,
		sourcePanelId: targetBefore.panelId,
	});
	if (result.kind !== "completed") {
		throw new Error(
			`credential switch did not complete after the submitted QA turn: ${JSON.stringify(result)}`,
		);
	}
	await liveTargetSurface.waitUntilReady(targetSurfaceBefore.synchronizations);

	const targetAfter = managedAgentSnapshot(currentAgent(targetBefore.agentId));
	const siblingAfter = managedAgentSnapshot(
		currentAgent(siblingBefore.agentId),
	);
	const targetPanel = getDockview(useStore.getState().activeSpaceId)?.getPanel(
		targetBefore.panelId,
	);
	if (
		targetAfter.agentId !== targetBefore.agentId ||
		targetAfter.panelId !== targetBefore.panelId ||
		targetAfter.sessionId === targetBefore.sessionId ||
		targetAfter.workspaceId !== targetBefore.workspaceId ||
		targetAfter.conversationId !== targetBefore.conversationId ||
		targetAfter.credentialId !== account.id ||
		!targetPanel
	) {
		throw new Error("target pane lost identity during credential switch");
	}
	if (JSON.stringify(siblingAfter) !== JSON.stringify(siblingBefore)) {
		throw new Error("credential switch mutated the sibling pane binding");
	}
	const siblingSessionAfter = (await hmux.listSessions()).find(
		(candidate) =>
			candidate.sessionId === siblingAfter.sessionId &&
			candidate.workspaceId === siblingAfter.workspaceId,
	);
	if (
		!siblingSessionAfter ||
		siblingSessionAfter.terminalEpoch !== siblingSessionBefore.terminalEpoch
	) {
		throw new Error("credential switch replaced the sibling Hmux generation");
	}
	await liveTargetSurface.focus();
	const targetAfterMarker = managedCredentialQaMarker(markerRunId, "A", 2);
	const targetInputAfter =
		await liveTargetSurface.observeMarker(targetAfterMarker);
	const targetSurfaceAfter = liveTargetSurface.snapshot();
	const targetGridAfter = structuredTerminalGrid(targetInputAfter);
	const targetGridTransitionsDuringSwitch =
		targetSurfaceAfter.gridTransitions.slice(
			targetSurfaceBefore.gridTransitions.length,
		);
	if (
		!managedCredentialTargetSurfaceStayedContinuous({
			before: targetSurfaceBefore,
			after: targetSurfaceAfter,
			inputBefore: targetInputBefore,
			inputAfter: targetInputAfter,
		})
	) {
		throw new Error(
			`target structured surface lost continuity during credential switch: ${JSON.stringify(
				{
					before: {
						lifecycle: targetSurfaceBefore,
						attachmentIdentity: targetInputBefore.receipt.attachmentIdentity,
						grid: targetGridBefore,
						markerCounts: targetInputBefore.markerCounts,
					},
					after: {
						lifecycle: targetSurfaceAfter,
						attachmentIdentity: targetInputAfter.receipt.attachmentIdentity,
						grid: targetGridAfter,
						markerCounts: targetInputAfter.markerCounts,
					},
				},
			)}`,
		);
	}
	await liveSiblingSurface.focus();
	const afterMarker = managedCredentialQaMarker(markerRunId, "B", 2);
	const siblingInputAfter = await liveSiblingSurface.observeMarker(afterMarker);
	const siblingSurfaceAfter = liveSiblingSurface.snapshot();
	const siblingGridAfter = structuredTerminalGrid(siblingInputAfter);
	const gridTransitionsDuringSwitch = siblingSurfaceAfter.gridTransitions.slice(
		siblingSurfaceBefore.gridTransitions.length,
	);
	if (
		!liveSiblingSurface.connected ||
		siblingInputAfter.receipt.attachmentIdentity !==
			siblingInputBefore.receipt.attachmentIdentity ||
		!sameTerminalGrid(siblingGridAfter, siblingGridBefore) ||
		gridTransitionsDuringSwitch.some(
			(transition) => !sameTerminalGrid(transition, siblingGridBefore),
		) ||
		siblingSurfaceAfter.hydrations !== siblingSurfaceBefore.hydrations ||
		siblingSurfaceAfter.synchronizations !==
			siblingSurfaceBefore.synchronizations ||
		siblingInputAfter.markerCounts.painted !== 1 ||
		siblingInputAfter.markerCounts.projection !== 1 ||
		siblingSurfaceAfter.errors.length > 0
	) {
		throw new Error(
			"credential switch disturbed the sibling structured surface",
		);
	}
	await assertLiveConversation(targetAfter);
	await assertLiveConversation(siblingAfter);
	return {
		target: {
			agentId: targetAfter.agentId,
			panelId: targetAfter.panelId,
			sourceSessionId: targetBefore.sessionId,
			targetSessionId: targetAfter.sessionId,
			conversationId: targetAfter.conversationId,
			credentialId: targetAfter.credentialId,
			surface: {
				before: {
					attachmentIdentity: targetInputBefore.receipt.attachmentIdentity,
					grid: targetGridBefore,
					lifecycle: targetSurfaceBefore,
					input: managedCredentialQaInputProof(
						targetBeforeMarker,
						targetInputBefore,
					),
				},
				after: {
					attachmentIdentity: targetInputAfter.receipt.attachmentIdentity,
					grid: targetGridAfter,
					lifecycle: targetSurfaceAfter,
					input: managedCredentialQaInputProof(
						targetAfterMarker,
						targetInputAfter,
					),
				},
				gridTransitionsDuringSwitch: targetGridTransitionsDuringSwitch,
			},
		},
		sibling: siblingAfter,
		siblingSurface: {
			before: {
				attachmentIdentity: siblingInputBefore.receipt.attachmentIdentity,
				grid: siblingGridBefore,
				lifecycle: siblingSurfaceBefore,
				input: managedCredentialQaInputProof(beforeMarker, siblingInputBefore),
			},
			after: {
				attachmentIdentity: siblingInputAfter.receipt.attachmentIdentity,
				grid: siblingGridAfter,
				lifecycle: siblingSurfaceAfter,
				input: managedCredentialQaInputProof(afterMarker, siblingInputAfter),
			},
			gridTransitionsDuringSwitch,
		},
	};
}

export async function runManagedCredentialCrossBindingQa(
	projectId: string,
	account: AccountProfile,
	log: (...args: unknown[]) => void,
): Promise<void> {
	await waitForManagedLaunchFixture();
	const resources: ManagedCredentialQaResource[] = [];
	const execution = await settleQaStep(
		collectManagedCredentialCrossBindingEvidence(
			projectId,
			account,
			log,
			resources,
		),
	);
	const cleanup = await settleQaStep(
		cleanupManagedCredentialQaResources(resources),
	);
	if (!execution.ok || !cleanup.ok) {
		const failures = [
			...(execution.ok ? [] : [execution.error]),
			...(cleanup.ok ? [] : [cleanup.error]),
		];
		const failure =
			failures.length === 1
				? failures[0]
				: combinedError(
						"managed credential QA failed and cleanup was incomplete",
						failures,
					);
		log("hmuxcredential-launches", { ok: false, error: String(failure) });
		log("hmuxcredential-crossbind", { ok: false, error: String(failure) });
		throw failure;
	}
	log("hmuxcredential-crossbind", {
		ok: true,
		...execution.value,
		cleanup: cleanup.value,
	});
}

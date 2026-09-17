import { PROVIDER_IDS } from "@/lib/agents/providers";
import { sameManagedDispatchIdentity } from "@/lib/interactions/managedDispatchProjection";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";
import {
	createDureWorkflowTransport,
	type DureWorkflowDispatchSessionTransport,
	type WorkflowDispatchSessionRebindReceiptV1,
	type WorkflowSessionGenerationV1,
} from "@/lib/ipc/dureWorkflow";
import type {
	ManagedAgentCredentialSwitchInspection,
	ManagedAgentRehostInspection,
} from "@/lib/sessions/managed/managedAgentRehostInspection";
import type { ManagedAgentRecoveryResult } from "@/lib/sessions/managed/managedAgentRuntime";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { Agent } from "@/types";

type Inspection =
	| ManagedAgentRehostInspection
	| ManagedAgentCredentialSwitchInspection;
type WorkflowDispatch = NonNullable<Agent["workflowDispatch"]>;

export interface ManagedAgentDispatchHandoffRuntime
	extends Pick<
		DureWorkflowDispatchSessionTransport,
		"inspectDispatchSession" | "rebindDispatchSession"
	> {
	now(): number;
}

const workflowTransport = createDureWorkflowTransport();

const defaultManagedAgentDispatchHandoffRuntime: ManagedAgentDispatchHandoffRuntime =
	{
		inspectDispatchSession: (routeAuthority, session) =>
			workflowTransport.inspectDispatchSession(routeAuthority, session),
		rebindDispatchSession: (routeAuthority, request) =>
			workflowTransport.rebindDispatchSession(routeAuthority, request),
		now: Date.now,
	};

function exactSourceSession(
	inspection: Inspection,
): WorkflowSessionGenerationV1 {
	const fence = inspection.sourceBinding.stopFence;
	if (!fence) {
		throw new PaneCommandError(
			"pane_changed",
			"orchestrated managed rehost requires an exact source generation",
		);
	}
	return {
		sessionId: inspection.sourceBinding.sessionId,
		workspaceId: inspection.sourceBinding.workspaceId,
		providerId: inspection.providerId,
		...fence,
	};
}

/** Fence the orchestration adapter before Hmux crosses its destructive source
 * boundary. The exact source inspection, not a replaceable client projection,
 * decides which active or drainable Dispatch lineage the rebind must carry. */
async function inspectManagedAgentDispatchHandoff(
	routeAuthority: DureBackendRouteAuthorityV1,
	inspection: Inspection,
	currentProjection: Agent["workflowDispatch"],
	expected: WorkflowDispatch,
	runtime: ManagedAgentDispatchHandoffRuntime = defaultManagedAgentDispatchHandoffRuntime,
): Promise<void> {
	if (!sameManagedDispatchIdentity(currentProjection, expected)) {
		throw new PaneCommandError(
			"pane_changed",
			"the Agent Dispatch projection changed before managed rehost",
		);
	}
	await runtime.inspectDispatchSession(
		routeAuthority,
		exactSourceSession(inspection),
	);
}

export function managedAgentDispatchHandoffJournal(
	recovery: ManagedAgentRecoveryResult,
): {
	operationId: string;
	source: WorkflowSessionGenerationV1;
	target: WorkflowSessionGenerationV1;
} {
	const receipt = recovery.receipt;
	const operationId = receipt.operationId?.trim();
	const source = receipt.sourceStopReceipt;
	const target = receipt.replacementTarget;
	const providerId = PROVIDER_IDS.find(
		(candidate) => candidate === target?.providerId,
	);
	if (!operationId || !source || !target || !providerId) {
		throw new PaneCommandError(
			"pane_changed",
			"managed rehost journal lost its exact Dispatch handoff identity",
		);
	}
	return {
		operationId,
		source: {
			sessionId: source.sessionId,
			workspaceId: source.workspaceId,
			providerId,
			runnerPrincipal: source.runnerPrincipal,
			runnerInstance: source.runnerInstance,
			channelEpoch: String(source.channelEpoch),
			hostInstanceId: source.hostInstanceId,
			terminalEpoch: source.terminalEpoch,
		},
		target: {
			sessionId: target.sessionId,
			workspaceId: target.workspaceId,
			providerId,
			runnerPrincipal: target.runnerPrincipal,
			runnerInstance: target.runnerInstance,
			channelEpoch: target.channelEpoch,
			hostInstanceId: target.hostInstanceId,
			terminalEpoch: target.terminalEpoch,
		},
	};
}

/** Commit the journal-selected Hmux successor into the same Dispatch authority.
 * The backend performs the source CAS and updates the worker endpoint atomically. */
async function rebindManagedAgentDispatchHandoff(
	routeAuthority: DureBackendRouteAuthorityV1,
	recovery: ManagedAgentRecoveryResult,
	runtime: ManagedAgentDispatchHandoffRuntime = defaultManagedAgentDispatchHandoffRuntime,
): Promise<WorkflowDispatchSessionRebindReceiptV1 | undefined> {
	const journal = managedAgentDispatchHandoffJournal(recovery);
	const receipt = await runtime.rebindDispatchSession(routeAuthority, {
		schemaVersion: 1,
		operationId: journal.operationId,
		source: journal.source,
		target: journal.target,
		reboundAtMs: runtime.now(),
	});
	if (receipt.outcome === "unassigned") return undefined;
	return receipt;
}

function workflowDispatchFromReceipt(
	receipt: WorkflowDispatchSessionRebindReceiptV1,
): WorkflowDispatch {
	if (
		typeof receipt.taskId !== "string" ||
		typeof receipt.dispatchId !== "string" ||
		typeof receipt.generation !== "number" ||
		!Number.isInteger(receipt.generation) ||
		receipt.generation < 1
	) {
		throw new PaneCommandError(
			"pane_changed",
			"the rehosted Session lost its authoritative Dispatch identity",
		);
	}
	return {
		schemaVersion: 1,
		taskId: receipt.taskId,
		dispatchId: receipt.dispatchId,
		generation: receipt.generation,
	};
}

export interface ManagedAgentDispatchProjectionHandoff {
	source?: WorkflowDispatch;
	target: WorkflowDispatch;
}

function validWorkflowDispatch(value: unknown): value is WorkflowDispatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const dispatch = value as Partial<WorkflowDispatch>;
	return (
		dispatch.schemaVersion === 1 &&
		typeof dispatch.taskId === "string" &&
		dispatch.taskId.length > 0 &&
		typeof dispatch.dispatchId === "string" &&
		dispatch.dispatchId.length > 0 &&
		Number.isInteger(dispatch.generation) &&
		(dispatch.generation ?? 0) > 0
	);
}

export function isManagedAgentDispatchProjectionHandoff(
	value: unknown,
): value is ManagedAgentDispatchProjectionHandoff {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const projection = value as Partial<ManagedAgentDispatchProjectionHandoff>;
	return (
		(projection.source === undefined ||
			validWorkflowDispatch(projection.source)) &&
		validWorkflowDispatch(projection.target)
	);
}

export function managedAgentDispatchProjectionPayload(
	projection: ManagedAgentDispatchProjectionHandoff | undefined,
): { dispatchProjection?: ManagedAgentDispatchProjectionHandoff } {
	return projection
		? {
				dispatchProjection: {
					...(projection.source ? { source: { ...projection.source } } : {}),
					target: { ...projection.target },
				},
			}
		: {};
}

export function managedAgentDispatchProjectionPatch(
	projection: ManagedAgentDispatchProjectionHandoff | undefined,
): Partial<Pick<Agent, "workflowDispatch">> {
	return projection ? { workflowDispatch: projection.target } : {};
}

export interface ManagedAgentDispatchHandoffExecution {
	recovery: ManagedAgentRecoveryResult;
	dispatch?: WorkflowDispatchSessionRebindReceiptV1;
	dispatchProjection?: ManagedAgentDispatchProjectionHandoff;
}

/** Capture the client projection once, then carry that fence through Hmux's
 * source inspection and durable completion receipt. */
export function createManagedAgentDispatchHandoff(
	source: Agent,
	runtime: ManagedAgentDispatchHandoffRuntime = defaultManagedAgentDispatchHandoffRuntime,
): {
	inspect(
		routeAuthority: DureBackendRouteAuthorityV1,
		inspection: Inspection,
		current: Agent,
	): Promise<void>;
	complete(
		recovery: ManagedAgentRecoveryResult,
	): Promise<ManagedAgentDispatchHandoffExecution>;
	reconcile(
		recovery: ManagedAgentRecoveryResult,
	): Promise<ManagedAgentDispatchHandoffExecution>;
} {
	const expected = source.workflowDispatch;
	const profileId =
		source.runtimeBinding?.runtime === "hmux_managed_v1"
			? (source.runtimeBinding.backendProfileId ?? "local")
			: "local";
	let inspectedRouteAuthority: DureBackendRouteAuthorityV1 | undefined;
	const assertExactRoute = (authority: DureBackendRouteAuthorityV1) => {
		if (
			authority.profileId !== profileId ||
			(inspectedRouteAuthority !== undefined &&
				!sameDureBackendRouteAuthority(inspectedRouteAuthority, authority))
		) {
			throw new PaneCommandError(
				"pane_changed",
				"managed rehost backend route changed across its stop boundary",
			);
		}
	};
	const projectDispatch = (
		recovery: ManagedAgentRecoveryResult,
		dispatch: WorkflowDispatchSessionRebindReceiptV1 | undefined,
	): ManagedAgentDispatchHandoffExecution => {
		const dispatchProjection = dispatch
			? {
					...(expected ? { source: { ...expected } } : {}),
					target: workflowDispatchFromReceipt(dispatch),
				}
			: undefined;
		return {
			recovery,
			...(dispatch ? { dispatch } : {}),
			...(dispatchProjection ? { dispatchProjection } : {}),
		};
	};
	// Rehost/resume IS the recovery path — orchestration bookkeeping must
	// never veto it (owner decision 2026-09-01: "validation 거의 없이 무조건",
	// risk re-added only if a real incident demands it). Every handoff step —
	// projection identity, route identity, stop fence, the store's own
	// inspect/rebind — is best-effort: a failure logs and downgrades to an
	// un-orchestrated resume instead of failing the pane. The cost accepted
	// with that decision: a live Dispatch lineage can keep pointing at the
	// dead session until the service reconciles it.
	const tolerated = (stage: string, error: unknown) => {
		console.warn(
			`[managedRehost] orchestration ${stage} failed — continuing un-orchestrated`,
			error,
		);
	};
	const reconcile = async (
		recovery: ManagedAgentRecoveryResult,
	): Promise<ManagedAgentDispatchHandoffExecution> => {
		if (!expected) return projectDispatch(recovery, undefined);
		const routeAuthority = recovery.backendRouteAuthority;
		if (!routeAuthority) return projectDispatch(recovery, undefined);
		try {
			assertExactRoute(routeAuthority);
			const dispatch = await rebindManagedAgentDispatchHandoff(
				routeAuthority,
				recovery,
				runtime,
			);
			return projectDispatch(recovery, dispatch);
		} catch (error) {
			tolerated("rebind", error);
			return projectDispatch(recovery, undefined);
		}
	};
	return {
		inspect: async (routeAuthority, inspection, current) => {
			if (!expected) return;
			try {
				assertExactRoute(routeAuthority);
				inspectedRouteAuthority = routeAuthority;
				await inspectManagedAgentDispatchHandoff(
					routeAuthority,
					inspection,
					current.workflowDispatch,
					expected,
					runtime,
				);
			} catch (error) {
				tolerated("inspect", error);
			}
		},
		complete: reconcile,
		reconcile,
	};
}

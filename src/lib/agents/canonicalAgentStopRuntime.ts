import {
	type AgentCanonicalSpawnV1,
	sameAgentCanonicalSpawn,
} from "@/lib/agents/agentCanonicalSpawn";
import {
	type CanonicalAgentStopReceiptV1,
	canonicalAgentStopAppliesToAgentV1,
	projectCanonicalAgentStopV1,
} from "@/lib/agents/canonicalAgentStopLifecycle";
import { removeAgentProjectionDurably } from "@/lib/agents/durableAgentRemoval";
import { t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import {
	createDureAgentStopClient,
	type DureAgentStopClient,
} from "@/lib/ipc/dureAgentStop";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteTarget,
} from "@/lib/ipc/dureBackendRoute";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export interface PreparedCanonicalAgentStopV1 {
	readonly agent: Agent;
	readonly provenance: AgentCanonicalSpawnV1;
	readonly client: DureAgentStopClient;
	readonly routeAuthority: DureBackendRouteAuthorityV1;
	readonly observed: CanonicalAgentStopReceiptV1 | null;
}

/** A missing preview is distinct from losing an already-admitted stop journal. */
export class CanonicalAgentStopPreviewNotFoundError extends Error {
	constructor(
		readonly routeAuthority: DureBackendRouteAuthorityV1,
		readonly cause: DureBackendRequestError,
	) {
		super(cause.message);
	}
}

export class CanonicalAgentStopRetainedError extends Error {
	readonly code: string;

	constructor(readonly receipt: CanonicalAgentStopReceiptV1) {
		super(t("agents.remove.cleanupUnsafe"));
		this.name = "CanonicalAgentStopRetainedError";
		this.code = `agent_dispatch_stop_${receipt.status}`;
	}
}

class CanonicalAgentStopTargetChangedError extends Error {
	readonly code = "agent_dispatch_stop_projection_changed";

	constructor() {
		super(t("agents.remove.worktreeUsersChanged"));
		this.name = "CanonicalAgentStopTargetChangedError";
	}
}

class CanonicalAgentStopRouteTargetChangedError extends Error {
	readonly code = "agent_dispatch_stop_route_target_changed";

	constructor() {
		super(t("agents.remove.cleanupUnsafe"));
		this.name = "CanonicalAgentStopRouteTargetChangedError";
	}
}

function assertCanonicalAgentStopTargetCurrentV1(
	target: Pick<PreparedCanonicalAgentStopV1, "agent" | "provenance">,
	receipt?: CanonicalAgentStopReceiptV1 | null,
): void {
	const current = useStore
		.getState()
		.agents.find((agent) => agent.id === target.agent.id);
	if (
		!current ||
		(receipt
			? !canonicalAgentStopAppliesToAgentV1(receipt, target.provenance, current)
			: !sameAgentCanonicalSpawn(current.canonicalSpawn, target.provenance))
	) {
		throw new CanonicalAgentStopTargetChangedError();
	}
}

export async function prepareCanonicalAgentStopV1(
	agent: Agent & { readonly canonicalSpawn: AgentCanonicalSpawnV1 },
	createClient: typeof createDureAgentStopClient = createDureAgentStopClient,
): Promise<PreparedCanonicalAgentStopV1> {
	const provenance = { ...agent.canonicalSpawn };
	const client = createClient({ profileId: provenance.backendProfileId });
	const observation = await client.status(provenance.operationId);
	const target = {
		agent,
		provenance,
		client,
		routeAuthority: observation.routeAuthority,
		observed: observation.receipt,
	};
	assertCanonicalAgentStopTargetCurrentV1(target, observation.receipt);
	return target;
}

async function applyCanonicalAgentStopReceiptV1(
	target: PreparedCanonicalAgentStopV1,
	receipt: CanonicalAgentStopReceiptV1,
): Promise<CanonicalAgentStopReceiptV1> {
	assertCanonicalAgentStopTargetCurrentV1(target, receipt);
	return target.client.apply(receipt, target.routeAuthority);
}

async function projectCanonicalAgentStopPreviewV1(
	target: PreparedCanonicalAgentStopV1,
): Promise<CanonicalAgentStopReceiptV1> {
	assertCanonicalAgentStopTargetCurrentV1(target);
	const receipt = await target.client
		.preview(target.provenance.operationId, target.routeAuthority)
		.catch((error: unknown) => {
			if (
				target.observed === null &&
				error instanceof DureBackendRequestError &&
				error.code === "agent_dispatch_stop_not_found"
			) {
				throw new CanonicalAgentStopPreviewNotFoundError(
					target.routeAuthority,
					error,
				);
			}
			throw error;
		});
	assertCanonicalAgentStopTargetCurrentV1(target, receipt);
	const projection = projectCanonicalAgentStopV1(receipt);
	if (projection.kind === "forget_presentation") return projection.receipt;
	if (
		projection.kind === "resume_apply" ||
		(projection.kind === "pending_confirmation" &&
			projection.receipt.workspaceDisposition === "preserve")
	) {
		return applyCanonicalAgentStopReceiptV1(target, projection.receipt);
	}
	if (projection.kind === "absent") {
		throw new Error("agent_dispatch_stop_preview_missing");
	}
	throw new CanonicalAgentStopRetainedError(projection.receipt);
}

async function applyOrPreviewCanonicalAgentStopV1(
	target: PreparedCanonicalAgentStopV1,
	mode: "explicit" | "resume",
): Promise<CanonicalAgentStopReceiptV1> {
	assertCanonicalAgentStopTargetCurrentV1(target, target.observed);
	const projection = projectCanonicalAgentStopV1(target.observed);
	if (projection.kind === "forget_presentation") return projection.receipt;
	if (projection.kind === "resume_apply") {
		return applyCanonicalAgentStopReceiptV1(target, projection.receipt);
	}
	if (
		projection.kind === "pending_confirmation" &&
		projection.receipt.workspaceDisposition === "preserve"
	) {
		return applyCanonicalAgentStopReceiptV1(target, projection.receipt);
	}
	if (mode === "resume" && projection.kind !== "absent") {
		throw new CanonicalAgentStopRetainedError(projection.receipt);
	}
	return projectCanonicalAgentStopPreviewV1(target);
}

/** Executes an explicit user-confirmed canonical stop and requires a final receipt. */
export async function executeCanonicalAgentStopV1(
	target: PreparedCanonicalAgentStopV1,
): Promise<CanonicalAgentStopReceiptV1> {
	const receipt = await applyOrPreviewCanonicalAgentStopV1(target, "explicit");
	if (projectCanonicalAgentStopV1(receipt).kind !== "forget_presentation") {
		throw new CanonicalAgentStopRetainedError(receipt);
	}
	return receipt;
}

/** Re-reads durable status before retrying one already-started prepared removal. */
export async function resumeCanonicalAgentStopV1(
	target: PreparedCanonicalAgentStopV1,
): Promise<CanonicalAgentStopReceiptV1> {
	const observation = await target.client.status(target.provenance.operationId);
	if (
		!sameDureBackendRouteTarget(
			target.routeAuthority.target,
			observation.routeAuthority.target,
		)
	) {
		throw new CanonicalAgentStopRouteTargetChangedError();
	}
	const resumed = {
		...target,
		routeAuthority: observation.routeAuthority,
		observed: observation.receipt,
	};
	assertCanonicalAgentStopTargetCurrentV1(resumed, observation.receipt);
	const receipt = await applyOrPreviewCanonicalAgentStopV1(resumed, "resume");
	if (projectCanonicalAgentStopV1(receipt).kind !== "forget_presentation") {
		throw new CanonicalAgentStopRetainedError(receipt);
	}
	return receipt;
}

/** Applies one terminal receipt through the durable projection-removal authority. */
export async function applyCanonicalAgentStopPresentationV1(
	provenance: AgentCanonicalSpawnV1,
	receipt: CanonicalAgentStopReceiptV1,
): Promise<boolean> {
	if (projectCanonicalAgentStopV1(receipt).kind !== "forget_presentation") {
		return false;
	}
	return removeAgentProjectionDurably({
		agents: [
			{
				agentId: receipt.agentId,
				panelIds: [`agent:${receipt.agentId}`],
				applies: (current) =>
					canonicalAgentStopAppliesToAgentV1(receipt, provenance, current),
			},
		],
	});
}

export interface CanonicalAgentStopReconciliationReceiptV1 {
	readonly agentId: string;
	readonly outcome: "unchanged" | "forgotten" | "failed";
	readonly status?: CanonicalAgentStopReceiptV1["status"];
	readonly error?: string;
}

/** One-shot reload reconciliation; planned effects wait for explicit confirmation. */
export async function reconcileCanonicalAgentStopsOnceV1(): Promise<
	readonly CanonicalAgentStopReconciliationReceiptV1[]
> {
	const canonical = useStore
		.getState()
		.agents.filter(
			(agent): agent is Agent & { canonicalSpawn: AgentCanonicalSpawnV1 } =>
				agent.canonicalSpawn !== undefined,
		);
	return Promise.all(
		canonical.map(async (agent) => {
			try {
				const target = await prepareCanonicalAgentStopV1(agent);
				let projection = projectCanonicalAgentStopV1(target.observed);
				if (projection.kind === "resume_apply") {
					const applied = await applyCanonicalAgentStopReceiptV1(
						target,
						projection.receipt,
					);
					projection = projectCanonicalAgentStopV1(applied);
				}
				if (projection.kind !== "forget_presentation") {
					return {
						agentId: agent.id,
						outcome: "unchanged" as const,
						...(projection.kind === "absent"
							? {}
							: { status: projection.receipt.status }),
					};
				}
				const forgotten = await applyCanonicalAgentStopPresentationV1(
					target.provenance,
					projection.receipt,
				);
				return {
					agentId: agent.id,
					outcome: forgotten ? ("forgotten" as const) : ("unchanged" as const),
					status: projection.receipt.status,
				};
			} catch (error) {
				if (error instanceof CanonicalAgentStopTargetChangedError) {
					return { agentId: agent.id, outcome: "unchanged" as const };
				}
				console.warn("[canonical Agent stop reconciliation]", error);
				return {
					agentId: agent.id,
					outcome: "failed" as const,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);
}

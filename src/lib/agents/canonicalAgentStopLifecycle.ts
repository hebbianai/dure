import {
	type AgentCanonicalSpawnV1,
	sameAgentCanonicalSpawn,
} from "@/lib/agents/agentCanonicalSpawn";
import { isDureDomainIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import {
	hasOnlyKeys,
	positiveInteger,
	asRecord as record,
} from "@/lib/payloadGuards";
import type { Agent } from "@/types";

const PLAN_TOKEN = /^sha256:[a-f0-9]{64}$/;

type CanonicalAgentStopStatusV1 =
	| "planned"
	| "superseded"
	| "authorized"
	| "succeeded"
	| "workspace_preserved"
	| "source_retained"
	| "workspace_replaced";

export interface CanonicalAgentStopReceiptV1 {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly spawnOperationId: string;
	readonly agentId: string;
	readonly planToken: string;
	readonly journalRevision: number;
	readonly workspaceDisposition: "preserve" | "remove_owned";
	readonly status: CanonicalAgentStopStatusV1;
}

export type CanonicalAgentStopProjectionV1 =
	| { readonly kind: "absent" }
	| {
			readonly kind: "pending_confirmation";
			readonly receipt: CanonicalAgentStopReceiptV1;
	  }
	| {
			readonly kind: "resume_apply";
			readonly receipt: CanonicalAgentStopReceiptV1;
	  }
	| {
			readonly kind: "forget_presentation";
			readonly receipt: CanonicalAgentStopReceiptV1;
	  }
	| {
			readonly kind: "source_retained";
			readonly receipt: CanonicalAgentStopReceiptV1;
	  };

function stateStatus(value: unknown): CanonicalAgentStopStatusV1 | undefined {
	const state = record(value);
	if (!state) return undefined;
	const status = state?.status;
	if (status === "planned" || status === "superseded") {
		return hasOnlyKeys(state, ["status"]) ? status : undefined;
	}
	if (status === "authorized") {
		return hasOnlyKeys(state, ["status", "runtimeCloseOperationId"]) &&
			isDureDomainIdV1(state.runtimeCloseOperationId)
			? status
			: undefined;
	}
	if (
		status === "workspace_preserved" ||
		status === "source_retained" ||
		status === "workspace_replaced"
	) {
		return hasOnlyKeys(state, ["status", "runtime"]) && record(state.runtime)
			? status
			: undefined;
	}
	return status === "succeeded" &&
		hasOnlyKeys(state, ["status", "runtime", "workspace"]) &&
		record(state.runtime) &&
		record(state.workspace)
		? status
		: undefined;
}

function workspaceDisposition(
	plan: Record<string, unknown>,
): "preserve" | "remove_owned" | undefined {
	if (
		plan.workspaceDisposition === "preserve" &&
		plan.ownedCheckout === undefined
	) {
		return "preserve";
	}
	return plan.workspaceDisposition === undefined && record(plan.ownedCheckout)
		? "remove_owned"
		: undefined;
}

function dispositionAllowsStatus(
	disposition: "preserve" | "remove_owned",
	status: CanonicalAgentStopStatusV1,
): boolean {
	if (
		status === "planned" ||
		status === "superseded" ||
		status === "authorized" ||
		status === "source_retained"
	) {
		return true;
	}
	return disposition === "preserve"
		? status === "workspace_preserved"
		: status === "succeeded" || status === "workspace_replaced";
}

/** Normalizes the durable stop wire receipt once at the backend boundary. */
export function parseCanonicalAgentStopResultV1(
	value: unknown,
	expectedSpawnOperationId: string,
): CanonicalAgentStopReceiptV1 | null | undefined {
	const result = record(value);
	if (
		!result ||
		!hasOnlyKeys(result, ["schemaVersion", "receipt"]) ||
		result.schemaVersion !== 1
	) {
		return undefined;
	}
	if (result.receipt === null) return null;
	const receipt = record(result.receipt);
	const plan = record(receipt?.plan);
	const spawn = record(plan?.spawn);
	const status = stateStatus(receipt?.state);
	const disposition = plan ? workspaceDisposition(plan) : undefined;
	if (
		!receipt ||
		!plan ||
		!spawn ||
		!status ||
		!disposition ||
		!hasOnlyKeys(receipt, [
			"plan",
			"state",
			"journalRevision",
			"createdAtMs",
			"updatedAtMs",
		]) ||
		plan.schemaVersion !== 1 ||
		spawn.operationId !== expectedSpawnOperationId ||
		!isDureDomainIdV1(expectedSpawnOperationId) ||
		!isDureDomainIdV1(plan.operationId) ||
		!isDureDomainIdV1(plan.agentId) ||
		typeof plan.planToken !== "string" ||
		!PLAN_TOKEN.test(plan.planToken) ||
		!positiveInteger(receipt.journalRevision) ||
		!Number.isSafeInteger(receipt.createdAtMs) ||
		!Number.isSafeInteger(receipt.updatedAtMs) ||
		!dispositionAllowsStatus(disposition, status)
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		operationId: plan.operationId,
		spawnOperationId: expectedSpawnOperationId,
		agentId: plan.agentId,
		planToken: plan.planToken,
		journalRevision: receipt.journalRevision,
		workspaceDisposition: disposition,
		status,
	};
}

/** Reduces one backend-owned receipt to the only presentation action it permits. */
export function projectCanonicalAgentStopV1(
	receipt: CanonicalAgentStopReceiptV1 | null,
): CanonicalAgentStopProjectionV1 {
	if (!receipt) return { kind: "absent" };
	switch (receipt.status) {
		case "planned":
			return { kind: "pending_confirmation", receipt };
		case "authorized":
			return { kind: "resume_apply", receipt };
		case "workspace_preserved":
		case "succeeded":
		case "workspace_replaced":
			return { kind: "forget_presentation", receipt };
		case "superseded":
		case "source_retained":
			return { kind: "source_retained", receipt };
	}
}

/** CAS predicate for presentation cleanup after a durable stop receipt. */
export function canonicalAgentStopAppliesToAgentV1(
	receipt: CanonicalAgentStopReceiptV1,
	provenance: AgentCanonicalSpawnV1,
	agent: Agent,
): boolean {
	return (
		receipt.agentId === agent.id &&
		receipt.spawnOperationId === provenance.operationId &&
		sameAgentCanonicalSpawn(agent.canonicalSpawn, provenance)
	);
}

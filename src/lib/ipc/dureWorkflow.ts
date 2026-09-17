import {
	type ExactHmuxManagedSessionV1,
	type HmuxManagedGenerationV1,
	parseHmuxManagedGenerationV1,
	sameExactHmuxManagedSession,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import { t } from "@/lib/i18n";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
	DureBackendRequestError,
	type DureRequestFailureV1,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	hasOnlyKeys as noUnknownKeys,
	positiveInteger,
	asRecord as record,
	nonNegativeInteger as timestamp,
} from "@/lib/payloadGuards";
import { PROVIDERS, type Provider } from "@/types";
import {
	createOrchestrationRequest,
	isOrchestrationResponse,
} from "../../../cli/lib/contracts/orchestration-envelope.mjs";

const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const WORKFLOW_ID = /^(run|task|dispatch)\.([0-9a-f]{64})$/;

interface WorkflowCoordinatorIdentityV1 {
	agentId: string;
	sessionId: string;
	bindingGeneration: number;
}

interface EnsureWorkflowCoordinatorRequestV1 {
	schemaVersion: 1;
	agentId: string;
	sessionId: string;
	workspaceId: string;
	displayName: string;
	worktreePath: string;
	stopFence: HmuxManagedGenerationV1;
}

export interface DelegateOnceRequestV1 {
	schemaVersion: 1;
	contributionId: string;
	coordinator: WorkflowCoordinatorIdentityV1;
	task: { summary: string; instructions: string };
	providerId: Provider;
	runtimeKindId: "runtime.hmux";
	targetReference: "backend-profile:local";
	idempotencyKey: string;
	createdAtMs: number;
}

export type WorkflowSessionGenerationV1 = ExactHmuxManagedSessionV1<Provider>;

interface WorkflowDispatchTargetV1 {
	authority: { workspaceId: string; tenantRef?: string };
	runId: string;
	taskId: string;
	dispatchId: string;
	generation: number;
}

interface WorkflowDispatchSessionInspectionReceiptV1 {
	schemaVersion: 1;
	outcome: "active_dispatch" | "unassigned";
	session: WorkflowSessionGenerationV1;
	target?: WorkflowDispatchTargetV1;
}

interface WorkflowDispatchSessionRebindRequestV1 {
	schemaVersion: 1;
	operationId: string;
	source: WorkflowSessionGenerationV1;
	target: WorkflowSessionGenerationV1;
	reboundAtMs: number;
}

export interface WorkflowDispatchSessionRebindReceiptV1 {
	schemaVersion: 1;
	operationId: string;
	outcome: "rebound" | "unassigned";
	source: WorkflowSessionGenerationV1;
	target: WorkflowSessionGenerationV1;
	runId?: string;
	taskId?: string;
	dispatchId?: string;
	generation?: number;
}

interface WorkflowDispatchSessionReconcileRequestV1 {
	schemaVersion: 1;
	expected: {
		taskId: string;
		dispatchId: string;
		generation: number;
	};
	target: WorkflowSessionGenerationV1;
	reconciledAtMs: number;
}

interface WorkflowDispatchSessionReconcileReceiptV1 {
	schemaVersion: 1;
	outcome: "current" | "rebound";
	operationId?: string;
	source: WorkflowSessionGenerationV1;
	target: WorkflowSessionGenerationV1;
	taskId: string;
	dispatchId: string;
	generation: number;
}

export interface DelegateOnceReceiptV1 {
	schemaVersion: 1;
	idempotencyKey: string;
	runId: string;
	taskId: string;
	dispatchId: string;
	generation: number;
	status: "starting" | "active" | "start_failed" | "completed";
	launchIdempotencyKey: string;
	effectiveLaunchIdempotencyKey?: string;
	session?: WorkflowSessionGenerationV1;
	startErrorCode?: string;
	promptDelivery?: {
		idempotencyKey: string;
		state: "pending" | "uncertain" | "written_to_pty" | "failed";
		errorCode?: string;
	};
	result?: string;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface DureWorkflowTransport {
	ensureCoordinatorBinding(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: EnsureWorkflowCoordinatorRequestV1,
	): Promise<WorkflowCoordinatorIdentityV1>;
	delegateOnce(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: DelegateOnceRequestV1,
	): Promise<DelegateOnceReceiptV1>;
}

export interface DureWorkflowDispatchSessionTransport {
	inspectDispatchSession(
		routeAuthority: DureBackendRouteAuthorityV1,
		session: WorkflowSessionGenerationV1,
	): Promise<WorkflowDispatchSessionInspectionReceiptV1>;
	rebindDispatchSession(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: WorkflowDispatchSessionRebindRequestV1,
	): Promise<WorkflowDispatchSessionRebindReceiptV1>;
	reconcileDispatchSession(
		routeAuthority: DureBackendRouteAuthorityV1,
		request: WorkflowDispatchSessionReconcileRequestV1,
	): Promise<WorkflowDispatchSessionReconcileReceiptV1>;
}

export class DureWorkflowError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly failure: DureRequestFailureV1,
	) {
		super(message);
		this.name = "DureWorkflowError";
	}
}

function token(value: unknown): value is string {
	return typeof value === "string" && TOKEN.test(value);
}

function domainId(value: unknown): value is string {
	return typeof value === "string" && DOMAIN_ID.test(value);
}

function provider(value: unknown): value is Provider {
	return typeof value === "string" && Object.keys(PROVIDERS).includes(value);
}

function coordinatorIdentity(
	value: unknown,
): WorkflowCoordinatorIdentityV1 | undefined {
	const candidate = record(value);
	return candidate &&
		noUnknownKeys(candidate, ["agentId", "sessionId", "bindingGeneration"]) &&
		domainId(candidate.agentId) &&
		token(candidate.sessionId) &&
		positiveInteger(candidate.bindingGeneration)
		? {
				agentId: candidate.agentId,
				sessionId: candidate.sessionId,
				bindingGeneration: candidate.bindingGeneration,
			}
		: undefined;
}

function session(value: unknown): WorkflowSessionGenerationV1 | undefined {
	const candidate = record(value);
	const generation = candidate
		? parseHmuxManagedGenerationV1({
				runnerPrincipal: candidate.runnerPrincipal,
				runnerInstance: candidate.runnerInstance,
				channelEpoch: candidate.channelEpoch,
				hostInstanceId: candidate.hostInstanceId,
				terminalEpoch: candidate.terminalEpoch,
			})
		: undefined;
	return candidate &&
		noUnknownKeys(candidate, [
			"sessionId",
			"workspaceId",
			"providerId",
			"runnerPrincipal",
			"runnerInstance",
			"channelEpoch",
			"hostInstanceId",
			"terminalEpoch",
		]) &&
		generation &&
		token(candidate.sessionId) &&
		token(candidate.workspaceId) &&
		provider(candidate.providerId)
		? {
				sessionId: candidate.sessionId,
				workspaceId: candidate.workspaceId,
				providerId: candidate.providerId,
				...generation,
			}
		: undefined;
}

function dispatchTarget(value: unknown): WorkflowDispatchTargetV1 | undefined {
	const candidate = record(value);
	const authority = record(candidate?.authority);
	if (
		!candidate ||
		!authority ||
		!token(authority.workspaceId) ||
		(authority.tenantRef !== undefined && !token(authority.tenantRef)) ||
		!domainId(candidate.runId) ||
		!domainId(candidate.taskId) ||
		!domainId(candidate.dispatchId) ||
		!positiveInteger(candidate.generation)
	) {
		return undefined;
	}
	return {
		authority: {
			workspaceId: authority.workspaceId,
			...(typeof authority.tenantRef === "string"
				? { tenantRef: authority.tenantRef }
				: {}),
		},
		runId: candidate.runId,
		taskId: candidate.taskId,
		dispatchId: candidate.dispatchId,
		generation: candidate.generation,
	};
}

function dispatchSessionInspection(
	value: unknown,
	expected: WorkflowSessionGenerationV1,
): WorkflowDispatchSessionInspectionReceiptV1 | undefined {
	const candidate = record(value);
	const parsedSession = session(candidate?.session);
	const parsedTarget =
		candidate?.target === undefined
			? undefined
			: dispatchTarget(candidate.target);
	if (
		candidate?.schemaVersion !== 1 ||
		!parsedSession ||
		!sameExactHmuxManagedSession(parsedSession, expected) ||
		!["active_dispatch", "unassigned"].includes(String(candidate.outcome)) ||
		(candidate.outcome === "active_dispatch" && !parsedTarget)
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		outcome:
			candidate.outcome as WorkflowDispatchSessionInspectionReceiptV1["outcome"],
		session: parsedSession,
		...(parsedTarget ? { target: parsedTarget } : {}),
	};
}

function dispatchSessionRebind(
	value: unknown,
	expected: WorkflowDispatchSessionRebindRequestV1,
): WorkflowDispatchSessionRebindReceiptV1 | undefined {
	const candidate = record(value);
	const source = session(candidate?.source);
	const targetSession = session(candidate?.target);
	const hasDispatch = candidate?.outcome === "rebound";
	const hasValidDispatch =
		domainId(candidate?.runId) &&
		domainId(candidate?.taskId) &&
		domainId(candidate?.dispatchId) &&
		positiveInteger(candidate?.generation);
	if (
		candidate?.schemaVersion !== 1 ||
		candidate.operationId !== expected.operationId ||
		!source ||
		!targetSession ||
		!sameExactHmuxManagedSession(source, expected.source) ||
		!sameExactHmuxManagedSession(targetSession, expected.target) ||
		!["rebound", "unassigned"].includes(String(candidate.outcome)) ||
		(hasDispatch && !hasValidDispatch)
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		operationId: expected.operationId,
		outcome:
			candidate.outcome as WorkflowDispatchSessionRebindReceiptV1["outcome"],
		source,
		target: targetSession,
		...(hasDispatch
			? {
					runId: candidate.runId as string,
					taskId: candidate.taskId as string,
					dispatchId: candidate.dispatchId as string,
					generation: candidate.generation as number,
				}
			: {}),
	};
}

function dispatchSessionReconcile(
	value: unknown,
	expected: WorkflowDispatchSessionReconcileRequestV1,
): WorkflowDispatchSessionReconcileReceiptV1 | undefined {
	const candidate = record(value);
	const source = session(candidate?.source);
	const targetSession = session(candidate?.target);
	const outcome = candidate?.outcome;
	if (
		candidate?.schemaVersion !== 1 ||
		(outcome !== "current" && outcome !== "rebound") ||
		!source ||
		!targetSession ||
		!sameExactHmuxManagedSession(targetSession, expected.target) ||
		candidate.taskId !== expected.expected.taskId ||
		candidate.dispatchId !== expected.expected.dispatchId ||
		candidate.generation !== expected.expected.generation ||
		(outcome === "current" &&
			!sameExactHmuxManagedSession(source, targetSession)) ||
		(outcome === "rebound" && !token(candidate.operationId))
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		outcome,
		...(typeof candidate.operationId === "string"
			? { operationId: candidate.operationId }
			: {}),
		source,
		target: targetSession,
		taskId: candidate.taskId as string,
		dispatchId: candidate.dispatchId as string,
		generation: candidate.generation as number,
	};
}

function promptDelivery(
	value: unknown,
): DelegateOnceReceiptV1["promptDelivery"] | undefined {
	const candidate = record(value);
	if (
		!candidate ||
		!noUnknownKeys(candidate, [
			"idempotencyKey",
			"state",
			"evidence",
			"errorCode",
		]) ||
		!token(candidate.idempotencyKey) ||
		!["pending", "uncertain", "written_to_pty", "failed"].includes(
			String(candidate.state),
		)
	) {
		return undefined;
	}
	if (candidate.errorCode !== undefined && !token(candidate.errorCode)) {
		return undefined;
	}
	if (candidate.state === "failed" && candidate.errorCode === undefined) {
		return undefined;
	}
	if (candidate.state !== "failed" && candidate.errorCode !== undefined) {
		return undefined;
	}
	if (
		(candidate.state === "written_to_pty" && !record(candidate.evidence)) ||
		(candidate.state !== "written_to_pty" && candidate.evidence !== undefined)
	) {
		return undefined;
	}
	return {
		idempotencyKey: candidate.idempotencyKey,
		state: candidate.state as NonNullable<
			DelegateOnceReceiptV1["promptDelivery"]
		>["state"],
		...(typeof candidate.errorCode === "string"
			? { errorCode: candidate.errorCode }
			: {}),
	};
}

function delegateReceipt(value: unknown): DelegateOnceReceiptV1 | undefined {
	const candidate = record(value);
	if (
		candidate?.schemaVersion !== 1 ||
		!noUnknownKeys(candidate, [
			"schemaVersion",
			"idempotencyKey",
			"runId",
			"taskId",
			"dispatchId",
			"generation",
			"status",
			"launchIdempotencyKey",
			"effectiveLaunchIdempotencyKey",
			"session",
			"startErrorCode",
			"promptDelivery",
			"result",
			"createdAtMs",
			"updatedAtMs",
		]) ||
		!token(candidate.idempotencyKey) ||
		!domainId(candidate.runId) ||
		!domainId(candidate.taskId) ||
		!domainId(candidate.dispatchId) ||
		!positiveInteger(candidate.generation) ||
		!["starting", "active", "start_failed", "completed"].includes(
			String(candidate.status),
		) ||
		!token(candidate.launchIdempotencyKey) ||
		(candidate.effectiveLaunchIdempotencyKey !== undefined &&
			!token(candidate.effectiveLaunchIdempotencyKey)) ||
		!timestamp(candidate.createdAtMs) ||
		!timestamp(candidate.updatedAtMs) ||
		candidate.updatedAtMs < candidate.createdAtMs ||
		(candidate.result !== undefined &&
			(typeof candidate.result !== "string" ||
				new TextEncoder().encode(candidate.result).length > 16 * 1024))
	) {
		return undefined;
	}
	const identities = [
		candidate.runId,
		candidate.taskId,
		candidate.dispatchId,
	].map((identity) => WORKFLOW_ID.exec(identity));
	if (
		identities.some((identity) => !identity) ||
		identities[0]?.[1] !== "run" ||
		identities[1]?.[1] !== "task" ||
		identities[2]?.[1] !== "dispatch" ||
		new Set(identities.map((identity) => identity?.[2])).size !== 1
	) {
		return undefined;
	}
	const parsedSession =
		candidate.session === undefined ? undefined : session(candidate.session);
	const parsedPrompt =
		candidate.promptDelivery === undefined
			? undefined
			: promptDelivery(candidate.promptDelivery);
	const preparedSessionId = `workflow-${identities[2]?.[2]?.slice(0, 32)}`;
	const explicitEffectiveLaunchIdempotencyKey =
		candidate.effectiveLaunchIdempotencyKey;
	const effectiveLaunchIdempotencyKey =
		candidate.status === "active" || candidate.status === "completed"
			? (explicitEffectiveLaunchIdempotencyKey ??
				(parsedSession?.sessionId === preparedSessionId
					? candidate.launchIdempotencyKey
					: undefined))
			: undefined;
	if (
		(candidate.session !== undefined && !parsedSession) ||
		(candidate.promptDelivery !== undefined && !parsedPrompt) ||
		(explicitEffectiveLaunchIdempotencyKey !== undefined &&
			parsedSession !== undefined &&
			(parsedSession.sessionId === preparedSessionId) !==
				(explicitEffectiveLaunchIdempotencyKey ===
					candidate.launchIdempotencyKey)) ||
		(candidate.startErrorCode !== undefined &&
			!token(candidate.startErrorCode)) ||
		(candidate.status === "starting" &&
			(parsedSession ||
				parsedPrompt ||
				candidate.effectiveLaunchIdempotencyKey !== undefined ||
				candidate.startErrorCode !== undefined)) ||
		((candidate.status === "active" || candidate.status === "completed") &&
			(!parsedSession ||
				!parsedPrompt ||
				effectiveLaunchIdempotencyKey === undefined ||
				candidate.startErrorCode !== undefined)) ||
		(candidate.status === "start_failed" &&
			(parsedSession ||
				parsedPrompt ||
				candidate.effectiveLaunchIdempotencyKey !== undefined ||
				candidate.startErrorCode === undefined)) ||
		(candidate.result !== undefined && candidate.status !== "completed")
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		idempotencyKey: candidate.idempotencyKey,
		runId: candidate.runId,
		taskId: candidate.taskId,
		dispatchId: candidate.dispatchId,
		generation: candidate.generation,
		status: candidate.status as DelegateOnceReceiptV1["status"],
		launchIdempotencyKey: candidate.launchIdempotencyKey,
		...(effectiveLaunchIdempotencyKey ? { effectiveLaunchIdempotencyKey } : {}),
		...(parsedSession ? { session: parsedSession } : {}),
		...(typeof candidate.startErrorCode === "string"
			? { startErrorCode: candidate.startErrorCode }
			: {}),
		...(parsedPrompt ? { promptDelivery: parsedPrompt } : {}),
		...(typeof candidate.result === "string"
			? { result: candidate.result }
			: {}),
		createdAtMs: candidate.createdAtMs,
		updatedAtMs: candidate.updatedAtMs,
	};
}

function backendError(error: unknown): DureWorkflowError {
	if (error instanceof DureBackendRequestError) {
		return new DureWorkflowError(error.code, error.message, error.failure);
	}
	return new DureWorkflowError(
		"workflow_transport_failed",
		error instanceof Error && error.message
			? error.message
			: t("ipc.dureDelegation.requestFailed"),
		{ kind: "transport" },
	);
}

export function createDureWorkflowTransport(options?: {
	profileId?: string;
	invokeCommand?: DureBackendInvoke;
}): DureWorkflowTransport & DureWorkflowDispatchSessionTransport {
	const backendRequest = createDureBackendRequester({
		profileId: options?.profileId ?? "local",
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "workflow_response_invalid",
		invalidResponseMessage: t("ipc.dureDelegation.invalidResponse"),
		backendChangedCode: "workflow_backend_changed",
		backendChangedMessage: t("ipc.dureBackend.generationChanged"),
		requestFailedCode: "workflow_transport_failed",
		requestFailedMessage: t("ipc.dureDelegation.requestFailed"),
	});

	const request = async (
		operation: string,
		body: Record<string, unknown>,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<Record<string, unknown>> => {
		try {
			return (
				await backendRequest(operation, body, {
					kind: "exact",
					authority: routeAuthority,
				})
			).result;
		} catch (error) {
			throw backendError(error);
		}
	};
	const orchestrationRequest = async (
		method: string,
		body: Record<string, unknown>,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<unknown> => {
		const result = await request(
			"orchestration.invoke",
			createOrchestrationRequest({ method, body }),
			routeAuthority,
		);
		if (!isOrchestrationResponse(result, method)) {
			throw new DureWorkflowError(
				"workflow_response_invalid",
				t("ipc.dureOrchestration.responseMismatch"),
				{ kind: "contract" },
			);
		}
		return result.receipt;
	};

	return {
		async ensureCoordinatorBinding(routeAuthority, body) {
			const result = await request(
				"agent_checkpoint.binding.ensure",
				body as unknown as Record<string, unknown>,
				routeAuthority,
			);
			const identity = coordinatorIdentity(result.identity);
			if (
				!identity ||
				identity.agentId !== body.agentId ||
				identity.sessionId !== body.sessionId
			) {
				throw new DureWorkflowError(
					"workflow_binding_response_invalid",
					t("ipc.dureCoordinator.bindingMismatch"),
					{ kind: "contract" },
				);
			}
			return identity;
		},
		async delegateOnce(routeAuthority, body) {
			const result = await request(
				"workflow.delegate_once",
				body as unknown as Record<string, unknown>,
				routeAuthority,
			);
			const receipt = delegateReceipt(result.receipt);
			if (
				!receipt ||
				receipt.idempotencyKey !== body.idempotencyKey ||
				(receipt.session &&
					(receipt.session.providerId !== body.providerId ||
						receipt.session.workspaceId === ""))
			) {
				throw new DureWorkflowError(
					"workflow_receipt_invalid",
					t("ipc.dureDelegation.receiptMismatch"),
					{ kind: "contract" },
				);
			}
			return receipt;
		},
		async inspectDispatchSession(routeAuthority, exactSession) {
			const receipt = dispatchSessionInspection(
				await orchestrationRequest(
					"dispatch.session.inspect",
					{
						schemaVersion: 1,
						session: exactSession,
					},
					routeAuthority,
				),
				exactSession,
			);
			if (!receipt) {
				throw new DureWorkflowError(
					"workflow_receipt_invalid",
					t("ipc.dureDispatch.inspectionReceiptMismatch"),
					{ kind: "contract" },
				);
			}
			return receipt;
		},
		async rebindDispatchSession(routeAuthority, body) {
			const receipt = dispatchSessionRebind(
				await orchestrationRequest(
					"dispatch.session.rebind",
					body as unknown as Record<string, unknown>,
					routeAuthority,
				),
				body,
			);
			if (!receipt) {
				throw new DureWorkflowError(
					"workflow_receipt_invalid",
					t("ipc.dureDispatch.rebindReceiptMismatch"),
					{ kind: "contract" },
				);
			}
			return receipt;
		},
		async reconcileDispatchSession(routeAuthority, body) {
			const receipt = dispatchSessionReconcile(
				await orchestrationRequest(
					"dispatch.session.reconcile-rehost",
					body as unknown as Record<string, unknown>,
					routeAuthority,
				),
				body,
			);
			if (!receipt) {
				throw new DureWorkflowError(
					"workflow_receipt_invalid",
					"The Dispatch reconcile receipt does not match the exact rehost generation.",
					{ kind: "contract" },
				);
			}
			return receipt;
		},
	};
}

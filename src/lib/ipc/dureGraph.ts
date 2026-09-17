import {
	graphContractError,
	parseActionContract,
	parseActionTask,
	parseActionTaskSummary,
	parseDefinition,
	parseGraphIssue,
	parseVersion,
	parseWorkflow,
	parseWorkflowRun,
	parseWorkflowRunSummary,
	parseWorkflowSummary,
	type WorkflowDraft,
	type WorkflowSummary,
} from "@/lib/automations/graphContract";
import { asRecord } from "@/lib/payloadGuards";
import {
	createOrchestrationRequest,
	isOrchestrationResponse,
} from "../../../cli/lib/contracts/orchestration-envelope.mjs";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
	type DureBackendRequestRouteV1,
} from "./dureBackend";
import type { DureBackendRouteAuthorityV1 } from "./dureBackendRoute";

export interface GraphPutIntent extends WorkflowDraft {
	schemaVersion: 1;
	workflowId: string;
	expectedRevision: number;
	idempotencyKey: string;
}
export interface GraphChangeIntent {
	schemaVersion: 1;
	workflowId: string;
	expectedRevision: number;
	idempotencyKey: string;
}

export function createGraphClient(
	options: { profileId?: string; invokeCommand?: DureBackendInvoke } = {},
) {
	const request = createDureBackendRequester({
		...options,
		invalidResponseCode: "workflow_response_invalid",
		invalidResponseMessage: "automations.invalidResponse",
		backendChangedCode: "workflow_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "workflow_request_failed",
		requestFailedMessage: "automations.requestFailed",
	});
	const exact = (
		authority: DureBackendRouteAuthorityV1,
	): DureBackendRequestRouteV1 => ({ kind: "exact", authority });
	async function call(
		operation: string,
		body: object,
		route: DureBackendRequestRouteV1,
	) {
		const method = `workflow.graph.${operation}`;
		const { result, routeAuthority } = await request(
			"orchestration.invoke",
			createOrchestrationRequest({ method, body }),
			route,
		);
		const receipt = asRecord(result.receipt);
		if (
			!isOrchestrationResponse(result, method) ||
			receipt?.schemaVersion !== 1
		)
			graphContractError();
		return { receipt, authority: routeAuthority };
	}
	async function change(
		operation: "activate" | "pause",
		intent: GraphChangeIntent,
		authority: DureBackendRouteAuthorityV1,
	) {
		const { receipt } = await call(operation, intent, exact(authority));
		const workflow = parseWorkflow(receipt.workflow);
		if (
			workflow.workflowId !== intent.workflowId ||
			workflow.revision !== intent.expectedRevision + 1
		)
			graphContractError();
		return workflow;
	}
	return {
		async list(authority?: DureBackendRouteAuthorityV1) {
			const result = await call(
				"list",
				{ schemaVersion: 1 },
				authority ? exact(authority) : { kind: "complete_selected_snapshot" },
			);
			if (
				!Array.isArray(result.receipt.workflows) ||
				result.receipt.workflows.length > 128
			)
				graphContractError();
			const workflows = result.receipt.workflows.map(parseWorkflowSummary);
			if (
				new Set(workflows.map((workflow) => workflow.workflowId)).size !==
				workflows.length
			)
				graphContractError();
			return { authority: result.authority, workflows };
		},
		async catalog(authority: DureBackendRouteAuthorityV1) {
			const { receipt } = await call(
				"catalog",
				{ schemaVersion: 1 },
				exact(authority),
			);
			if (!Array.isArray(receipt.actions) || receipt.actions.length > 64)
				graphContractError();
			return receipt.actions.map(parseActionContract);
		},
		async show(workflowId: string, authority: DureBackendRouteAuthorityV1) {
			const { receipt } = await call(
				"show",
				{ schemaVersion: 1, workflowId },
				exact(authority),
			);
			const workflow = parseWorkflow(receipt.workflow);
			if (workflow.workflowId !== workflowId) graphContractError();
			return workflow;
		},
		async put(intent: GraphPutIntent, authority: DureBackendRouteAuthorityV1) {
			const { receipt } = await call("put", intent, exact(authority));
			const workflow = parseWorkflow(receipt.workflow);
			if (
				workflow.workflowId !== intent.workflowId ||
				workflow.revision !== intent.expectedRevision + 1
			)
				graphContractError();
			return workflow;
		},
		async validate(
			draft: WorkflowDraft,
			authority: DureBackendRouteAuthorityV1,
		) {
			const { receipt } = await call(
				"validate",
				{
					schemaVersion: 1,
					definition: parseDefinition(draft.definition),
					trigger: draft.trigger,
				},
				exact(authority),
			);
			if (
				!Array.isArray(receipt.issues) ||
				!Array.isArray(receipt.order) ||
				receipt.order.some((id) => typeof id !== "string")
			)
				graphContractError();
			return {
				issues: receipt.issues.map(parseGraphIssue),
				order: receipt.order as string[],
			};
		},
		activate: (
			intent: GraphChangeIntent,
			authority: DureBackendRouteAuthorityV1,
		) => change("activate", intent, authority),
		pause: (
			intent: GraphChangeIntent,
			authority: DureBackendRouteAuthorityV1,
		) => change("pause", intent, authority),
		async runOnce(
			intent: GraphChangeIntent,
			authority: DureBackendRouteAuthorityV1,
		) {
			const { receipt } = await call("run_once", intent, exact(authority));
			const run = parseWorkflowRun(receipt.run);
			if (run.workflowId !== intent.workflowId || run.trigger.kind !== "manual")
				graphContractError();
			return run;
		},
		async runs(workflowId: string, authority: DureBackendRouteAuthorityV1) {
			const { receipt } = await call(
				"runs",
				{ schemaVersion: 1, workflowId },
				exact(authority),
			);
			if (!Array.isArray(receipt.runs) || receipt.runs.length > 128)
				graphContractError();
			const runs = receipt.runs.map(parseWorkflowRunSummary);
			if (runs.some((run) => run.workflowId !== workflowId))
				graphContractError();
			return runs;
		},
		async inspect(
			runId: string,
			authority: DureBackendRouteAuthorityV1,
			nodeId?: string,
		) {
			const { receipt } = await call(
				"inspect",
				{ schemaVersion: 1, runId, ...(nodeId ? { nodeId } : {}) },
				exact(authority),
			);
			const run = parseWorkflowRunSummary(receipt.run);
			const version = parseVersion(receipt.version);
			const task = parseActionTask(receipt.task);
			if (!Array.isArray(receipt.tasks) || receipt.tasks.length > 64)
				graphContractError();
			const tasks = receipt.tasks.map(parseActionTaskSummary);
			if (
				run.runId !== runId ||
				run.workflowId !== version.workflowId ||
				run.workflowVersion !== version.version ||
				run.sourceDigest !== version.digest ||
				(nodeId !== undefined && task.nodeId !== nodeId) ||
				!tasks.some(
					(item) =>
						item.nodeId === task.nodeId && item.dispatchId === task.dispatchId,
				) ||
				tasks.some(
					(item) =>
						!version.definition.nodes.some(
							(node) => node.nodeId === item.nodeId,
						),
				)
			)
				graphContractError();
			return { run, version, tasks, task };
		},
	};
}

export type GraphClient = ReturnType<typeof createGraphClient>;
export interface GraphSnapshot {
	authority: DureBackendRouteAuthorityV1;
	workflows: WorkflowSummary[];
}

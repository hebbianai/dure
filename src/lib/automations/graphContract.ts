import { asRecord } from "@/lib/payloadGuards";

export type GraphValue =
	| string
	| number
	| boolean
	| null
	| GraphValue[]
	| { [key: string]: GraphValue };
export type InputBinding =
	| { kind: "literal"; value: GraphValue }
	| { kind: "output"; nodeId: string; field: string };
export interface ActionRef {
	actionId: string;
	version: number;
}
export interface WorkflowNode {
	nodeId: string;
	name: string;
	action: ActionRef;
	inputs: Record<string, InputBinding>;
}
export interface WorkflowEdge {
	source: string;
	target: string;
}
export interface WorkflowDefinition {
	schemaVersion: 1;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}
type WorkflowTrigger =
	| { kind: "manual" }
	| { kind: "schedule"; expression: string; timezone: string };
export interface WorkflowDraft {
	name: string;
	definition: WorkflowDefinition;
	trigger: WorkflowTrigger;
}
export interface WorkflowRecord extends WorkflowDraft {
	schemaVersion: 1;
	workflowId: string;
	revision: number;
	enabled: boolean;
	activeVersion?: number;
	createdAtMs: number;
	updatedAtMs: number;
}
export interface WorkflowSummary {
	schemaVersion: 1;
	workflowId: string;
	revision: number;
	name: string;
	enabled: boolean;
	activeVersion?: number;
	nodeCount: number;
}
export interface WorkflowVersion extends WorkflowDraft {
	schemaVersion: 1;
	workflowId: string;
	version: number;
	sourceRevision: number;
	digest: string;
	createdAtMs: number;
}
export interface FieldContract {
	valueType: "string" | "number" | "boolean" | "json";
	required: boolean;
	acceptsOutput: boolean;
}
export interface ActionContract {
	action: ActionRef;
	inputs: Record<string, FieldContract>;
	outputs: Record<string, FieldContract>;
}
export interface GraphIssue {
	code: string;
	nodeId?: string;
	field?: string;
}
type ActionValues = Record<string, GraphValue>;
type ActionState =
	| { kind: "pending" }
	| {
			kind: "started";
			owner: string;
			inputs: ActionValues;
			startedAtMs: number;
			effectRef?: string;
	  }
	| {
			kind: "completed";
			inputs: ActionValues;
			outputs: ActionValues;
			completedAtMs: number;
			effectRef?: string;
	  }
	| {
			kind: "failed";
			inputs: ActionValues;
			outputs?: ActionValues;
			code: string;
			uncertain: boolean;
			completedAtMs: number;
			effectRef?: string;
	  };
export interface ActionTask {
	taskId: string;
	nodeId: string;
	dispatchId: string;
	action: ActionRef;
	state: ActionState;
}
export interface ActionTaskSummary extends Omit<ActionTask, "state"> {
	state:
		| { kind: "pending" | "started" | "completed" }
		| { kind: "failed"; uncertain: boolean; code: string };
}
export interface WorkflowRunSummary {
	schemaVersion: 1;
	runId: string;
	workflowId: string;
	workflowVersion: number;
	sourceDigest: string;
	status: "pending" | "running" | "completed" | "failed" | "uncertain";
	trigger: WorkflowRun["trigger"];
	createdAtMs: number;
	updatedAtMs: number;
}
export interface WorkflowRun {
	schemaVersion: 1;
	runId: string;
	workflowId: string;
	workflowVersion: number;
	sourceDigest: string;
	revision: number;
	trigger: { kind: "manual" } | { kind: "schedule"; scheduledForMs: number };
	tasks: ActionTask[];
	createdAtMs: number;
	updatedAtMs: number;
}

export function graphContractError(): never {
	throw new Error("workflow_response_invalid");
}
function object(value: unknown): Record<string, unknown> {
	return asRecord(value) ?? graphContractError();
}
function string(value: unknown, max = 256): string {
	return typeof value === "string" && value.length <= max
		? value
		: graphContractError();
}
function id(value: unknown): string {
	const result = string(value, 128);
	return /^[A-Za-z0-9._-]+$/.test(result) ? result : graphContractError();
}
function integer(value: unknown, minimum = 0): number {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= minimum
		? value
		: graphContractError();
}
function boolean(value: unknown): boolean {
	return typeof value === "boolean" ? value : graphContractError();
}
function array<T>(
	value: unknown,
	max: number,
	parse: (value: unknown) => T,
): T[] {
	if (!Array.isArray(value) || value.length > max) graphContractError();
	return value.map(parse);
}
function fields<T>(
	value: unknown,
	parse: (value: unknown) => T,
): Record<string, T> {
	const record = object(value);
	if (Object.keys(record).length > 32) graphContractError();
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [id(key), parse(value)]),
	);
}
function json(value: unknown, depth = 0): GraphValue {
	if (depth > 32) graphContractError();
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map((item) => json(item, depth + 1));
	return Object.fromEntries(
		Object.entries(object(value)).map(([key, value]) => [
			key,
			json(value, depth + 1),
		]),
	);
}
function values(value: unknown, max = 65536): ActionValues {
	if (JSON.stringify(value)?.length > max) graphContractError();
	return fields(value, json);
}
function action(value: unknown): ActionRef {
	const record = object(value);
	return { actionId: id(record.actionId), version: integer(record.version, 1) };
}
function binding(value: unknown): InputBinding {
	const record = object(value);
	if (record.kind === "literal")
		return { kind: "literal", value: json(record.value) };
	if (record.kind === "output")
		return {
			kind: "output",
			nodeId: id(record.nodeId),
			field: id(record.field),
		};
	return graphContractError();
}

export function parseDefinition(value: unknown): WorkflowDefinition {
	const record = object(value);
	if (record.schemaVersion !== 1 || JSON.stringify(value).length > 131072)
		graphContractError();
	const nodes = array(record.nodes, 64, (value) => {
		const node = object(value);
		return {
			nodeId: id(node.nodeId),
			name: string(node.name),
			action: action(node.action),
			inputs: fields(node.inputs, binding),
		};
	});
	if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length)
		graphContractError();
	return {
		schemaVersion: 1,
		nodes,
		edges: array(record.edges, 256, (value) => {
			const edge = object(value);
			return { source: id(edge.source), target: id(edge.target) };
		}),
	};
}

function trigger(value: unknown): WorkflowTrigger {
	const record = object(value);
	if (record.kind === "manual") return { kind: "manual" };
	if (record.kind === "schedule")
		return {
			kind: "schedule",
			expression: string(record.expression, 128),
			timezone: string(record.timezone, 128),
		};
	return graphContractError();
}

export function parseWorkflow(value: unknown): WorkflowRecord {
	const record = object(value);
	if (record.schemaVersion !== 1) graphContractError();
	const createdAtMs = integer(record.createdAtMs);
	return {
		schemaVersion: 1,
		workflowId: id(record.workflowId),
		revision: integer(record.revision, 1),
		name: string(record.name),
		definition: parseDefinition(record.definition),
		trigger: trigger(record.trigger),
		enabled: boolean(record.enabled),
		...(record.activeVersion === undefined
			? {}
			: { activeVersion: integer(record.activeVersion, 1) }),
		createdAtMs,
		updatedAtMs: integer(record.updatedAtMs, createdAtMs),
	};
}

export function parseWorkflowSummary(value: unknown): WorkflowSummary {
	const record = object(value);
	if (record.schemaVersion !== 1) graphContractError();
	const nodeCount = integer(record.nodeCount);
	if (nodeCount > 64) graphContractError();
	return {
		schemaVersion: 1,
		workflowId: id(record.workflowId),
		revision: integer(record.revision, 1),
		name: string(record.name),
		enabled: boolean(record.enabled),
		nodeCount,
		...(record.activeVersion === undefined
			? {}
			: { activeVersion: integer(record.activeVersion, 1) }),
	};
}

export function parseVersion(value: unknown): WorkflowVersion {
	const record = object(value);
	if (record.schemaVersion !== 1) graphContractError();
	return {
		schemaVersion: 1,
		workflowId: id(record.workflowId),
		version: integer(record.version, 1),
		sourceRevision: integer(record.sourceRevision, 1),
		name: string(record.name),
		definition: parseDefinition(record.definition),
		trigger: trigger(record.trigger),
		digest: id(record.digest),
		createdAtMs: integer(record.createdAtMs),
	};
}

export function parseActionContract(value: unknown): ActionContract {
	const record = object(value);
	const field = (value: unknown): FieldContract => {
		const spec = object(value);
		const valueType = spec.valueType;
		if (
			valueType !== "string" &&
			valueType !== "number" &&
			valueType !== "boolean" &&
			valueType !== "json"
		)
			graphContractError();
		return {
			valueType,
			required: boolean(spec.required),
			acceptsOutput: boolean(spec.acceptsOutput),
		};
	};
	return {
		action: action(record.action),
		inputs: fields(record.inputs, field),
		outputs: fields(record.outputs, field),
	};
}

export function parseGraphIssue(value: unknown): GraphIssue {
	const record = object(value);
	return {
		code: id(record.code),
		...(record.nodeId === undefined ? {} : { nodeId: id(record.nodeId) }),
		...(record.field === undefined ? {} : { field: id(record.field) }),
	};
}

function state(value: unknown): ActionState {
	const record = object(value);
	if (record.kind === "pending") return { kind: "pending" };
	const inputs = values(record.inputs, 131072);
	const effect =
		record.effectRef === undefined
			? {}
			: { effectRef: string(record.effectRef) };
	if (record.kind === "started")
		return {
			kind: "started",
			owner: string(record.owner),
			inputs,
			startedAtMs: integer(record.startedAtMs),
			...effect,
		};
	if (record.kind === "completed")
		return {
			kind: "completed",
			inputs,
			outputs: values(record.outputs),
			completedAtMs: integer(record.completedAtMs),
			...effect,
		};
	if (record.kind === "failed")
		return {
			kind: "failed",
			inputs,
			...(record.outputs === undefined
				? {}
				: { outputs: values(record.outputs) }),
			code: id(record.code),
			uncertain: boolean(record.uncertain),
			completedAtMs: integer(record.completedAtMs),
			...effect,
		};
	return graphContractError();
}

export function parseWorkflowRun(value: unknown): WorkflowRun {
	const record = object(value);
	if (record.schemaVersion !== 1) graphContractError();
	const runTrigger = object(record.trigger);
	if (runTrigger.kind !== "manual" && runTrigger.kind !== "schedule")
		graphContractError();
	const createdAtMs = integer(record.createdAtMs);
	const tasks = array(record.tasks, 64, (value) => {
		const task = object(value);
		return {
			taskId: id(task.taskId),
			nodeId: id(task.nodeId),
			dispatchId: id(task.dispatchId),
			action: action(task.action),
			state: state(task.state),
		};
	});
	if (new Set(tasks.map((task) => task.nodeId)).size !== tasks.length)
		graphContractError();
	return {
		schemaVersion: 1,
		runId: id(record.runId),
		workflowId: id(record.workflowId),
		workflowVersion: integer(record.workflowVersion, 1),
		sourceDigest: id(record.sourceDigest),
		revision: integer(record.revision, 1),
		tasks,
		createdAtMs,
		updatedAtMs: integer(record.updatedAtMs, createdAtMs),
		trigger:
			runTrigger.kind === "manual"
				? { kind: "manual" }
				: {
						kind: "schedule",
						scheduledForMs: integer(runTrigger.scheduledForMs),
					},
	};
}

export function parseActionTask(value: unknown): ActionTask {
	const record = object(value);
	return {
		taskId: id(record.taskId),
		nodeId: id(record.nodeId),
		dispatchId: id(record.dispatchId),
		action: action(record.action),
		state: state(record.state),
	};
}

export function parseActionTaskSummary(value: unknown): ActionTaskSummary {
	const record = object(value);
	const state = object(record.state);
	if (
		state.kind !== "pending" &&
		state.kind !== "started" &&
		state.kind !== "completed" &&
		state.kind !== "failed"
	)
		graphContractError();
	return {
		taskId: id(record.taskId),
		nodeId: id(record.nodeId),
		dispatchId: id(record.dispatchId),
		action: action(record.action),
		state:
			state.kind === "failed"
				? {
						kind: "failed",
						code: id(state.code),
						uncertain: boolean(state.uncertain),
					}
				: { kind: state.kind },
	};
}

export function parseWorkflowRunSummary(value: unknown): WorkflowRunSummary {
	const record = object(value);
	if (record.schemaVersion !== 1) graphContractError();
	const status = record.status;
	if (
		status !== "pending" &&
		status !== "running" &&
		status !== "completed" &&
		status !== "failed" &&
		status !== "uncertain"
	)
		graphContractError();
	const trigger = object(record.trigger);
	if (trigger.kind !== "manual" && trigger.kind !== "schedule")
		graphContractError();
	const createdAtMs = integer(record.createdAtMs);
	return {
		schemaVersion: 1,
		runId: id(record.runId),
		workflowId: id(record.workflowId),
		workflowVersion: integer(record.workflowVersion, 1),
		sourceDigest: id(record.sourceDigest),
		status,
		trigger:
			trigger.kind === "manual"
				? { kind: "manual" }
				: { kind: "schedule", scheduledForMs: integer(trigger.scheduledForMs) },
		createdAtMs,
		updatedAtMs: integer(record.updatedAtMs, createdAtMs),
	};
}

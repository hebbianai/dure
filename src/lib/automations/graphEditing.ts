import type {
	ActionContract,
	ActionRef,
	FieldContract,
	InputBinding,
	WorkflowDefinition,
	WorkflowDraft,
	WorkflowEdge,
	WorkflowNode,
	WorkflowRecord,
} from "./graphContract";

export function workflowDraft(record: WorkflowRecord): WorkflowDraft {
	return {
		name: record.name,
		definition: record.definition,
		trigger: record.trigger,
	};
}

export function emptyWorkflow(): WorkflowDraft {
	return {
		name: "",
		definition: { schemaVersion: 1, nodes: [], edges: [] },
		trigger: { kind: "manual" },
	};
}

export function dailyReviewWorkflow(
	labels: { name: string; collect: string; review: string; prompt: string },
	timezone: string,
	projectId?: string,
): WorkflowDraft {
	const project: Record<string, InputBinding> = projectId
		? { projectId: { kind: "literal", value: projectId } }
		: {};
	return {
		name: labels.name,
		trigger: { kind: "schedule", expression: "0 9 * * *", timezone },
		definition: {
			schemaVersion: 1,
			edges: [],
			nodes: [
				{
					nodeId: "collect",
					name: labels.collect,
					action: { actionId: "command", version: 1 },
					inputs: {
						...project,
						script: {
							kind: "literal",
							value: "git log --since='24 hours ago' --format='%h %s' --stat",
						},
					},
				},
				{
					nodeId: "review",
					name: labels.review,
					action: { actionId: "agent", version: 1 },
					inputs: {
						...project,
						prompt: { kind: "literal", value: labels.prompt },
						input: { kind: "output", nodeId: "collect", field: "stdout" },
					},
				},
			],
		},
	};
}

export function appendNode(
	definition: WorkflowDefinition,
	action: ActionRef,
	name: string,
	after?: string,
): { definition: WorkflowDefinition; nodeId: string } {
	const nodeId = `step-${crypto.randomUUID()}`;
	const node: WorkflowNode = { nodeId, name, action, inputs: {} };
	return {
		nodeId,
		definition: {
			...definition,
			nodes: [...definition.nodes, node],
			edges: after
				? [...definition.edges, { source: after, target: nodeId }]
				: definition.edges,
		},
	};
}

/** Keep missing field references visible so deleting a node cannot silently
 * replace its data with a literal, a different node, or a stale sample. */
export function removeNode(
	definition: WorkflowDefinition,
	nodeId: string,
): WorkflowDefinition {
	return {
		...definition,
		nodes: definition.nodes.filter((node) => node.nodeId !== nodeId),
		edges: definition.edges.filter(
			(edge) => edge.source !== nodeId && edge.target !== nodeId,
		),
	};
}

export function updateNode(
	definition: WorkflowDefinition,
	nodeId: string,
	change: Partial<Pick<WorkflowNode, "name" | "inputs">>,
): WorkflowDefinition {
	return {
		...definition,
		nodes: definition.nodes.map((node) =>
			node.nodeId === nodeId ? { ...node, ...change } : node,
		),
	};
}

export function updateInput(
	definition: WorkflowDefinition,
	nodeId: string,
	field: string,
	binding?: InputBinding,
): WorkflowDefinition {
	const node = definition.nodes.find((node) => node.nodeId === nodeId);
	if (!node) return definition;
	const inputs = { ...node.inputs };
	if (binding) inputs[field] = binding;
	else delete inputs[field];
	return updateNode(definition, nodeId, { inputs });
}

export function dependencyEdges(
	definition: WorkflowDefinition,
): (WorkflowEdge & { mapped: boolean })[] {
	const edges = new Map(
		definition.edges.map((edge) => [
			`${edge.source}:${edge.target}`,
			{ ...edge, mapped: false },
		]),
	);
	for (const node of definition.nodes)
		for (const input of Object.values(node.inputs)) {
			if (input.kind === "output")
				edges.set(`${input.nodeId}:${node.nodeId}`, {
					source: input.nodeId,
					target: node.nodeId,
					mapped: true,
				});
		}
	return [...edges.values()];
}

export function contractFor(
	action: ActionRef,
	catalog: ActionContract[],
): ActionContract | undefined {
	return catalog.find(
		(item) =>
			item.action.actionId === action.actionId &&
			item.action.version === action.version,
	);
}

/** Coordinates are presentation state. This default remains deterministic even
 * for incomplete drafts; the backend compiler alone decides execution order. */
export function defaultPositions(
	definition: WorkflowDefinition,
): Record<string, { x: number; y: number }> {
	return Object.fromEntries(
		definition.nodes.map((node, index) => [
			node.nodeId,
			{ x: 48 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 180 },
		]),
	);
}

export function inputFields(contract?: ActionContract) {
	const order = [
		"projectId",
		"providerId",
		"directory",
		"script",
		"prompt",
		"stdin",
		"input",
		"executionProfile",
		"permissionMode",
		"timeoutSeconds",
	];
	return Object.entries(contract?.inputs ?? {}).sort(([a], [b]) => {
		const rank = (field: string) => {
			const index = order.indexOf(field);
			return index < 0 ? order.length : index;
		};
		return rank(a) - rank(b) || a.localeCompare(b);
	});
}

export function availableOutputFields(
	definition: WorkflowDefinition,
	target: string,
	spec: FieldContract,
	catalog: ActionContract[],
) {
	return definition.nodes
		.filter((source) => source.nodeId !== target)
		.flatMap((source) =>
			Object.entries(contractFor(source.action, catalog)?.outputs ?? {}).map(
				([field, output]) => ({
					value: `${source.nodeId}:${field}`,
					source,
					field,
					output,
					compatible:
						output.required &&
						(spec.valueType === "json" || output.valueType === spec.valueType),
				}),
			),
		);
}

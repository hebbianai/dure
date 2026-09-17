import type { Node } from "@xyflow/react";
import { asRecord } from "@/lib/payloadGuards";
import type {
	ActionTaskSummary,
	GraphIssue,
	WorkflowDefinition,
} from "./graphContract";
import { defaultPositions } from "./graphEditing";

export type GraphPositions = Record<string, { x: number; y: number }>;
export type GraphLayouts = Record<string, GraphPositions>;

export function normalizeGraphLayouts(value: unknown): GraphLayouts {
	const layouts = asRecord(value);
	if (!layouts) return {};
	return Object.fromEntries(
		Object.entries(layouts)
			.slice(-128)
			.flatMap(([key, positions]) => {
				const record = asRecord(positions);
				if (!record || key.length > 1024) return [];
				return [
					[
						key,
						Object.fromEntries(
							Object.entries(record)
								.slice(0, 64)
								.flatMap(([nodeId, value]) => {
									const point = asRecord(value);
									if (
										nodeId.length > 128 ||
										typeof point?.x !== "number" ||
										typeof point.y !== "number" ||
										!Number.isFinite(point.x) ||
										!Number.isFinite(point.y) ||
										Math.abs(point.x) > 1e6 ||
										Math.abs(point.y) > 1e6
									)
										return [];
									return [[nodeId, { x: point.x, y: point.y }]];
								}),
						),
					],
				];
			}),
	);
}

export type StepNode = Node<
	{
		name: string;
		action: string;
		issue: boolean;
		state?: ActionTaskSummary["state"];
	},
	"step"
>;

/** Refresh graph data while retaining the canvas library's measured geometry.
 * The library owns node measurement and handles; this projection owns labels,
 * selection, and saved positions only. */
export function projectGraphNodes(
	current: StepNode[],
	definition: WorkflowDefinition,
	selected: string | undefined,
	positions: GraphPositions,
	issues: GraphIssue[],
	tasks: ActionTaskSummary[],
): StepNode[] {
	const previous = new Map(current.map((node) => [node.id, node]));
	const savedPositions = new Map(Object.entries(positions));
	const defaults = defaultPositions(definition);
	const next = definition.nodes.map((node): StepNode => {
		const before = previous.get(node.nodeId);
		const position = savedPositions.get(node.nodeId) ?? defaults[node.nodeId];
		const isSelected = selected === node.nodeId;
		const issue = issues.some((issue) => issue.nodeId === node.nodeId);
		const state = tasks.find((task) => task.nodeId === node.nodeId)?.state;
		if (
			before &&
			before.data.name === node.name &&
			before.data.action === node.action.actionId &&
			before.data.issue === issue &&
			before.data.state === state &&
			before.selected === isSelected &&
			before.position.x === position.x &&
			before.position.y === position.y
		)
			return before;
		return {
			...before,
			id: node.nodeId,
			type: "step",
			position,
			selected: isSelected,
			ariaLabel: node.name,
			data: { name: node.name, action: node.action.actionId, issue, state },
		};
	});
	return next.length === current.length &&
		next.every((node, index) => node === current[index])
		? current
		: next;
}

import {
	Background,
	Handle,
	MarkerType,
	type NodeProps,
	Position,
	ReactFlow,
	type ReactFlowInstance,
	useNodesState,
} from "@xyflow/react";
import { Bot, Maximize, Minus, Plus, Terminal, Workflow } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { Titled } from "@/components/ui/tooltip";
import type {
	ActionTaskSummary,
	GraphIssue,
	WorkflowDefinition,
} from "@/lib/automations/graphContract";
import { dependencyEdges } from "@/lib/automations/graphEditing";
import {
	type GraphPositions,
	projectGraphNodes,
	type StepNode,
} from "@/lib/automations/graphPresentation";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function GraphStep({ data, selected }: NodeProps<StepNode>) {
	const Icon =
		data.action === "agent"
			? Bot
			: data.action === "command"
				? Terminal
				: Workflow;
	const failed = data.issue || data.state?.kind === "failed";
	return (
		<div
			className={cn(
				"w-[208px] rounded-xl border bg-background p-4 shadow-xs",
				selected ? "border-ring ring-1 ring-ring" : "border-border",
				failed && "border-destructive",
			)}
		>
			<Handle
				type="target"
				position={Position.Left}
				className="!size-2 !border-background !bg-muted-foreground"
			/>
			<div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground">
				<Icon className="size-4" />
				<span>{t(`automations.graph.actions.${data.action}`)}</span>
			</div>
			<Titled title={data.name}>
				<div className="truncate text-xs font-medium">
					{data.name}
				</div>
			</Titled>
			<div
				className={cn(
					"mt-2 text-[11px]",
					failed ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{data.issue
					? t("automations.graph.needsSetup")
					: data.state
						? t(
								`automations.graph.states.${data.state.kind === "failed" && data.state.uncertain ? "uncertain" : data.state.kind}`,
							)
						: t("automations.graph.selectToConfigure")}
			</div>
			<Handle
				type="source"
				position={Position.Right}
				className="!size-2 !border-background !bg-muted-foreground"
			/>
		</div>
	);
}

const nodeTypes = { step: GraphStep };
const NO_ISSUES: GraphIssue[] = [];
const NO_TASKS: ActionTaskSummary[] = [];
const graphStyle = {
	"--xy-background-color": "var(--background)",
	"--xy-edge-stroke": "var(--muted-foreground)",
	"--xy-edge-stroke-selected": "var(--foreground)",
	"--xy-background-pattern-dots-color": "var(--border)",
	"--xy-connectionline-stroke": "var(--foreground)",
} as CSSProperties;

export function GraphCanvas({
	definition,
	selected,
	onSelect,
	positions,
	onPositions,
	issues = NO_ISSUES,
	tasks = NO_TASKS,
	editable,
	onConnect,
}: {
	definition: WorkflowDefinition;
	selected?: string;
	onSelect: (nodeId: string) => void;
	positions: GraphPositions;
	onPositions: (positions: GraphPositions, commit?: boolean) => void;
	issues?: GraphIssue[];
	tasks?: ActionTaskSummary[];
	editable: boolean;
	onConnect?: (source: string, target: string) => void;
}) {
	const [flow, setFlow] = useState<ReactFlowInstance<StepNode>>();
	const [nodes, setNodes, applyChanges] = useNodesState<StepNode>(
		projectGraphNodes([], definition, selected, positions, issues, tasks),
	);
	useEffect(() => {
		setNodes((current) =>
			projectGraphNodes(
				current,
				definition,
				selected,
				positions,
				issues,
				tasks,
			),
		);
	}, [definition, selected, positions, issues, tasks, setNodes]);
	const known = new Set(definition.nodes.map((node) => node.nodeId));
	const edges = dependencyEdges(definition)
		.filter((edge) => known.has(edge.source) && known.has(edge.target))
		.map((edge) => ({
			id: `${edge.source}:${edge.target}`,
			source: edge.source,
			target: edge.target,
			type: "smoothstep",
			markerEnd: { type: MarkerType.ArrowClosed },
		}));
	return (
		<div
			className="relative h-full min-h-[300px] min-w-0"
			aria-label={t("automations.graph.canvas")}
		>
			<ReactFlow<StepNode>
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				style={graphStyle}
				fitView
				minZoom={0.35}
				maxZoom={1.5}
				onInit={setFlow}
				nodesDraggable={editable}
				nodesConnectable={editable}
				deleteKeyCode={null}
				onNodeClick={(_, node) => onSelect(node.id)}
				onNodesChange={(changes) => {
					applyChanges(changes);
					const next = { ...positions };
					let moved = false;
					let commit = false;
					for (const change of changes) {
						if (change.type === "position" && change.position) {
							next[change.id] = change.position;
							moved = true;
							commit ||= change.dragging !== true;
						}
						if (change.type === "select" && change.selected)
							onSelect(change.id);
					}
					if (moved) onPositions(next, commit);
				}}
				onConnect={(connection) => {
					if (connection.source !== connection.target)
						onConnect?.(connection.source, connection.target);
				}}
				ariaLabelConfig={{
					"node.a11yDescription.default": t("automations.graph.keyboardHelp"),
					"node.a11yDescription.keyboardDisabled": t(
						"automations.graph.selectToConfigure",
					),
					"edge.a11yDescription.default": t("automations.graph.connectionHelp"),
					"node.a11yDescription.ariaLiveMessage": ({ x, y }) =>
						t("automations.graph.nodeMoved", {
							x: Math.round(x),
							y: Math.round(y),
						}),
					"handle.ariaLabel": t("automations.graph.connectionPoint"),
				}}
			>
				<Background gap={20} size={1} />
			</ReactFlow>
			<div className="absolute bottom-3 left-3 flex gap-1 rounded-lg border border-border bg-background p-1 shadow-xs">
				<IconButton
					title={t("automations.graph.zoomOut")}
					onClick={() => void flow?.zoomOut()}
				>
					<Minus />
				</IconButton>
				<IconButton
					title={t("automations.graph.zoomIn")}
					onClick={() => void flow?.zoomIn()}
				>
					<Plus />
				</IconButton>
				<IconButton
					title={t("automations.graph.fitView")}
					onClick={() => void flow?.fitView({ padding: 0.2 })}
				>
					<Maximize />
				</IconButton>
			</div>
		</div>
	);
}

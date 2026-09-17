import { Trash2, X } from "lucide-react";
import { useState } from "react";
import { GraphInputField } from "@/components/automations/GraphInputField";
import { FormField } from "@/components/common/FormField";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { Input } from "@/components/ui/input";
import { Disclosure } from "@/components/ui/disclosure";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import type {
	ActionContract,
	GraphIssue,
	WorkflowDefinition,
	WorkflowNode,
} from "@/lib/automations/graphContract";
import {
	contractFor,
	dependencyEdges,
	inputFields,
	removeNode,
	updateInput,
	updateNode,
} from "@/lib/automations/graphEditing";
import { graphIssueMessage } from "@/lib/automations/graphMessages";
import { t } from "@/lib/i18n";
import type { ScheduleProject } from "@/lib/ipc/dureSchedule";

export function GraphInspector({
	node,
	definition,
	catalog,
	projects,
	issues,
	disabled,
	onChange,
	onSelect,
}: {
	node: WorkflowNode;
	definition: WorkflowDefinition;
	catalog: ActionContract[];
	projects: ScheduleProject[];
	issues: GraphIssue[];
	disabled: boolean;
	onChange: (definition: WorkflowDefinition) => void;
	onSelect: (nodeId: string) => void;
}) {
	const [confirmDelete, setConfirmDelete] = useState(false);
	const contract = contractFor(node.action, catalog);
	const dependencies = dependencyEdges(definition).filter(
		(edge) => edge.target === node.nodeId,
	);
	const fields = inputFields(contract);
	const advanced = new Set([
		"executionProfile",
		"permissionMode",
		"timeoutSeconds",
	]);
	function renderField([field, spec]: (typeof fields)[number]) {
		const issue = issues.find(
			(issue) => issue.nodeId === node.nodeId && issue.field === field,
		);
		return (
			<GraphInputField
				key={field}
				field={field}
				spec={spec}
				node={node}
				definition={definition}
				catalog={catalog}
				projects={projects}
				error={issue ? graphIssueMessage(issue) : undefined}
				onSelect={onSelect}
				onChange={(binding) =>
					onChange(updateInput(definition, node.nodeId, field, binding))
				}
			/>
		);
	}
	return (
		<aside
			className="min-h-0 min-w-0 overflow-y-auto border-t border-border bg-background p-4 lg:border-t-0 lg:border-l"
			aria-label={t("automations.graph.stepSettings")}
		>
			<fieldset disabled={disabled} className="space-y-5">
				<FormField label={t("automations.graph.stepName")}>
					<Input
						value={node.name}
						onChange={(event) =>
							onChange(
								updateNode(definition, node.nodeId, {
									name: event.target.value,
								}),
							)
						}
					/>
				</FormField>
				<div className="space-y-4">
					{fields.filter(([field]) => !advanced.has(field)).map(renderField)}
				</div>
				<Disclosure
					label={t("automations.graph.advanced")}
					bodyClassName="mt-3 space-y-4"
				>
					{fields.filter(([field]) => advanced.has(field)).map(renderField)}
				</Disclosure>
				<div className="space-y-2 border-t border-border pt-4">
					<FormField label={t("automations.graph.runAfter")}>
						<SelectField
							value=""
							onValueChange={(nextValue) => {
								if (nextValue)
									onChange({
										...definition,
										edges: [
											...definition.edges,
											{ source: nextValue, target: node.nodeId },
										],
									});
							}}
						>
							<SelectOption value="">{t("automations.graph.addConnection")}</SelectOption>
							{definition.nodes
								.filter(
									(source) =>
										source.nodeId !== node.nodeId &&
										!dependencies.some((edge) => edge.source === source.nodeId),
								)
								.map((source) => (
									<SelectOption key={source.nodeId} value={source.nodeId}>
										{source.name}
									</SelectOption>
								))}
						</SelectField>
					</FormField>
					{dependencies.map((edge) => (
						<div
							key={edge.source}
							className="flex items-center justify-between gap-2 text-xs"
						>
							<span className="truncate">
								{definition.nodes.find((node) => node.nodeId === edge.source)
									?.name ?? edge.source}
							</span>
							<IconButton
								title={t(
									edge.mapped
										? "automations.graph.mappedConnection"
										: "automations.graph.removeConnection",
								)}
								disabled={edge.mapped}
								onClick={() =>
									onChange({
										...definition,
										edges: definition.edges.filter(
											(item) =>
												item.source !== edge.source ||
												item.target !== edge.target,
										),
									})
								}
							>
								<X />
							</IconButton>
						</div>
					))}
				</div>
				{confirmDelete ? (
					<InlineConfirmRow
						question={t("automations.graph.deleteConfirm")}
						confirmLabel={t("automations.graph.deleteStep")}
						onConfirm={() => onChange(removeNode(definition, node.nodeId))}
						onCancel={() => setConfirmDelete(false)}
					/>
				) : (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setConfirmDelete(true)}
					>
						<Trash2 />
						{t("automations.graph.deleteStep")}
					</Button>
				)}
			</fieldset>
		</aside>
	);
}

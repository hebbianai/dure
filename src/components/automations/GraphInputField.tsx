import { ArrowUpRight } from "lucide-react";
import { FormField } from "@/components/common/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Textarea } from "@/components/ui/textarea";
import { PROVIDERS } from "@/lib/agents/providerCatalog";
import type {
	ActionContract,
	FieldContract,
	GraphValue,
	InputBinding,
	WorkflowDefinition,
	WorkflowNode,
} from "@/lib/automations/graphContract";
import { availableOutputFields } from "@/lib/automations/graphEditing";
import { graphFieldLabel } from "@/lib/automations/graphMessages";
import { t } from "@/lib/i18n";
import type { ScheduleProject } from "@/lib/ipc/dureSchedule";

export function GraphInputField({
	field,
	spec,
	node,
	definition,
	catalog,
	projects,
	error,
	onChange,
	onSelect,
}: {
	field: string;
	spec: FieldContract;
	node: WorkflowNode;
	definition: WorkflowDefinition;
	catalog: ActionContract[];
	projects: ScheduleProject[];
	error?: string;
	onChange: (binding?: InputBinding) => void;
	onSelect: (nodeId: string) => void;
}) {
	const binding = node.inputs[field];
	const options = availableOutputFields(definition, node.nodeId, spec, catalog);
	const selected =
		binding?.kind === "output"
			? `${binding.nodeId}:${binding.field}`
			: "literal";
	const source =
		binding?.kind === "output"
			? definition.nodes.find((node) => node.nodeId === binding.nodeId)
			: undefined;
	const literal = binding?.kind === "literal" ? binding.value : "";
	const text = typeof literal === "string" ? literal : JSON.stringify(literal);
	const setLiteral = (value: GraphValue) =>
		onChange({ kind: "literal", value });
	const inputId = `graph-input-${node.nodeId}-${field}`;
	const multiline = [
		"script",
		"prompt",
		"input",
		"stdin",
		"executionProfile",
	].includes(field);
	return (
		<FormField
			label={graphFieldLabel(field)}
			htmlFor={inputId}
			error={error}
			description={
				field === "directory"
					? t("automations.graph.directoryHelp")
					: field === "script"
						? t("automations.graph.scriptHelp")
						: undefined
			}
		>
			{spec.acceptsOutput && (
				<SelectField
					value={selected}
					aria-label={t("automations.graph.inputSource", {
						field: graphFieldLabel(field),
					})}
					onValueChange={(nextValue) => {
						const option = options.find((option) => option.value === nextValue);
						if (option)
							onChange({
								kind: "output",
								nodeId: option.source.nodeId,
								field: option.field,
							});
						else onChange({ kind: "literal", value: "" });
					}}
				>
					<SelectOption value="literal">
						{t("automations.graph.literal")}
					</SelectOption>
					{binding?.kind === "output" &&
						!options.some((option) => option.value === selected) && (
							<SelectOption value={selected}>
								{t("automations.graph.missingSource")}
							</SelectOption>
						)}
					{options.map((option) => (
						<SelectOption
							key={option.value}
							value={option.value}
							disabled={!option.compatible}
						>
							{option.source.name} · {graphFieldLabel(option.field)} (
							{option.output.valueType})
						</SelectOption>
					))}
				</SelectField>
			)}
			{binding?.kind === "output" ? (
				<div
					id={inputId}
					className="rounded-lg border border-border bg-muted/20 p-2.5 text-xs"
				>
					<Button
						size="xs"
						variant="ghost"
						className="h-auto max-w-full justify-start px-0 py-0 text-left"
						disabled={!source}
						onClick={() => onSelect(binding.nodeId)}
					>
						<span className="truncate">
							{source?.name ?? binding.nodeId} ·{" "}
							{graphFieldLabel(binding.field)}
						</span>
						<ArrowUpRight className="size-3 shrink-0" />
					</Button>
					<p className="mt-2 text-[11px] leading-4 text-muted-foreground">
						{t("automations.graph.schemaOnly")}
					</p>
				</div>
			) : field === "projectId" ? (
				<SelectField
					id={inputId}
					value={text}
					onValueChange={(nextValue) =>
						nextValue ? setLiteral(nextValue) : onChange(undefined)
					}
				>
					<SelectOption value="">{t("automations.chooseProject")}</SelectOption>
					{text && !projects.some((project) => project.id === text) && (
						<SelectOption value={text}>{text}</SelectOption>
					)}
					{projects.map((project) => (
						<SelectOption key={project.id} value={project.id}>
							{project.displayName}
						</SelectOption>
					))}
				</SelectField>
			) : field === "providerId" ? (
				<SelectField
					id={inputId}
					value={text}
					onValueChange={(nextValue) => setLiteral(nextValue)}
				>
					<SelectOption value="">
						{t("automations.graph.chooseProvider")}
					</SelectOption>
					{text && !(text in PROVIDERS) && (
						<SelectOption value={text}>{text}</SelectOption>
					)}
					{Object.entries(PROVIDERS).map(([id, provider]) => (
						<SelectOption key={id} value={id}>
							{provider.label}
						</SelectOption>
					))}
				</SelectField>
			) : field === "permissionMode" ? (
				<SelectField
					id={inputId}
					value={text || "default"}
					onValueChange={(nextValue) => setLiteral(nextValue)}
				>
					<SelectOption value="default">
						{t("automations.defaultPermissions")}
					</SelectOption>
					<SelectOption value="skip_permissions">
						{t("automations.skipPermissions")}
					</SelectOption>
				</SelectField>
			) : spec.valueType === "number" ? (
				<Input
					id={inputId}
					type="number"
					min={1}
					value={binding ? text : ""}
					placeholder={node.action.actionId === "agent" ? "3600" : "60"}
					onChange={(event) =>
						event.target.value === ""
							? onChange(undefined)
							: setLiteral(Number(event.target.value))
					}
				/>
			) : multiline ? (
				<Textarea
					id={inputId}
					className="min-h-24 resize-y bg-background font-mono text-xs"
					value={text}
					onChange={(event) => {
						if (spec.valueType !== "json") {
							setLiteral(event.target.value);
							return;
						}
						if (event.target.value === "") {
							onChange(undefined);
							return;
						}
						try {
							setLiteral(JSON.parse(event.target.value));
						} catch {
							setLiteral(event.target.value);
						}
					}}
				/>
			) : (
				<Input
					id={inputId}
					value={text}
					className="text-xs"
					onChange={(event) =>
						!spec.required && event.target.value === ""
							? onChange(undefined)
							: setLiteral(event.target.value)
					}
				/>
			)}
		</FormField>
	);
}

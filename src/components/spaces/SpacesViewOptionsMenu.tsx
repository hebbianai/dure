import {
	ArrowUpDown,
	CircleDashed,
	Cloud,
	Eye,
	FolderGit2,
	ListTree,
	MapPin,
	SquareTerminal,
} from "lucide-react";
import { activityLabel } from "@/components/agents/StatusBits";
import { ListViewOptionsMenu } from "@/components/common/ListViewOptionsMenu";
import { spacesEnvironmentLabel } from "@/components/spaces/spacesFacetLabels";
import { t } from "@/lib/i18n";
import type {
	SpacesEnvironment,
	SpacesFilterFacet,
	SpacesGrouping,
	SpacesOrdering,
	SpacesSource,
	SpacesStatusFilter,
	SpacesViewOptions,
	SpacesVisibleField,
} from "@/lib/spaces/spacesViewOptions";
import {
	effectiveSpacesOrdering,
	hasActiveSpacesFilters,
	hasDefaultSpacesFieldsAndFilters,
	resetSpacesFieldsAndFilters,
	spacesFieldsStatedBy,
	spacesOrderingsStatedBy,
	toggleSpacesFilter,
	toggleSpacesVisibleField,
} from "@/lib/spaces/spacesViewOptions";
import type { SpacesFilterChoices } from "@/lib/spaces/spacesViewProjection";
import { PROVIDERS, type Provider } from "@/types";

function statusLabel(status: SpacesStatusFilter): string {
	return status === "unknown" ? t("common.unknown") : activityLabel(status);
}

function sourceLabel(source: SpacesSource): string {
	if (source === "shell") return t("spaces.pane.sourceShell");
	if (source === "ssh") return t("spaces.pane.sourceSsh");
	const provider = source.slice("provider:".length) as Provider;
	return PROVIDERS[provider]?.label ?? provider;
}

export function SpacesViewOptionsMenu({
	value,
	onChange,
	canExpandAll,
	canCollapseAll,
	onExpandAll,
	onCollapseAll,
	filterChoices,
	fieldsPresent,
}: {
	value: SpacesViewOptions;
	onChange: (value: SpacesViewOptions) => void;
	filterChoices: SpacesFilterChoices;
	/** Fields at least one listed row can show; the rest get a hint. Absent
	 *  when the caller has no rows to judge by (no hints then). */
	fieldsPresent?: ReadonlySet<SpacesVisibleField>;
	canExpandAll: boolean;
	canCollapseAll: boolean;
	onExpandAll: () => void;
	onCollapseAll: () => void;
}) {
	// Show offers what a row can add, not what the headings over it already
	// say (owner report 2026-09-14): the fields the grouping states leave the
	// list. Space is the one item that is a tier, not a field: off, the space
	// headings fold away and no row says its space (SpacesRepositorySection).
	const stated = new Set(spacesFieldsStatedBy(value.groupBy));
	// Likewise an ordering the buckets already impose (status inside a status
	// bucket) is not offered; pane order stands in for it while it is stored.
	const statedOrderings = new Set(spacesOrderingsStatedBy(value.groupBy));
	// Space folds a tier and always shows; the fields are judged by the rows.
	const absentHint = (field: SpacesVisibleField) =>
		fieldsPresent && !fieldsPresent.has(field)
			? t("spaces.pane.nothingToShow")
			: undefined;
	const setFilter = <Facet extends SpacesFilterFacet>(
		facet: Facet,
		filterValue: SpacesViewOptions["filters"][Facet][number],
		checked: boolean,
	) =>
		onChange({
			...value,
			filters: toggleSpacesFilter(value.filters, facet, filterValue, checked),
		});
	return (
		<ListViewOptionsMenu
			label={t("spaces.pane.viewOptions")}
			sections={[
				{
					id: "grouping",
					label: t("spaces.pane.grouping"),
					icon: ListTree,
					value: value.groupBy,
					options: [
						{
							value: "repository",
							label: t("spaces.pane.groupByRepository"),
						},
						{ value: "location", label: t("spaces.pane.location") },
						{ value: "space", label: t("common.space") },
						{
							value: "environment",
							label: t("spaces.pane.environment"),
						},
						{ value: "updated", label: t("spaces.pane.updated") },
						{ value: "status", label: t("spaces.pane.status") },
					],
					onValueChange: (groupBy) =>
						onChange({ ...value, groupBy: groupBy as SpacesGrouping }),
				},
				{
					id: "ordering",
					label: t("spaces.pane.ordering"),
					icon: ArrowUpDown,
					value: effectiveSpacesOrdering(value),
					options: (
						[
							{ value: "stable", label: t("spaces.pane.orderByPane") },
							{ value: "updated", label: t("spaces.pane.updated") },
							{ value: "status", label: t("spaces.pane.status") },
						] as const
					).filter((option) => !statedOrderings.has(option.value)),
					onValueChange: (orderBy) =>
						onChange({ ...value, orderBy: orderBy as SpacesOrdering }),
				},
				{
					id: "show",
					kind: "checkbox",
					label: t("spaces.pane.show"),
					icon: Eye,
					values: value.showSpaces
						? [...value.visibleFields, "space"]
						: value.visibleFields,
					// Room for a label, a hint and the check.
					contentClassName: "w-56",
					options: (
						[
							{ value: "updated", label: t("spaces.pane.updated") },
							{ value: "environment", label: t("spaces.pane.environment") },
							{ value: "space", label: t("spaces.pane.space") },
							{ value: "branch", label: t("spaces.pane.branch") },
							{ value: "machine", label: t("spaces.pane.machine") },
							{ value: "details", label: t("spaces.pane.details") },
							{ value: "gitStatus", label: t("spaces.pane.gitStatus") },
						] as const
					)
						.filter((option) => !stated.has(option.value))
						.map((option) =>
							option.value === "space"
								? option
								: { ...option, hint: absentHint(option.value) },
						),
					onCheckedChange: (field, checked) =>
						onChange(
							field === "space"
								? { ...value, showSpaces: checked }
								: {
										...value,
										visibleFields: toggleSpacesVisibleField(
											value.visibleFields,
											field as SpacesVisibleField,
											checked,
										),
									},
						),
				},
			]}
			filterGroup={{
				label: t("spaces.pane.filters"),
				resetLabel: t("spaces.pane.reset"),
				resetEnabled: !hasDefaultSpacesFieldsAndFilters(value),
				onReset: () => onChange(resetSpacesFieldsAndFilters(value)),
				sections: [
					{
						id: "status-filter",
						kind: "checkbox",
						label: t("spaces.pane.status"),
						icon: CircleDashed,
						active: value.filters.status.length > 0,
						values: value.filters.status,
						options: filterChoices.status.map((status) => ({
							value: status,
							label: statusLabel(status),
						})),
						onCheckedChange: (status, checked) =>
							setFilter("status", status as SpacesStatusFilter, checked),
					},
					{
						id: "environment-filter",
						kind: "checkbox",
						label: t("spaces.pane.environment"),
						icon: Cloud,
						active: value.filters.environment.length > 0,
						values: value.filters.environment,
						options: filterChoices.environment.map((environment) => ({
							value: environment,
							label: spacesEnvironmentLabel(environment),
						})),
						onCheckedChange: (environment, checked) =>
							setFilter(
								"environment",
								environment as SpacesEnvironment,
								checked,
							),
					},
					{
						id: "repository-filter",
						kind: "checkbox",
						label: t("spaces.pane.repository"),
						icon: FolderGit2,
						active: value.filters.repository.length > 0,
						values: value.filters.repository,
						options: filterChoices.repository.map((choice) => ({
							value: choice.value,
							label: choice.label ?? t("common.unknown"),
						})),
						onCheckedChange: (repository, checked) =>
							setFilter("repository", repository, checked),
					},
					{
						id: "location-filter",
						kind: "checkbox",
						label: t("spaces.pane.location"),
						icon: MapPin,
						active: value.filters.location.length > 0,
						values: value.filters.location,
						contentClassName: "w-max max-w-[calc(100vw-1rem)]",
						options: filterChoices.location.map((choice) => ({
							value: choice.value,
							label: choice.label ?? t("common.unknown"),
						})),
						onCheckedChange: (location, checked) =>
							setFilter("location", location, checked),
					},
					{
						id: "source-filter",
						kind: "checkbox",
						label: t("spaces.pane.source"),
						icon: SquareTerminal,
						active: value.filters.source.length > 0,
						values: value.filters.source,
						options: filterChoices.source.map((source) => ({
							value: source,
							label: sourceLabel(source),
						})),
						onCheckedChange: (source, checked) =>
							setFilter("source", source as SpacesSource, checked),
					},
				],
			}}
			hasActiveFilters={hasActiveSpacesFilters(value.filters)}
			canExpandAll={canExpandAll}
			canCollapseAll={canCollapseAll}
			expandAllLabel={t("spaces.pane.expandAll")}
			collapseAllLabel={t("spaces.pane.collapseAll")}
			onExpandAll={onExpandAll}
			onCollapseAll={onCollapseAll}
		/>
	);
}

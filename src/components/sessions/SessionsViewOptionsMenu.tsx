import { ArrowUpDown, ListFilter, ListTree } from "lucide-react";
import { ListViewOptionsMenu } from "@/components/common/ListViewOptionsMenu";
import { t } from "@/lib/i18n";
import type {
	SessionsGrouping,
	SessionsOrdering,
	SessionsPaneFilter,
	SessionsViewOptions,
} from "@/lib/sessions/sessionsViewOptions";

export function SessionsViewOptionsMenu({
	value,
	onChange,
	canExpandAll,
	canCollapseAll,
	onExpandAll,
	onCollapseAll,
}: {
	value: SessionsViewOptions;
	onChange(value: SessionsViewOptions): void;
	canExpandAll: boolean;
	canCollapseAll: boolean;
	onExpandAll(): void;
	onCollapseAll(): void;
}) {
	return (
		<ListViewOptionsMenu
			label={t("sessions.viewOptions.title")}
			sections={[
				{
					id: "grouping",
					label: t("sessions.viewOptions.grouping"),
					icon: ListTree,
					value: value.groupBy,
					options: [
						{
							value: "repository",
							label: t("sessions.viewOptions.groupByRepository"),
						},
						{ value: "provider", label: t("common.provider") },
						{ value: "none", label: t("sessions.viewOptions.groupByNone") },
					],
					onValueChange: (groupBy) =>
						onChange({ ...value, groupBy: groupBy as SessionsGrouping }),
				},
				{
					id: "ordering",
					label: t("sessions.viewOptions.ordering"),
					icon: ArrowUpDown,
					value: value.orderBy,
					options: [
						{
							value: "updated",
							label: t("sessions.viewOptions.orderByUpdated"),
						},
						{
							value: "oldest",
							label: t("sessions.viewOptions.orderByOldest"),
						},
						{ value: "name", label: t("common.name") },
					],
					onValueChange: (orderBy) =>
						onChange({ ...value, orderBy: orderBy as SessionsOrdering }),
				},
				{
					id: "pane-filter",
					label: t("sessions.viewOptions.filtering"),
					icon: ListFilter,
					value: value.paneFilter,
					contentClassName: "w-max min-w-64 max-w-[calc(100vw-1rem)]",
					options: [
						{ value: "all", label: t("sessions.viewOptions.filterAll") },
						{
							value: "exclude_open",
							label: t("sessions.viewOptions.filterExcludeOpen"),
						},
						{
							value: "open_only",
							label: t("sessions.viewOptions.filterOpenOnly"),
						},
					],
					onValueChange: (paneFilter) =>
						onChange({
							...value,
							paneFilter: paneFilter as SessionsPaneFilter,
						}),
				},
			]}
			canExpandAll={canExpandAll}
			canCollapseAll={canCollapseAll}
			expandAllLabel={t("sessions.viewOptions.expandAll")}
			collapseAllLabel={t("sessions.viewOptions.collapseAll")}
			onExpandAll={onExpandAll}
			onCollapseAll={onCollapseAll}
		/>
	);
}

import { LoadingStatus, PanelStatus } from "@/components/common/PanelStatus";
import { useState } from "react";
import { RecentSessionRemoteResumeDialog } from "@/components/sessions/RecentSessionRemoteResumeDialog";
import { RecentWorkSection } from "@/components/sessions/RecentWorkSection";
import { SessionsViewOptionsMenu } from "@/components/sessions/SessionsViewOptionsMenu";
import { useRecentSessionsList } from "@/components/sessions/useRecentSessionsList";
import { useSessionsPaneState } from "@/components/sessions/useSessionsPaneState";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import { SearchField } from "@/components/ui/search-field";
import { t } from "@/lib/i18n";
import { refreshRecentSessionHistory } from "@/lib/sessions/recentSessionHistoryResource";
import {
	foldRecentSessionGroups,
	recentSessionsFoldAvailability,
} from "@/lib/sessions/recentSessionsViewProjection";
import type { RecentSessionRegistrationDecision } from "@/lib/sessions/recentWork";
import { takePendingSessionsPanelSearch } from "@/lib/sessions/sessionsPanelIntent";

export function SessionsPane() {
	const { sessionsViewOptions, setSessionsViewOptions } =
		useSessionsPaneState();
	const [search, setSearch] = useState(takePendingSessionsPanelSearch);
	const [openGroups, setOpenGroups] = useState<
		Readonly<Record<string, boolean>>
	>({});
	const [remoteResumeDecision, setRemoteResumeDecision] =
		useState<RecentSessionRegistrationDecision>();
	const list = useRecentSessionsList({
		query: search,
		viewOptions: sessionsViewOptions,
	});
	const groups = list.projection.groups;
	// A search holds every matching group open, and an ungrouped list has no
	// groups to fold, so the bulk fold commands stand down in both.
	const fold = recentSessionsFoldAvailability(
		groups,
		openGroups,
		sessionsViewOptions.groupBy !== "none" && !search.trim(),
	);
	return (
		<>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
				<SectionHeaderRow
					as="h2"
					label={t("common.session")}
					actions={
						<>
							<SessionsViewOptionsMenu
								value={sessionsViewOptions}
								onChange={setSessionsViewOptions}
								canExpandAll={fold.canExpandAll}
								canCollapseAll={fold.canCollapseAll}
								onExpandAll={() =>
									setOpenGroups((current) =>
										foldRecentSessionGroups(current, groups, "expand"),
									)
								}
								onCollapseAll={() =>
									setOpenGroups((current) =>
										foldRecentSessionGroups(current, groups, "collapse"),
									)
								}
							/>
							<RefreshButton
								busy={list.loading}
								disabled={list.loading}
								onClick={() => void refreshRecentSessionHistory(list.sshHosts)}
							/>
						</>
					}
				/>
				<div className="shrink-0 px-3 pt-3.5 pb-2">
					<SearchField
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={t("sessions.list.searchPlaceholder")}
						inputClassName="h-8"
					/>
				</div>
				{/* First load with nothing to show yet: the pane centres one loading
				    state where the list will be, instead of a row at the top of it. */}
				{list.bootstrapping ? (
					<LoadingStatus className="min-h-0 flex-1" />
				) : (
					<SidebarScrollArea
						edgeFade
						className="min-h-0 flex-1"
						viewportClassName="px-2 pb-3"
					>
						{/* Provider history is independent of runtime census. Runtime identity
						    is still checked by the selected conversation's resume action. */}
						{list.hasContent ? (
							<RecentWorkSection
								list={list}
								query={search}
								viewOptions={sessionsViewOptions}
								openGroups={openGroups}
								onToggleGroup={(groupId, open) =>
									setOpenGroups((current) => ({ ...current, [groupId]: open }))
								}
								onRegistrationDecision={setRemoteResumeDecision}
							/>
						) : (
							<PanelStatus size="xs" className="py-8">
								{search.trim()
									? t("sessions.list.searchEmpty")
									: t("sessions.recent.empty")}
							</PanelStatus>
						)}
					</SidebarScrollArea>
				)}
			</div>
			<RecentSessionRemoteResumeDialog
				decision={remoteResumeDecision}
				onClose={() => setRemoteResumeDecision(undefined)}
			/>
		</>
	);
}

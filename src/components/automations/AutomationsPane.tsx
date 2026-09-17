import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { Plus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { lazy, Suspense, useState } from "react";
import { AutomationEditor } from "@/components/automations/AutomationEditor";
import { AutomationListItem } from "@/components/automations/AutomationListItem";
import { useAutomations } from "@/components/automations/useAutomations";
import { PaneEmptyState } from "@/components/common/PaneEmptyState";
import { LoadingStatus } from "@/components/common/PanelStatus";
import { LoadingRow } from "@/components/common/StatusBlocks";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import type { AutomationSchedule } from "@/lib/automations/scheduleContract";
import { t } from "@/lib/i18n";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

const GraphEditor = lazy(() =>
	import("@/components/automations/GraphEditor").then((module) => ({
		default: module.GraphEditor,
	})),
);

export function AutomationsPane() {
	const {
		client,
		graphClient,
		graphs,
		graphError,
		snapshot,
		loading,
		error,
		pro,
		refresh,
	} = useAutomations();
	const [editing, setEditing] = useState<{
		kind: "schedule" | "graph";
		schedule?: AutomationSchedule;
		workflowId?: string;
		authority: DureBackendRouteAuthorityV1;
	}>();
	const editable =
		pro && !!snapshot && !!graphs && !loading && !error && !graphError;
	const count =
		(snapshot?.schedules.length ?? 0) + (graphs?.workflows.length ?? 0);
	function openEditor(schedule?: AutomationSchedule) {
		if (snapshot)
			setEditing({
				kind: schedule ? "schedule" : "graph",
				schedule,
				authority: snapshot.authority,
			});
	}
	return (
		<section
			className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5"
			aria-label={t("automations.title")}
		>
			<SectionHeaderRow
				as="h2"
				label={t("automations.title")}
				actions={
					<>
						<RefreshButton
							busy={loading}
							disabled={loading || !!editing}
							onClick={refresh}
						/>
						{pro && (
							<IconButton
								title={t("automations.new")}
								disabled={!editable}
								onClick={() => openEditor()}
							>
								<Plus />
							</IconButton>
						)}
					</>
				}
			/>
			{/* The empty pane is the house empty state (PaneEmptyState): the
			    notice, the intro sentence as its explanation and the one action
			    full width under it — the same block, and the same glass button,
			    as the SSH tab's "Add SSH host" (owner call 2026-09-10). Before
			    it was a glyph over a hint over a smaller button, the one tab
			    that drew its own. The first load centres its indicator in the
			    pane like every other tab; a refresh with a list on screen shows
			    on the header's refresh button instead of a row above the list. */}
			{!snapshot && loading ? (
				<LoadingStatus className="min-h-0 flex-1" />
			) : !loading && !error && !graphError && snapshot && count === 0 ? (
				<PaneEmptyState
					role="status"
					compact
					title={t("automations.empty")}
					description={t("automations.intro")}
					action={
						pro ? (
							<Button
								variant="glass"
								className="w-full"
								disabled={!editable}
								onClick={() => openEditor()}
							>
								<Plus aria-hidden />
								{t("automations.new")}
							</Button>
						) : undefined
					}
				/>
			) : (
			<SidebarScrollArea className="min-h-0 flex-1">
				<div className="space-y-3 px-3 py-3">
					<p className="text-xs leading-5 text-muted-foreground">
						{t("automations.intro")}
					</p>
					{snapshot && (
						<OverflowRevealText text={t("automations.runtime", { name: snapshot.authority.profileId })}
							className="text-[11px] text-muted-foreground" />
					)}
					{error && <Alert>{error}</Alert>}
					{graphError && <Alert>{graphError}</Alert>}
					{graphs?.workflows.map((workflow) => (
						<AutomationListItem
							key={workflow.workflowId}
							name={workflow.name}
							detail={t("automations.graph.stepCount", {
								count: workflow.nodeCount,
							})}
							status={t(
								workflow.enabled
									? "automations.graph.active"
									: workflow.activeVersion
										? "automations.paused"
										: "automations.graph.draft",
							)}
							disabled={loading || !!error || !!graphError}
							onOpen={() =>
								setEditing({
									kind: "graph",
									workflowId: workflow.workflowId,
									authority: graphs.authority,
								})
							}
						/>
					))}
					{snapshot?.schedules.map((schedule) => (
						<AutomationListItem
							key={schedule.scheduleId}
							name={schedule.name}
							detail={`${schedule.expression} · ${schedule.timezone}`}
							status={t(
								schedule.enabled ? "automations.active" : "automations.paused",
							)}
							disabled={loading || !!error}
							onOpen={() => openEditor(schedule)}
						/>
					))}
					{snapshot && !snapshot.complete && (
						<p className="text-xs text-muted-foreground">
							{t("automations.limited")}
						</p>
					)}
				</div>
			</SidebarScrollArea>
			)}
			{editing?.kind === "schedule" && (
				<AutomationEditor
					client={client}
					authority={editing.authority}
					schedule={editing.schedule}
					pro={pro}
					onSaved={refresh}
					onClose={() => setEditing(undefined)}
				/>
			)}
			{editing?.kind === "graph" && (
				<Suspense fallback={<LoadingRow>{t("common.loading")}</LoadingRow>}>
					<GraphEditor
						client={graphClient}
						scheduleClient={client}
						authority={editing.authority}
						workflowId={editing.workflowId}
						pro={pro}
						onSaved={refresh}
						onClose={() => setEditing(undefined)}
					/>
				</Suspense>
			)}
		</section>
	);
}

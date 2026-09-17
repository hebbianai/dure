import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { useEffect, useMemo } from "react";
import { Alert } from "@/components/ui/alert";
import { PanelsTopLeft } from "lucide-react";
import { GitHubSidebarWorkspace } from "@/components/github/GitHubWorkspacePanel";
import { IssueTrackerView } from "@/components/plugins/IssueTrackerView";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { IconButton } from "@/components/ui/icon-button";
import { resolveLang, t } from "@/lib/i18n";
import {
	type DurePluginViewContainer,
	issueTrackerContribution,
	pluginLocalizedText,
	pluginSettingsTarget,
	pluginWorkspaceBooleanDefault,
} from "@/lib/plugins/durePlugins";
import { pluginWorkspaceContext } from "@/lib/plugins/pluginWorkspace";
import { pluginSidebarContainerKey } from "@/lib/plugins/pluginSidebarSelection";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { cn } from "@/lib/utils";
import { openGitHubWorkspacePanel } from "@/lib/workspace/dock/openGitHubWorkspacePanel";
import { useStore } from "@/store";

export function PluginViewHost({
	contribution,
}: {
	contribution: DurePluginViewContainer;
}) {
	const language = useStore((state) => state.language);
	const focus = useStore((state) => state.focusCtx);
	const projects = useStore((state) => state.projects);
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const lang = resolveLang(language);
	const workspace = useMemo(
		() => pluginWorkspaceContext(focus, projects),
		[focus, projects],
	);
	const workspaceProject = workspace?.projectId
		? projects.find((project) => project.id === workspace.projectId)
		: undefined;
	const isGitHub = contribution.plugin.manifest.id === "dure.github";
	const openGitHubWorkspace = () =>
		openGitHubWorkspacePanel(
			activeSpaceId,
			workspaceProject?.kind === "local" ? workspaceProject.id : null,
			workspaceProject?.kind === "local" ? workspaceProject.name : undefined,
		);
	const selection = useWindowSidebarStore((state) => state.pluginSelection);
	const selectPluginView = useWindowSidebarStore((state) => state.selectPluginView);
	const containerKey = pluginSidebarContainerKey(contribution);
	const requestedViewId =
		selection?.containerKey === containerKey ? selection.viewId : null;
	const selectedView =
		contribution.views.find((view) => view.id === requestedViewId) ??
		contribution.views[0];
	useEffect(() => {
		if (
			selection?.containerKey === containerKey &&
			requestedViewId !== (selectedView?.id ?? null)
		) {
			selectPluginView({ containerKey, viewId: selectedView?.id ?? null });
		}
	}, [containerKey, requestedViewId, selectedView?.id, selection?.containerKey, selectPluginView]);
	const provider = useMemo(
		() =>
			selectedView?.kind === "issue_tracker"
				? issueTrackerContribution(
						contribution.plugin,
						selectedView.provider_contribution_id,
					)
				: undefined,
		[contribution.plugin, selectedView],
	);
	const queryTitles = useMemo(() => {
		if (selectedView?.kind !== "issue_tracker" || !selectedView.query_titles) {
			return undefined;
		}
		const titles = selectedView.query_titles;
		return Object.fromEntries(
			(["ready", "list", "human"] as const).flatMap((query) => {
				const title = titles[query];
				return title ? [[query, pluginLocalizedText(title, lang)]] : [];
			}),
		) as Partial<Record<"ready" | "list" | "human", string>>;
	}, [lang, selectedView]);
	const agentClaims =
		selectedView?.kind === "issue_tracker" &&
		selectedView.agent_claims?.surfaces.includes("primary_sidebar")
			? {
					title: pluginLocalizedText(selectedView.agent_claims.title, lang),
					settingKey: selectedView.agent_claims.setting_key,
					statuses: selectedView.agent_claims.statuses,
					defaultVisible:
						pluginWorkspaceBooleanDefault(
							contribution.plugin,
							selectedView.agent_claims.setting_key,
						) ?? false,
				}
			: undefined;

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
			<SectionHeaderRow
				as="h2"
				className="shrink-0"
				label={pluginLocalizedText(contribution.container.title, lang)}
				actions={
					isGitHub ? (
						<IconButton
							title={t("github.workspace.open")}
							onClick={openGitHubWorkspace}
						>
							<PanelsTopLeft />
						</IconButton>
					) : undefined
				}
			/>
			{isGitHub && (
				<GitHubSidebarWorkspace
					projectId={
						workspaceProject?.kind === "local" ? workspaceProject.id : undefined
					}
				/>
			)}
			{!isGitHub && contribution.views.length > 1 && (
				<div className="flex gap-1 px-3 py-2">
					{contribution.views.map((view) => (
						<button
							key={view.id}
							type="button"
							className={cn(
								"min-w-0 rounded-md px-2 py-1 text-[11px] font-medium",
								view.id === selectedView?.id
									? "bg-sidebar-accent text-sidebar-foreground"
									: "text-muted-foreground hover:bg-sidebar-accent/60",
							)}
							aria-pressed={view.id === selectedView?.id}
							onClick={() => selectPluginView({ containerKey, viewId: view.id })}
						>
							<OverflowRevealText text={pluginLocalizedText(view.title, lang)} />
						</button>
					))}
				</div>
			)}
			{!isGitHub &&
				(!selectedView || !provider ? (
					<Alert surface="outline" className="mx-3 mt-2">
						<span>{t("plugins.views.providerUnavailable")}</span>
					</Alert>
				) : (
					<IssueTrackerView
					key={`${contribution.plugin.manifest.id}:${contribution.contributionId}:${selectedView.id}`}
					pluginName={contribution.plugin.manifest.display_name}
					pluginId={contribution.plugin.manifest.id}
					viewContributionId={contribution.contributionId}
					contributionId={provider.contribution_id}
					viewId={selectedView.id}
					defaultQuery={selectedView.default_query}
					defaultQuerySettingKey={
						selectedView.default_query_setting_key ?? undefined
					}
					watchIntervalSettingKey={
						selectedView.watch_interval_setting_key ?? undefined
					}
					settingsTarget={pluginSettingsTarget(contribution.plugin)}
					operations={provider.provider.operations}
					mutationDelivery={
						provider.provider.mutation_delivery?.kind === "terminal_command"
							? provider.provider.mutation_delivery
							: null
					}
					agentClaims={agentClaims}
					queryTitles={queryTitles}
					/>
				))}
		</div>
	);
}

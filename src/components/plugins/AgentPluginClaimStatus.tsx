import { ListTodo } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMountedAgentClaimPanes } from "@/components/plugins/useAgentClaimPanes";
import { useIssueTrackerClaimProjection } from "@/components/plugins/useIssueTrackerClaimProjection";
import { usePluginIssueTrackerWorkspace } from "@/components/plugins/usePluginIssueTrackerWorkspace";
import { usePluginViewCatalog } from "@/components/plugins/usePluginViewCatalog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveLang, t } from "@/lib/i18n";
import {
	groupAgentClaims,
	selectAgentClaimPanes,
} from "@/lib/plugins/agentClaims";
import {
	type DurePluginAgentClaimView,
	pluginAgentClaimViews,
	pluginLocalizedText,
	pluginSettingsTarget,
	pluginWorkspaceBooleanDefault,
} from "@/lib/plugins/durePlugins";
import { resolveIssueTrackerClaimConfiguration } from "@/lib/plugins/issueTrackerClaimConfiguration";
import { issueTrackerWatchInterval } from "@/lib/plugins/issueTrackerUi";
import {
	pluginSidebarContainerKey,
	type PluginSidebarSelection,
} from "@/lib/plugins/pluginSidebarSelection";
import {
	type PluginWorkspaceContext,
	pluginWorkspaceContext,
} from "@/lib/plugins/pluginWorkspace";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";
import type { Agent } from "@/types";

interface ClaimSourceProjection {
	pluginName: string;
	viewTitle: string;
	target: PluginSidebarSelection;
	workspaceKey: string;
	issues: Array<{ id: string; title: string }>;
	incomplete: boolean;
}

const EMPTY_CLAIM_ISSUES: Array<{ id: string; title: string }> = [];
const MAX_TOOLTIP_SOURCES = 4;
const MAX_TOOLTIP_ISSUES_PER_SOURCE = 5;
const MAX_TOOLTIP_TITLE_CHARACTERS = 160;
const MAX_TOOLTIP_CHARACTERS = 2_048;

function boundedClaimTooltip(projections: ClaimSourceProjection[]): string {
	const lines = projections.slice(0, MAX_TOOLTIP_SOURCES).map((projection) => {
		const visible = projection.issues
			.slice(0, MAX_TOOLTIP_ISSUES_PER_SOURCE)
			.map(
				(issue) =>
					`${issue.id} · ${issue.title.slice(0, MAX_TOOLTIP_TITLE_CHARACTERS)}`,
			);
		if (projection.issues.length > visible.length) {
			visible.push(
				t("plugins.claims.more", {
					n: projection.issues.length - visible.length,
				}),
			);
		}
		return `${projection.pluginName.slice(0, MAX_TOOLTIP_TITLE_CHARACTERS)}\n${
			visible.join("\n") || t("plugins.claims.incomplete")
		}`;
	});
	if (projections.length > lines.length) {
		lines.push(
			t("plugins.claims.more", { n: projections.length - lines.length }),
		);
	}
	return lines.join("\n\n").slice(0, MAX_TOOLTIP_CHARACTERS);
}

function ClaimSourceObserver({
	source,
	workspace,
	paneId,
	panes,
	onChange,
}: {
	source: DurePluginAgentClaimView;
	workspace: PluginWorkspaceContext;
	paneId: string;
	panes: ReturnType<typeof selectAgentClaimPanes>;
	onChange: (key: string, projection: ClaimSourceProjection | null) => void;
}) {
	const view = source.view;
	const language = useStore((state) => state.language);
	const destination = useMemo(
		() => ({
			viewTitle: pluginLocalizedText(view.title, resolveLang(language)),
			target: {
				containerKey: pluginSidebarContainerKey({
					plugin: source.plugin,
					contributionId: source.viewContributionId,
					container: { id: view.container_id },
				}),
				viewId: view.id,
			},
		}),
		[language, source.plugin, source.viewContributionId, view.container_id, view.id, view.title],
	);
	const claims = view.agent_claims;
	const settingsTarget = useMemo(
		() => pluginSettingsTarget(source.plugin),
		[source.plugin],
	);
	const sourceKey = `${source.plugin.manifest.id}:${source.viewContributionId}:${source.view.id}:${source.contributionId}:${JSON.stringify(settingsTarget)}`;
	const workspaceInput = useMemo(
		() => ({
			pluginId: source.plugin.manifest.id,
			contributionId: source.contributionId,
			settingsTarget,
			workspace,
		}),
		[
			settingsTarget,
			source.contributionId,
			source.plugin.manifest.id,
			workspace,
		],
	);
	const configuration = usePluginIssueTrackerWorkspace(workspaceInput);
	const intervalSeconds = issueTrackerWatchInterval(
		configuration.settings?.values ?? {},
		view.watch_interval_setting_key ?? undefined,
	);
	const claimConfiguration = useMemo(
		() =>
			resolveIssueTrackerClaimConfiguration({
				pluginId: source.plugin.manifest.id,
				viewContributionId: source.viewContributionId,
				viewId: source.view.id,
				contributionId: source.contributionId,
				workspace,
				settingsTarget,
				claims: claims
					? {
							settingKey: claims.setting_key,
							statuses: claims.statuses,
							defaultVisible:
								pluginWorkspaceBooleanDefault(source.plugin, claims.setting_key) ?? false,
						}
					: null,
				operations: source.provider.provider.operations,
				intervalSeconds,
				configuration: {
					permission: configuration.permission,
					activation: configuration.activation,
					settings: configuration.settings,
					settingsLoaded: configuration.settingsLoaded,
					settingsError: configuration.settingsError,
				},
			}),
		[
			claims,
			configuration.activation,
			configuration.permission,
			configuration.settings,
			configuration.settingsError,
			configuration.settingsLoaded,
			intervalSeconds,
			settingsTarget,
			source.contributionId,
			source.plugin,
			source.provider.provider.operations,
			source.view.id,
			source.viewContributionId,
			workspace,
		],
	);
	const claimPolicyUnavailable =
		claimConfiguration.kind === "unavailable" &&
		claimConfiguration.reason === "policy_epoch";
	const projectionInput =
		claimConfiguration.kind === "ready" ? claimConfiguration.input : null;
	const projection = useIssueTrackerClaimProjection(projectionInput);
	const groups = useMemo(
		() =>
			claims
				? groupAgentClaims(panes, projection.issues, claims.statuses)
				: { panes: [], unmatched: [] },
		[claims, panes, projection.issues],
	);
	const issues =
		groups.panes.find((pane) => pane.id === paneId)?.issues ??
		EMPTY_CLAIM_ISSUES;
	const status = useMemo<ClaimSourceProjection | null>(() => {
		if (configuration.settingsError || claimPolicyUnavailable) {
			return {
				...destination,
				pluginName: source.plugin.manifest.display_name,
				workspaceKey: workspace.watchKey,
				issues: EMPTY_CLAIM_ISSUES,
				incomplete: true,
			};
		}
		if (!projectionInput || projection.loading) return null;
		if (issues.length === 0 && projection.complete && !projection.error) {
			return null;
		}
		return {
			...destination,
			pluginName: source.plugin.manifest.display_name,
			workspaceKey: workspace.watchKey,
			issues,
			incomplete: !projection.complete || projection.error !== null,
		};
	}, [
		destination,
		claimPolicyUnavailable,
		configuration.settingsError,
		issues,
		projection,
		projectionInput,
		source.plugin.manifest.display_name,
		workspace.watchKey,
	]);
	useEffect(() => {
		onChange(sourceKey, status);
	}, [onChange, sourceKey, status]);
	useEffect(
		() => () => {
			onChange(sourceKey, null);
		},
		[onChange, sourceKey],
	);
	return null;
}

/** Compact, declarative claim projection for one agent pane. It never activates
 * a provider; only an explicitly activated workspace can acquire the shared
 * read/watch resource. */
export function AgentPluginClaimStatus({
	agent,
	paneId,
	onNavigate,
}: {
	agent: Agent;
	paneId: string;
	onNavigate?: () => void;
}) {
	const projects = useStore((state) => state.projects);
	const agents = useStore((state) => state.agents);
	const mountedPanes = useMountedAgentClaimPanes(agent.id, paneId);
	const { catalog } = usePluginViewCatalog();
	const [sourceProjections, setSourceProjections] = useState<
		Record<string, ClaimSourceProjection>
	>({});
	const project = projects.find(
		(candidate) => candidate.id === agent.projectId,
	);
	const workspace = useMemo(
		() =>
			project
				? pluginWorkspaceContext(
						{
							cwd: project.path,
							source: project.kind,
							hostId: project.sshHostId,
						},
						projects,
					)
				: null,
		[project, projects],
	);
	const panes = useMemo(
		() =>
			selectAgentClaimPanes(
				mountedPanes.map((pane) => ({
					key: pane.id,
					kind: "agent",
					agentId: pane.agentId,
				})),
				agents,
				project?.id ?? null,
			),
		[agents, mountedPanes, project?.id],
	);
	const sources = useMemo(
		() => pluginAgentClaimViews(catalog ?? [], "agent_pane_claim_status"),
		[catalog],
	);
	const updateSource = useCallback(
		(key: string, projection: ClaimSourceProjection | null) => {
			setSourceProjections((current) => {
				if (projection && current[key] === projection) return current;
				if (!projection && !(key in current)) return current;
				const next = { ...current };
				if (projection) next[key] = projection;
				else delete next[key];
				return next;
			});
		},
		[],
	);
	const projections = workspace
		? Object.values(sourceProjections).filter(
				(projection) => projection.workspaceKey === workspace.watchKey,
			)
		: [];
	const issues = projections.flatMap((projection) => projection.issues);
	const tooltip = boundedClaimTooltip(projections);
	const destinations = projections.filter(
		(projection) => projection.issues.length > 0,
	);
	const open = (projection: ClaimSourceProjection) => {
		// Dockview owns pane activation and publishes the canonical focus context.
		onNavigate?.();
		useWindowSidebarStore.getState().openPluginView({ ...projection.target });
	};
	const badge = (
		<Button
			variant="ghost"
			className="h-auto gap-1 rounded border-0 bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground"
			title={tooltip}
			aria-label={tooltip}
			data-agent-id={agent.id}
			onClick={destinations.length === 1 ? () => open(destinations[0]) : undefined}
		>
			<ListTodo className="size-3 shrink-0" />
			<span className="font-mono text-foreground/80">{issues.length}</span>
		</Button>
	);

	if (workspace?.source !== "local") return null;
	return (
		<>
			{sources.map((source) => {
				const claims = source.view.agent_claims;
				if (!claims) return null;
				return (
					<ClaimSourceObserver
						key={`${source.plugin.manifest.id}:${source.viewContributionId}:${source.view.id}:${source.contributionId}`}
						source={source}
						workspace={workspace}
						paneId={paneId}
						panes={panes}
						onChange={updateSource}
					/>
				);
			})}
			{/* Icon and count only (owner decision 2026-09-03): the issue id and
			 * the incomplete marker moved into the tooltip, so the chip never
			 * truncates and never needs a width cap. With no claims the chip is
			 * absent even when the read was incomplete; the tooltip cannot exist
			 * without the chip, and a marker without a count was noise. */}
			{issues.length > 0 &&
				(destinations.length === 1 ? badge : (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>{badge}</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{destinations.map((projection) => (
								<DropdownMenuItem
									key={`${projection.target.containerKey}:${projection.target.viewId}`}
									onSelect={() => open(projection)}
								>
									{projection.pluginName} · {projection.viewTitle}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				))}
		</>
	);
}

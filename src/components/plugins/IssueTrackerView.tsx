import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { LoadingStatus } from "@/components/common/PanelStatus";
import { ArrowLeft, Copy } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	EmptyHint, LoadingRow} from "@/components/common/StatusBlocks";
import { IssueTrackerAgentClaims } from "@/components/plugins/IssueTrackerAgentClaims";
import { IssueTrackerIssueRows } from "@/components/plugins/IssueTrackerIssueRows";
import { PluginPermissionControls } from "@/components/plugins/PluginPermissionControls";
import { useIssueTrackerClaimProjection } from "@/components/plugins/useIssueTrackerClaimProjection";
import { useIssueTrackerQuery } from "@/components/plugins/useIssueTrackerQuery";
import { useIssueTrackerWatch } from "@/components/plugins/useIssueTrackerWatch";
import { usePluginIssueTrackerWorkspace } from "@/components/plugins/usePluginIssueTrackerWorkspace";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { ErrorText } from "@/components/ui/error-text";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import type {
	IssueTrackerCountsV1,
	IssueTrackerIssueDetailV1,
	IssueTrackerMutationDeliveryV1,
	IssueTrackerIssueSummaryV1,
	IssueTrackerOperationV1,
	PluginIssueTrackerDefaultQueryV1,
	PluginSettingValueV1,
} from "@/contracts/generated/extensionContracts";
import { requestQuickDispatch } from "@/lib/agents/quickDispatch/quickDispatchActivation";
import { t } from "@/lib/i18n";
import { dureIssueTrackerActivate, readFile } from "@/lib/ipc";
import { copyTextToClipboard } from "@/lib/platform/clipboardWrite";
import type { DurePluginSettingsTargetV2 } from "@/lib/plugins/durePlugins";
import {
	isIssueTrackerPermissionEnabled,
	resolveIssueTrackerClaimConfiguration,
} from "@/lib/plugins/issueTrackerClaimConfiguration";
import { renderIssueTrackerTerminalCommand } from "@/lib/plugins/issueTrackerMutationDelivery";
import {
	type IssueTrackerListMode,
	issueTrackerCountsResult,
	issueTrackerDetailResult,
	issueTrackerErrorMessage,
	issueTrackerInitialMode,
	issueTrackerListModes,
	issueTrackerListQuery,
	issueTrackerListResult,
	issueTrackerWatchInterval,
} from "@/lib/plugins/issueTrackerUi";
import { issueTrackerWatchSubscriberId } from "@/lib/plugins/issueTrackerWatchLease";
import {
	filterIssueTrackerIssues,
	issueTrackerAgentForIssue,
	issueTrackerStartPrefill,
} from "@/lib/plugins/issueTrackerWorkItem";
import { pluginWorkspaceContext } from "@/lib/plugins/pluginWorkspace";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { openAgentPanelOnDesktop } from "@/lib/workspace/dock";
import { openCommandTerminalPanel } from "@/lib/workspace/dock/openCommandTerminal";
import { useStore } from "@/store";

interface IssueTrackerViewProps {
	pluginName: string;
	pluginId: string;
	viewContributionId: string;
	contributionId: string;
	viewId: string;
	defaultQuery: PluginIssueTrackerDefaultQueryV1;
	defaultQuerySettingKey?: string;
	watchIntervalSettingKey?: string;
	settingsTarget: DurePluginSettingsTargetV2 | null;
	operations: IssueTrackerOperationV1[];
	/** Provider-declared command templates for row mutations. The host never
	 * runs them: the view renders one `{issue_id}` and opens a command pane in
	 * the workspace. Absent when the provider declares no terminal mutation. */
	mutationDelivery?: IssueTrackerMutationDeliveryV1 | null;
	agentClaims?: {
		title: string;
		settingKey: string;
		statuses: string[];
		defaultVisible: boolean;
	};
	/** The plugin's own names for the neutral queries (already localized);
	 * a missing entry falls back to the host's generic label. */
	queryTitles?: Partial<Record<IssueTrackerListMode, string>>;
}

// Thunks so t() runs at render time — a module-scope t() call would freeze
// the boot language.
const MODE_LABELS: Record<IssueTrackerListMode, () => string> = {
	ready: () => t("plugins.issueTracker.mode.ready"),
	list: () => t("plugins.issueTracker.mode.openIssues"),
	blocked: () => t("plugins.issueTracker.mode.blocked"),
	human: () => t("interactions.decision.required"),
};
const EMPTY_SETTING_VALUES: Record<string, PluginSettingValueV1> = {};
const EMPTY_ISSUES: IssueTrackerIssueSummaryV1[] = [];

function modeCount(
	mode: IssueTrackerListMode,
	counts: IssueTrackerCountsV1 | null,
): number | null {
	if (!counts || mode === "human") return null;
	if (mode === "ready") return counts.ready;
	if (mode === "blocked") return counts.blocked;
	return counts.open;
}

function IssueDetail({
	detail,
	loading,
	error,
	onBack,
}: {
	detail: IssueTrackerIssueDetailV1 | null;
	loading: boolean;
	error: string | null;
	onBack: () => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<SectionHeaderRow
				label={detail?.summary.id ?? t("plugins.issueTracker.detail.title")}
				actions={
					<>
						{detail && (
							<IconButton
								title={t("plugins.issueTracker.detail.copyId")}
								onClick={() => void copyTextToClipboard(detail.summary.id)}
							>
								<Copy />
							</IconButton>
						)}
						<IconButton
							title={t("plugins.issueTracker.detail.backToList")}
							onClick={onBack}
						>
							<ArrowLeft />
						</IconButton>
					</>
				}
			/>
			<SidebarScrollArea
				className="min-h-0 flex-1"
				viewportClassName="px-4 pb-4"
			>
				{loading && (
					<LoadingRow className="py-4">{t("common.loading")}</LoadingRow>
				)}
				{error && <ErrorText className="py-3">{error}</ErrorText>}
				{detail && (
					<article className="pt-2 text-xs">
						<h2 className="leading-5 font-semibold text-sidebar-foreground">
							{detail.summary.title}
						</h2>
						<div className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
							<span className="rounded bg-foreground/8 px-1.5 py-0.5">
								{detail.summary.status}
							</span>
							{detail.summary.priority !== null && (
								<span className="rounded bg-foreground/8 px-1.5 py-0.5">
									P{detail.summary.priority}
								</span>
							)}
							<span className="rounded bg-foreground/8 px-1.5 py-0.5">
								{detail.summary.issue_type}
							</span>
						</div>
						{(
							[
								[
									t("plugins.issueTracker.detail.description"),
									detail.description,
								],
								[t("plugins.issueTracker.detail.design"), detail.design],
								[
									t("plugins.issueTracker.detail.acceptanceCriteria"),
									detail.acceptance_criteria,
								],
								[t("plugins.issueTracker.detail.notes"), detail.notes],
							] as Array<[string, string | null]>
						).map(
							([label, value]) =>
								value && (
									<section key={label} className="mt-4">
										<h3 className="text-[11px] font-semibold text-muted-foreground">
											{label}
										</h3>
										<p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-sidebar-foreground select-text">
											{value}
										</p>
									</section>
								),
						)}
					</article>
				)}
			</SidebarScrollArea>
		</div>
	);
}

export function IssueTrackerView({
	pluginName,
	pluginId,
	viewContributionId,
	contributionId,
	viewId,
	defaultQuery,
	defaultQuerySettingKey,
	watchIntervalSettingKey,
	settingsTarget,
	operations,
	mutationDelivery,
	agentClaims,
	queryTitles,
}: IssueTrackerViewProps) {
	const focus = useStore((state) => state.focusCtx);
	const projects = useStore((state) => state.projects);
	const agents = useStore((state) => state.agents);
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const workspace = useMemo(
		() => pluginWorkspaceContext(focus, projects),
		[focus, projects],
	);
	const workspaceInput = useMemo(
		() =>
			workspace?.source === "local"
				? { pluginId, contributionId, settingsTarget, workspace }
				: null,
		[contributionId, pluginId, settingsTarget, workspace],
	);
	const configuration = usePluginIssueTrackerWorkspace(workspaceInput);
	const permissionEnabled = isIssueTrackerPermissionEnabled(configuration.permission);
	const supportedModes = useMemo(
		() => issueTrackerListModes(operations),
		[operations],
	);
	const fallbackMode = supportedModes.includes(defaultQuery)
		? defaultQuery
		: (supportedModes[0] ?? "list");
	const [mode, setMode] = useState<IssueTrackerListMode>(fallbackMode);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
	const navigation = useWindowSidebarStore((state) => state.pluginSelection);
	useEffect(() => {
		// Explicit sidebar navigation returns from an issue detail to the pane claims.
		setSelectedIssueId(null);
	}, [navigation]);
	const [activating, setActivating] = useState(false);
	const [activationError, setActivationError] = useState<string | null>(null);
	// The armed row swaps to an in-place confirm; the delete itself runs as a
	// wrapper command in its own pane, never as a host call.
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	// Whether this workspace can run the provider's command templates at all.
	// Null until the probe answers, so no action flickers into the menu.
	const [mutationsRunnable, setMutationsRunnable] = useState<boolean | null>(
		null,
	);
	const subscriberId = useMemo(
		() =>
			issueTrackerWatchSubscriberId("plugin-view", [
				pluginId,
				viewContributionId,
				contributionId,
				viewId,
			]),
		[contributionId, pluginId, viewContributionId, viewId],
	);
	// Pane focus is presentation state; query lifetime follows the resolved
	// execution root, not each freshly projected workspace object.
	const localWorkspaceRoot =
		workspace?.source === "local" ? workspace.root : null;
	const requiredScript = mutationDelivery?.requires_package_script ?? null;
	// A template that goes through a package script can only run in a
	// workspace that declares it. Offering an action that always fails is
	// worse than offering none, so the menu waits for this answer.
	useEffect(() => {
		if (!localWorkspaceRoot || !mutationDelivery) {
			setMutationsRunnable(false);
			return;
		}
		if (!requiredScript) {
			setMutationsRunnable(true);
			return;
		}
		let active = true;
		void readFile(`${localWorkspaceRoot}/package.json`)
			.then((file) => {
				const scripts = JSON.parse(file.content)?.scripts;
				if (active) {
					setMutationsRunnable(typeof scripts?.[requiredScript] === "string");
				}
			})
			.catch(() => {
				if (active) setMutationsRunnable(false);
			});
		return () => {
			active = false;
		};
	}, [localWorkspaceRoot, mutationDelivery, requiredScript]);

	const runRowMutation = (
		template: readonly string[] | null | undefined,
		issueId: string,
		title: string,
	) => {
		const line =
			template && localWorkspaceRoot
				? renderIssueTrackerTerminalCommand(template, issueId)
				: null;
		if (!line || !localWorkspaceRoot) return;
		// The wrapper command runs in its own pane in the item's workspace: the
		// host never writes to the tracker, the user watches the transaction,
		// and the pane closes itself when the command succeeds.
		openCommandTerminalPanel(activeSpaceId, {
			title,
			command: line,
			cwd: localWorkspaceRoot,
			closeOnSuccess: true,
		});
	};
	const activationTarget = localWorkspaceRoot
		? `${pluginId}\u0000${contributionId}\u0000${localWorkspaceRoot}`
		: null;
	const activationTargetRef = useRef(activationTarget);
	activationTargetRef.current = activationTarget;
	const activationState = activating ? "activating" : configuration.activation;
	const queryTarget = useMemo(
		() =>
			localWorkspaceRoot && permissionEnabled && activationState === "active"
				? {
						plugin_id: pluginId,
						contribution_id: contributionId,
						workspace_root: localWorkspaceRoot,
					}
				: null,
		[
			activationState,
			contributionId,
			localWorkspaceRoot,
			permissionEnabled,
			pluginId,
		],
	);
	const listRequest = useMemo(
		() =>
			queryTarget && !selectedIssueId
				? { ...queryTarget, query: issueTrackerListQuery(mode) }
				: null,
		[mode, queryTarget, selectedIssueId],
	);
	const detailRequest = useMemo(
		() =>
			queryTarget && selectedIssueId
				? {
						...queryTarget,
						query: { kind: "show" as const, issue_id: selectedIssueId },
					}
				: null,
		[queryTarget, selectedIssueId],
	);
	const supportsCounts = operations.includes("list");
	const countsRequest = useMemo(
		() =>
			queryTarget && supportsCounts
				? { ...queryTarget, query: { kind: "counts" as const } }
				: null,
		[queryTarget, supportsCounts],
	);
	const listQuery = useIssueTrackerQuery(listRequest, issueTrackerListResult);
	const detailQuery = useIssueTrackerQuery(
		detailRequest,
		issueTrackerDetailResult,
	);
	const countsQuery = useIssueTrackerQuery(
		countsRequest,
		issueTrackerCountsResult,
		{ keepDataOnRefresh: true },
	);
	const issues = listQuery.data ?? EMPTY_ISSUES;
	const detail = detailQuery.data;
	const counts = countsQuery.data;
	const activeQuery = selectedIssueId ? detailQuery : listQuery;
	const loading = activeQuery.loading;
	const error =
		activeQuery.error === null
			? null
			: issueTrackerErrorMessage(activeQuery.error);
	const settingValues = configuration.settings?.values ?? EMPTY_SETTING_VALUES;
	const watchInterval = issueTrackerWatchInterval(
		settingValues,
		watchIntervalSettingKey,
	);
	const claimConfiguration = useMemo(
		() =>
			resolveIssueTrackerClaimConfiguration({
				pluginId,
				viewContributionId,
				viewId,
				contributionId,
				workspace,
				settingsTarget,
				claims: agentClaims,
				operations,
				intervalSeconds: watchInterval,
				configuration: {
					permission: configuration.permission,
					activation: activationState,
					settings: configuration.settings,
					settingsLoaded: configuration.settingsLoaded,
					settingsError: configuration.settingsError,
				},
			}),
		[
			activationState,
			agentClaims,
			configuration.permission,
			configuration.settings,
			configuration.settingsError,
			configuration.settingsLoaded,
			contributionId,
			operations,
			pluginId,
			settingsTarget,
			viewContributionId,
			viewId,
			watchInterval,
			workspace,
		],
	);
	const showAgentClaims = claimConfiguration.kind !== "hidden";
	const claimProjectionInput =
		claimConfiguration.kind === "ready" ? claimConfiguration.input : null;
	const claimProjection = useIssueTrackerClaimProjection(claimProjectionInput);

	useEffect(() => {
		setActivating(false);
		setActivationError(null);
		setSearchQuery("");
	}, [activationTarget]);

	useEffect(() => {
		setSelectedIssueId(null);
		setMode(fallbackMode);
	}, [activationTarget, fallbackMode]);

	useEffect(() => {
		if (!configuration.settingsLoaded) return;
		const configuredMode = issueTrackerInitialMode(
			defaultQuery,
			settingValues,
			defaultQuerySettingKey,
		);
		setMode(
			supportedModes.includes(configuredMode) ? configuredMode : fallbackMode,
		);
	}, [
		configuration.settingsLoaded,
		defaultQuery,
		defaultQuerySettingKey,
		fallbackMode,
		settingValues,
		supportedModes,
	]);

	useEffect(() => {
		if (permissionEnabled) return;
		setSelectedIssueId(null);
	}, [permissionEnabled]);

	useIssueTrackerWatch({
		enabled: queryTarget !== null && operations.includes("watch"),
		pluginId,
		contributionId,
		workspace: workspace?.source === "local" ? workspace : null,
		subscriberId,
		intervalSeconds: watchInterval,
		includeAgentClaims: false,
		onEvent: (event) => {
			countsQuery.refresh();
			if (selectedIssueId) {
				detailQuery.refresh();
			} else if (event.state.kind === "snapshot" && mode === "list") {
				listQuery.replace(event.state.snapshot.issues);
			} else if (event.state.kind === "snapshot" && mode === "human") {
				listQuery.replace(event.state.snapshot.human_issues);
			} else {
				listQuery.refresh();
			}
		},
	});

	const visibleIssues = useMemo(
		() => filterIssueTrackerIssues(issues, searchQuery),
		[issues, searchQuery],
	);
	const modeOptions = supportedModes.map((candidate) => {
		const label = queryTitles?.[candidate] ?? MODE_LABELS[candidate]();
		const count = modeCount(candidate, counts);
		const countLabel = count === null ? "…" : String(count);
		return {
			value: candidate,
			ariaLabel: candidate === "human" ? label : `${label} ${countLabel}`,
			label:
				candidate === "human" ? (
					<OverflowRevealText className="max-w-full" text={label} />
				) : (
					<span className="flex max-w-full min-w-0 items-center justify-center gap-1">
						<OverflowRevealText text={label} />
						<span className="shrink-0 font-mono tabular-nums">{countLabel}</span>
					</span>
				),
		};
	});
	const projectId = workspace?.projectId ?? null;
	const prefillForIssue = (issue: IssueTrackerIssueSummaryV1) =>
		projectId
			? issueTrackerStartPrefill({
					pluginId,
					pluginName,
					projectId,
					issue,
				})
			: null;
	const agentForIssue = (issue: IssueTrackerIssueSummaryV1) => {
		const prefill = prefillForIssue(issue);
		return prefill && projectId
			? issueTrackerAgentForIssue(issue, projectId, prefill, agents)
			: undefined;
	};
	const openOrStartIssue = (issue: IssueTrackerIssueSummaryV1) => {
		const prefill = prefillForIssue(issue);
		if (!prefill) return;
		const agent = issueTrackerAgentForIssue(
			issue,
			prefill.projectId,
			prefill,
			agents,
		);
		if (agent === null) return;
		if (agent) openAgentPanelOnDesktop(activeSpaceId, agent);
		else requestQuickDispatch(prefill);
	};

	const activateWorkspace = async () => {
		if (workspace?.source !== "local" || !permissionEnabled) return;
		const target = activationTarget;
		if (!target) return;
		setActivating(true);
		setActivationError(null);
		try {
			await dureIssueTrackerActivate({
				plugin_id: pluginId,
				contribution_id: contributionId,
				workspace_root: workspace.root,
			});
			if (activationTargetRef.current !== target) return;
			setActivating(false);
		} catch (activationFailure) {
			if (activationTargetRef.current !== target) return;
			setActivationError(t(issueTrackerErrorMessage(activationFailure)));
			setActivating(false);
		}
	};

	if (!workspace) {
		return (
			<p className="px-4 pt-3 text-xs leading-5 text-muted-foreground">
				{t("plugins.issueTracker.selectWorkspace")}
			</p>
		);
	}
	if (workspace.source === "ssh") {
		return (
			<p className="px-4 pt-3 text-xs leading-5 text-muted-foreground">
				{t("plugins.issueTracker.sshUnsupported")}
			</p>
		);
	}
	if (!configuration.permissionLoaded || !permissionEnabled) {
		// The manifest contributes this placement, but the disabled surface is
		// trusted host chrome only: no plugin query, watcher, or claim projection
		// is mounted until the exact workspace/plan permission is enabled.
		return (
			<SidebarScrollArea className="min-h-0 flex-1" viewportClassName="pb-3">
				<GlassPanel className="mx-3 mt-3 overflow-hidden rounded-lg">
					<PluginPermissionControls
						pluginName={pluginName}
						pluginId={pluginId}
						workspaceRoot={workspace.root}
					/>
				</GlassPanel>
			</SidebarScrollArea>
		);
	}
	if (activationState === "checking") {
		return (
			<LoadingStatus
				className="min-h-0 flex-1"
				label={t("plugins.issueTracker.activationChecking")}
			/>
		);
	}
	if (activationState !== "active") {
		return (
			<GlassPanel className="mx-3 mt-3 rounded-lg px-3 py-3">
				<h2 className="text-xs font-semibold text-sidebar-foreground">
					{t("plugins.issueTracker.start.title", { name: pluginName })}
				</h2>
				<p className="mt-1 text-[11px] leading-5 text-muted-foreground">
					{t("plugins.issueTracker.start.description")}
				</p>
				{(activationError || configuration.activationError) && (
					<ErrorText className="mt-2 text-[11px] leading-4">
						{activationError ??
							t(issueTrackerErrorMessage(configuration.activationError))}
					</ErrorText>
				)}
				<Button
					type="button"
					size="sm"
					className="mt-3"
					disabled={activationState === "activating"}
					onClick={() => void activateWorkspace()}
				>
					{activationState === "activating"
						? t("plugins.issueTracker.start.inProgress")
						: t("plugins.issueTracker.start.action")}
				</Button>
			</GlassPanel>
		);
	}
	if (selectedIssueId) {
		return (
			<IssueDetail
				detail={detail}
				loading={loading}
				error={error}
				onBack={() => setSelectedIssueId(null)}
			/>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{configuration.settingsError && (
				<Alert surface="outline" className="mx-3 mt-2">
					<span>{t("plugins.settings.loadFailed")}</span>
				</Alert>
			)}
			<div className="shrink-0 space-y-1 border-b border-border/60 px-2 py-1.5">
				<div
					role="toolbar"
					aria-label={t("plugins.issueTracker.toolbar.modes")}
					className="flex min-w-0 items-center"
				>
					<Segmented
						value={mode}
						onChange={setMode}
						options={modeOptions}
						variant="pills"
						size="sm"
						className="w-full min-w-0"
					/>
				</div>
				<div
					role="toolbar"
					aria-label={t("plugins.issueTracker.toolbar.query")}
					className="flex min-w-0 items-center gap-1"
				>
					<SearchField
						type="search"
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.currentTarget.value)}
						onClear={() => setSearchQuery("")}
						placeholder={t("plugins.issueTracker.search.placeholder")}
						aria-label={t("plugins.issueTracker.search.label")}
						className="min-w-0 flex-1"
						inputClassName="h-7"
					/>
					<output
						aria-live="polite"
						aria-label={t("plugins.issueTracker.resultCount", {
							count: visibleIssues.length,
						})}
						className="w-5 shrink-0 text-center font-mono text-[10px] tabular-nums text-muted-foreground"
					>
						{visibleIssues.length}
					</output>
					<RefreshButton
						busy={loading}
						disabled={loading}
						onClick={() => {
							listQuery.refresh();
							countsQuery.refresh();
						}}
					/>
				</div>
			</div>
			{agentClaims && showAgentClaims && (
				<IssueTrackerAgentClaims
					projectId={workspace.projectId}
					title={agentClaims.title}
					statuses={agentClaims.statuses}
					claimIssues={claimProjection.issues}
					complete={claimProjection.complete}
					loading={claimProjection.loading}
					error={
						claimProjection.error
							? t(issueTrackerErrorMessage(claimProjection.error))
							: null
					}
					canOpen={operations.includes("show")}
					onOpen={(issueId) => setSelectedIssueId(issueId)}
				/>
			)}
			{loading && visibleIssues.length === 0 && !error ? (
				<LoadingStatus className="min-h-0 flex-1" />
			) : (
			<SidebarScrollArea
				className="min-h-0 flex-1"
				viewportClassName="pb-3"
			>
				{error && (
					<Alert surface="outline" className="mx-3 mt-2">
						<span>{error}</span>
					</Alert>
				)}
				{!loading && !error && visibleIssues.length === 0 && (
					<EmptyHint className="px-2">
						{searchQuery.trim()
							? t("plugins.issueTracker.search.empty")
							: t("plugins.issueTracker.empty")}
					</EmptyHint>
				)}
				<IssueTrackerIssueRows
					issues={visibleIssues}
					canOpen={operations.includes("show")}
					onOpen={setSelectedIssueId}
					workActionForIssue={(issue) => {
						if (!projectId) return null;
						const agent = agentForIssue(issue);
						if (agent === null) return null;
						return agent ? "open" : "start";
					}}
					onWorkAction={openOrStartIssue}
					canClose={
						mutationsRunnable === true && Boolean(mutationDelivery?.close)
					}
					onClose={(issueId) =>
						runRowMutation(
							mutationDelivery?.close,
							issueId,
							t("plugins.issueTracker.close.paneTitle", { id: issueId }),
						)
					}
					canDelete={
						mutationsRunnable === true && Boolean(mutationDelivery?.delete)
					}
					confirmDeleteId={confirmDeleteId}
					onArmDelete={setConfirmDeleteId}
					onCancelDelete={() => setConfirmDeleteId(null)}
					onConfirmDelete={(issueId) => {
						runRowMutation(
							mutationDelivery?.delete,
							issueId,
							t("plugins.issueTracker.delete.paneTitle", { id: issueId }),
						);
						setConfirmDeleteId(null);
					}}
				/>
			</SidebarScrollArea>
			)}
		</div>
	);
}

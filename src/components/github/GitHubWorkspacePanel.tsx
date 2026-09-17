import type { IDockviewPanelProps } from "dockview-react";
import { Alert } from "@/components/ui/alert";
import {
	CircleDot,
	ExternalLink,
	FolderKanban,
	GitPullRequest,
	Plus,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { PaneEmptyState } from "@/components/common/PaneEmptyState";
import { LoadingStatus } from "@/components/common/PanelStatus";
import { GitHubFilters } from "@/components/github/GitHubFilters";
import { GitHubIssueDetail } from "@/components/github/GitHubIssueDetail";
import { GitHubPagination } from "@/components/github/GitHubPagination";
import { GitHubWorkspaceRows } from "@/components/github/GitHubWorkspaceRows";
import {
	useGitHubOpenIssueKeys,
	useGitHubWorkspaceState,
} from "@/components/github/useGitHubWorkspaceState";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { RefreshButton } from "@/components/ui/refresh-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { usePaneFirstReveal } from "@/components/workspace/usePaneFirstReveal";
import {
	type GitHubFilterField,
	reduceGitHubWorkspaceFilters,
} from "@/lib/github/githubFilters";
import { githubQueryFailureMessage } from "@/lib/github/githubQuery";
import type { GitHubWorkItemRow } from "@/lib/github/githubResponses";
import {
	type GitHubWorkspacePreset,
	type GitHubWorkspaceView,
	githubProjectsWebUrl,
} from "@/lib/github/githubWorkspace";
import type { GitHubWorkspaceError } from "@/lib/github/githubWorkspaceQuery";
import { t } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { githubIssuePaneRow } from "@/lib/github/githubIssuePane";
import { useGitHubWorkspacePagination } from "./useGitHubWorkspacePagination";
import { useGitHubWorkspaceQuery } from "./useGitHubWorkspaceQuery";
import { cn } from "@/lib/utils";

export interface GitHubWorkspacePanelParams {
	projectId?: string;
}

const ALL_REPOSITORIES = "__all__";

function viewOptions() {
	return [
		{
			value: "issues" as const,
			label: t("github.workspace.tab.issues"),
			icon: <CircleDot className="size-3.5" />,
		},
		{
			value: "pullRequests" as const,
			label: t("github.workspace.tab.pullRequests"),
			icon: <GitPullRequest className="size-3.5" />,
		},
		{
			value: "projects" as const,
			label: t("github.workspace.tab.projects"),
			icon: <FolderKanban className="size-3.5" />,
		},
	];
}

function presetsFor(view: GitHubWorkspaceView) {
	const options: { value: GitHubWorkspacePreset; label: string }[] = [
		{ value: "open", label: t("github.workspace.filter.open") },
	];
	if (view !== "projects") {
		options.push({ value: "mine", label: t("github.workspace.filter.mine") });
	}
	if (view === "pullRequests") {
		options.push({
			value: "needsReview",
			label: t("github.workspace.filter.needsReview"),
		});
	}
	options.push({ value: "all", label: t("github.workspace.filter.all") });
	return options;
}

function searchPlaceholder(view: GitHubWorkspaceView): string {
	switch (view) {
		case "projects":
			return t("github.workspace.search.projects");
		case "pullRequests":
			return t("github.workspace.search.pullRequests");
		default:
			return t("github.workspace.search.issues");
	}
}

function useDebouncedValue(value: string, delayMs: number): string {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [delayMs, value]);
	return debounced;
}

function errorMessage(error: GitHubWorkspaceError): string {
	const prefix = error.repository ? `${error.repository}: ` : "";
	return (
		prefix +
		(error.failure.kind === "project-scope"
			? t("github.workspace.projects.permission")
			: githubQueryFailureMessage(error.failure))
	);
}

export function GitHubWorkspacePanel(
	props: IDockviewPanelProps<GitHubWorkspacePanelParams>,
) {
	const revealed = usePaneFirstReveal(props.api);
	return (
		<GitHubWorkspaceSurface
			initialProjectId={props.params.projectId}
			revealed={revealed}
			mode="pane"
		/>
	);
}

export interface GitHubIssuePanelParams {
	row: GitHubWorkItemRow;
}

/** One issue, as a pane. The row snapshot arrives in the params so the pane
 *  can paint at once (and restore with the layout); edits made inside flow
 *  back into the params so a restored pane shows what was last saved — minus
 *  the transcript, which the detail loads itself (githubIssuePaneRow). */
export function GitHubIssuePanel(
	props: IDockviewPanelProps<GitHubIssuePanelParams>,
) {
	const { agents, activeSpaceId } = useGitHubWorkspaceState();
	// The detail owns loaded data. Persisting its summary must not feed a new
	// request input back into that same mounted detail.
	const [row] = useState(props.params.row);
	const persistRow = useCallback(
		(next: GitHubWorkItemRow) => {
			props.api.updateParameters({ row: githubIssuePaneRow(next) });
		},
		[props.api],
	);
	return (
		<div data-pane-surface="own" className="flex h-full min-h-0 min-w-0 flex-col bg-surface-background text-foreground">
			<GitHubIssueDetail
				key={`${row.repository.projectId}:${row.url}`}
				row={row}
				agents={agents}
				activeSpaceId={activeSpaceId}
				onUpdated={persistRow}
			/>
		</div>
	);
}

export function GitHubSidebarWorkspace({ projectId }: { projectId?: string }) {
	return (
		<GitHubWorkspaceSurface
			initialProjectId={projectId}
			revealed
			mode="sidebar"
		/>
	);
}

/* The width each table needs before it is worth drawing: the fixed columns
 * plus a title column wide enough to read (GitHubWorkspaceRows draws them at
 * min-w 900, 1040 with the merge column, 720 for projects). A pane narrower
 * than its view's number takes the sidebar's card list instead — the same
 * form, more of it per row. The pane is still the ledger's surface (that is
 * why openGitHubWorkspacePanel exists); this only keeps a squeezed one
 * readable instead of clipped mid-column (owner report 2026-09-13). */
const TABLE_MIN_WIDTH: Record<GitHubWorkspaceView, number> = {
	issues: 900,
	pullRequests: 1040,
	projects: 720,
};

function GitHubWorkspaceSurface({
	initialProjectId,
	revealed,
	mode,
}: {
	initialProjectId?: string;
	revealed: boolean;
	mode: "pane" | "sidebar";
}) {
	const { projects, agents, activeSpaceId } = useGitHubWorkspaceState();
	// Registration-time Git availability can be stale. The current GitHub query
	// owns repository discovery and its errors for every registered local folder.
	const localRepositories = useMemo(
		() => projects.filter((project) => project.kind === "local"),
		[projects],
	);
	const resolvedInitialProjectId = localRepositories.some(
		(project) => project.id === initialProjectId,
	)
		? (initialProjectId as string)
		: localRepositories.length === 1
			? localRepositories[0].id
			: ALL_REPOSITORIES;
	const [{ view, preset, query }, changeFilters] = useReducer(
		reduceGitHubWorkspaceFilters,
		{ view: "issues", preset: "open", query: "" },
	);
	const [projectId, setProjectId] = useState(resolvedInitialProjectId);
	const surfaceRoot = useRef<HTMLDivElement | null>(null);
	const [surfaceWidth, setSurfaceWidth] = useState(0);
	useEffect(() => {
		const node = surfaceRoot.current;
		if (!node || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			setSurfaceWidth(entries[0]?.contentRect.width ?? 0);
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	// Unmeasured counts as wide: a window or a full-width pane is the common
	// case, and starting on the table avoids a card flash there.
	const dense =
		mode === "pane" &&
		(surfaceWidth === 0 || surfaceWidth >= TABLE_MIN_WIDTH[view]);
	const debouncedQuery = useDebouncedValue(query, 250);
	const [refreshRevision, setRefreshRevision] = useState(0);
	const [selectedIssue, setSelectedIssue] = useState<GitHubWorkItemRow | null>(
		null,
	);
	const selectionTrigger = useRef<HTMLElement | null>(null);
	const listSurface = useRef<HTMLDivElement>(null);
	const listScroll = useRef<HTMLDivElement>(null);
	const updateIssue = useCallback(() => {
		// GitHub owns membership in a filtered query, including after detail edits.
		setRefreshRevision((current) => current + 1);
	}, []);
	const selectWorkItem = (row: GitHubWorkItemRow) => {
		if (row.kind === "pr") {
			void openExternalUrl(row.url);
			return;
		}
		selectionTrigger.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		setSelectedIssue(row);
	};
	const openIssueKeys = useGitHubOpenIssueKeys(mode);

	useEffect(() => {
		if (
			selectedIssue &&
			(!localRepositories.some(
				(project) => project.id === selectedIssue.repository.projectId,
			) ||
				(projectId !== ALL_REPOSITORIES &&
					projectId !== selectedIssue.repository.projectId))
		)
			setSelectedIssue(null);
	}, [projectId, localRepositories, selectedIssue]);

	useEffect(() => {
		const requested = initialProjectId;
		if (
			requested &&
			localRepositories.some((project) => project.id === requested)
		) {
			setProjectId(requested);
		}
	}, [initialProjectId, localRepositories]);

	useEffect(() => {
		if (localRepositories.length === 0) {
			if (projectId !== ALL_REPOSITORIES) setProjectId(ALL_REPOSITORIES);
			return;
		}
		if (projectId === ALL_REPOSITORIES && localRepositories.length === 1) {
			setProjectId(localRepositories[0].id);
			return;
		}
		if (
			projectId !== ALL_REPOSITORIES &&
			!localRepositories.some((project) => project.id === projectId)
		) {
			setProjectId(localRepositories[0].id);
		}
	}, [localRepositories, projectId]);

	const targets = useMemo(
		() =>
			projectId === ALL_REPOSITORIES
				? localRepositories
				: localRepositories.filter((project) => project.id === projectId),
		[localRepositories, projectId],
	);
	const queryScope = JSON.stringify([
		view,
		preset,
		projectId,
		debouncedQuery,
		targets.map((project) => [project.id, project.path]),
	]);
	const signature = `${queryScope}:${refreshRevision}`;

	const { payload: visiblePayload, busy } = useGitHubWorkspaceQuery(
		{ targets, view, preset, query: debouncedQuery },
		signature,
		revealed,
	);

	const singleRepository =
		projectId === ALL_REPOSITORIES
			? null
			: (visiblePayload?.repositories.find(
					(repository) => repository.projectId === projectId,
				) ?? null);
	const shownCount =
		view === "projects"
			? (visiblePayload?.projects.length ?? 0)
			: (visiblePayload?.workItems.length ?? 0);
	const { pagination, page, setPage } = useGitHubWorkspacePagination(
		queryScope,
		visiblePayload ? shownCount : null,
	);
	useEffect(() => {
		if (listScroll.current) listScroll.current.scrollTop = 0;
	}, [page, queryScope]);
	const changeQuery = (value: string) =>
		changeFilters({ type: "query", value });
	const changePreset = (value: GitHubWorkspacePreset) =>
		changeFilters({ type: "preset", value });
	const switchView = (value: GitHubWorkspaceView) =>
		changeFilters({ type: "view", value });

	const changeFilter = (field: GitHubFilterField, value: string) =>
		changeFilters({ type: "field", field, value });

	const openSelectedSurface = () => {
		if (!singleRepository) return;
		const url =
			view === "issues"
				? `${singleRepository.url}/issues`
				: view === "pullRequests"
					? `${singleRepository.url}/pulls`
					: githubProjectsWebUrl(singleRepository);
		void openExternalUrl(url);
	};

	const createOnGitHub = () => {
		if (!singleRepository) return;
		const url =
			view === "issues"
				? `${singleRepository.url}/issues/new`
				: view === "pullRequests"
					? `${singleRepository.url}/compare`
					: githubProjectsWebUrl(singleRepository, true);
		void openExternalUrl(url);
	};

	return (
		<div
				ref={surfaceRoot}
				data-pane-surface={mode === "pane" ? "own" : undefined}
			className={
				mode === "pane"
					? "flex h-full min-h-0 min-w-0 flex-col bg-surface-background text-foreground"
					: "flex min-h-0 min-w-0 flex-1 flex-col text-sidebar-foreground"
			}
		>
			{selectedIssue && (
				<GitHubIssueDetail
					key={`${selectedIssue.repository.projectId}:${selectedIssue.url}`}
					row={selectedIssue}
					agents={agents}
					activeSpaceId={activeSpaceId}
					onUpdated={updateIssue}
					onBack={() => {
						setSelectedIssue(null);
						queueMicrotask(() => {
							const target = selectionTrigger.current?.isConnected
								? selectionTrigger.current
								: listSurface.current?.querySelector<HTMLInputElement>(
										'input[type="search"]',
									);
							target?.focus({ preventScroll: true });
						});
					}}
				/>
			)}
			<div
				ref={listSurface}
				style={{ display: selectedIssue ? "none" : "contents" }}
			>
				{dense ? (
					<header className="shrink-0 border-b border-border/70 px-5 pt-5 pb-4">
						<div className="flex flex-wrap items-center gap-2.5">
							<Segmented
								value={view}
								onChange={switchView}
								options={viewOptions()}
								variant="chips"
								className="gap-1.5"
							/>
							<div className="min-w-48 max-w-72 flex-1">
								<SelectField
									aria-label={t("github.workspace.repository")}
									value={projectId}
									onValueChange={(nextValue) => setProjectId(nextValue)}
								>
									{localRepositories.length > 1 && (
										<SelectOption value={ALL_REPOSITORIES}>
											{t("github.workspace.allRepositories")}
										</SelectOption>
									)}
									{localRepositories.map((project) => (
										<SelectOption key={project.id} value={project.id}>
											{project.name}
										</SelectOption>
									))}
								</SelectField>
							</div>
							<IconButton
								title={t("github.workspace.openOnGitHub")}
								className="size-9 rounded-lg border border-border bg-background"
								disabled={!singleRepository}
								onClick={openSelectedSurface}
							>
								<ExternalLink />
							</IconButton>
						</div>

						<div className="mt-3 flex flex-wrap items-center gap-2.5">
							<Segmented
								value={preset}
								onChange={changePreset}
								options={presetsFor(view)}
								variant="pills"
								size="sm"
							/>
							<SearchField
								type="search"
								value={query}
								onChange={(event) => changeQuery(event.target.value)}
								onClear={() => changeQuery("")}
								loading={busy && query === debouncedQuery}
								placeholder={searchPlaceholder(view)}
								aria-label={t("github.workspace.search.label")}
								className="min-w-48 flex-1"
								inputClassName="h-9 rounded-lg"
							/>
							<GitHubFilters
								query={query}
								preset={preset}
								view={view}
								rows={visiblePayload?.workItems ?? []}
								onFilterChange={changeFilter}
								onPresetChange={changePreset}
							/>
							<div className="flex shrink-0 items-center gap-1.5">
								<Button
									type="button"
									variant="outline"
									size="icon-lg"
									aria-label={t("github.workspace.create")}
									title={t("github.workspace.create")}
									disabled={!singleRepository}
									onClick={createOnGitHub}
								>
									<Plus />
								</Button>
								<RefreshButton
									busy={busy}
									disabled={busy || targets.length === 0}
									className="size-9 rounded-lg border border-border bg-background"
									onClick={() => setRefreshRevision((current) => current + 1)}
								/>
							</div>
						</div>
					</header>
				) : (
					// The same band the File and Spaces tabs put under their title: 14px
					// above, 12px inset, 8px below, no rule — so the top of the sidebar
					// holds still when you switch tabs. It was 8px/6px with a border-b
					// under it, a strip no other tab draws (owner request 2026-09-10).
					<div className="shrink-0 space-y-1 px-3 pt-3.5 pb-2">
						<div
							role="toolbar"
							aria-label={t("github.workspace.toolbar.navigation")}
							className="flex min-w-0 items-center gap-1"
						>
							<Segmented
								value={view}
								onChange={switchView}
								options={viewOptions()}
								variant="pills"
								size="sm"
								iconOnly
								className="shrink-0"
							/>
							<div className="min-w-0 flex-1">
								{/* The sidebar toolbar is two rows; at 32px each it read heavy, so
								    the whole band sits at 28px — the small strip, the small select and
								    an h-7 search field (owner call 2026-09-10). The single-row tabs keep
								    their 32px search row. */}
								{/* The count retains its 1px optical alignment with the row icons. */}
								<SelectField
									aria-label={t("github.workspace.repository")}
									value={projectId}
									onValueChange={(nextValue) => setProjectId(nextValue)}
								>
									{localRepositories.length > 1 && (
										<SelectOption value={ALL_REPOSITORIES}>
											{t("github.workspace.allRepositories")}
										</SelectOption>
									)}
									{localRepositories.map((project) => (
										<SelectOption key={project.id} value={project.id}>
											{project.name}
										</SelectOption>
									))}
								</SelectField>
							</div>
							<output
								aria-live="polite"
								aria-label={t("github.workspace.resultCount", {
									count: shownCount,
								})}
								className="min-w-4 shrink-0 pt-px text-center font-mono text-meta tabular-nums text-muted-foreground"
							>
								{shownCount}
							</output>
							<IconButton
								title={t("github.workspace.openOnGitHub")}
								disabled={!singleRepository}
								onClick={openSelectedSurface}
							>
								<ExternalLink />
							</IconButton>
						</div>
						<div
							role="toolbar"
							aria-label={t("github.workspace.toolbar.query")}
							className="flex min-w-0 items-center gap-1"
						>
							<SearchField
								type="search"
								value={query}
								onChange={(event) => changeQuery(event.target.value)}
								onClear={() => changeQuery("")}
								loading={busy && query === debouncedQuery}
								placeholder={t("github.workspace.search.compact")}
								aria-label={t("github.workspace.search.label")}
								className="min-w-0 flex-1"
								// The sidebar's search field: 32px on SEARCH_FIELD_SURFACE at 13px,
								// as in the File and Spaces tabs (was 28px/11px on its own tint).
								inputClassName="h-7"
							/>
							<GitHubFilters
								query={query}
								preset={preset}
								view={view}
								rows={visiblePayload?.workItems ?? []}
								onFilterChange={changeFilter}
								onPresetChange={changePreset}
							/>
							<IconButton
								title={t("github.workspace.create")}
								disabled={!singleRepository}
								onClick={createOnGitHub}
							>
								<Plus />
							</IconButton>
							<RefreshButton
								busy={busy}
								disabled={busy || targets.length === 0}
								onClick={() => setRefreshRevision((current) => current + 1)}
							/>
						</div>
					</div>
				)}

				{visiblePayload && visiblePayload.errors.length > 0 && (
					<div
						className={
							dense
								? "shrink-0 space-y-1.5 border-b border-border/70 px-5 py-2.5"
								// Sidebar: outline bands at the pane inset, like a search field;
								// the bands carry their own edge, so no rule under the strip.
								: "shrink-0 space-y-1 px-3 py-2"
						}
					>
						{visiblePayload.errors.map((error, index) => {
							const key = `${error.repository ?? "github"}-${error.failure.kind}-${index}`;
							return error.failure.kind === "project-scope" ? (
								<Alert key={key} tone="warn" role="status" surface={dense ? "card" : "outline"}>
									{errorMessage(error)}
								</Alert>
							) : (
								<Alert key={key} role="alert" surface={dense ? "card" : "outline"}>
									{errorMessage(error)}
								</Alert>
							);
						})}
					</div>
				)}

				{/* Nothing yet: the loader sits centred where the rows will be, the one
				    loading state every empty screen shows (owner call 2026-09-10). */}
				{!visiblePayload && localRepositories.length > 0 ? (
					<LoadingStatus className="min-h-0 flex-1" />
				) : (
				<ScrollArea
					viewportRef={listScroll}
					type="hover"
					scrollHideDelay={0}
					revealOnSidebarHover={mode === "sidebar"}
					className="min-h-0 flex-1 overflow-hidden"
					// 8px before the first row in the sidebar, the gap the File and
					// Spaces tabs leave after their search band (owner request 2026-09-10).
					viewportClassName={cn(
						"[&>div]:block! [&>div]:min-w-0",
						!dense && "pt-2",
					)}
				>
					{localRepositories.length === 0 ? (
						<EmptyState
							title={t("github.workspace.empty.noRepositories")}
							description={t(
								"github.workspace.empty.noRepositoriesDescription",
							)}
							compact={!dense}
						/>
					) : !visiblePayload ? null : shownCount === 0 ? (
						<EmptyState
							title={t("github.workspace.empty.noResults")}
							description={t("github.workspace.empty.noResultsDescription")}
							compact={!dense}
						/>
					) : (
						<GitHubWorkspaceRows
							onSelect={selectWorkItem}
							openIssueKeys={openIssueKeys}
							form={dense ? "table" : "cards"}
							view={view}
							workItems={visiblePayload.workItems.slice(
								pagination.start,
								pagination.end,
							)}
							projects={visiblePayload.projects.slice(
								pagination.start,
								pagination.end,
							)}
							agents={agents}
							activeSpaceId={activeSpaceId}
						/>
					)}
				</ScrollArea>
				)}

				{visiblePayload && (shownCount > 0 || visiblePayload.limited) && (
					<GitHubPagination
						total={shownCount}
						page={pagination.page}
						disabled={busy || query !== debouncedQuery}
						compact={!dense}
						limited={visiblePayload.limited}
						onChange={setPage}
					/>
				)}
			</div>
		</div>
	);
}

/** This pane's own binding of the shared shape; everything about it lives in
 *  PaneEmptyState. */
function EmptyState({
	title,
	description,
	compact = false,
}: {
	title: string;
	description: string;
	compact?: boolean;
}) {
	return (
		<PaneEmptyState title={title} description={description} compact={compact} />
	);
}

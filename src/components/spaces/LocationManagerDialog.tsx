import { useEffect, useMemo, useRef, useState } from "react";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import {
	Folder,
	FolderGit2,
	GitBranch,
	Pin,
	Plus,
	Search,
	Server,
	Trash2,
} from "lucide-react";
import { EmptyHint } from "@/components/common/StatusBlocks";
import {
	AddRemoteProjectDialog,
	AddSshHostDialog,
} from "@/components/ssh/SshHostDialogs";
import { IconButton } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchField } from "@/components/ui/search-field";
import { listProviderConversations } from "@/lib/agents/providerConversationDiscovery";
import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import { useLocalProjectSearch } from "@/components/spaces/useLocalProjectSearch";
import { mergeProjectSearchResults } from "@/lib/spaces/localProjectSearch";
import { localFolderSuggestions } from "@/lib/spaces/localFolderSuggestions";
import { selectManagedLocations } from "@/lib/spaces/locationManagement";
import { openGitPanel } from "@/lib/workspace/dock/openScmPanel";
import { t } from "@/lib/i18n";
import {
	executeProjectRemoval,
	planProjectRemoval,
	type ProjectRemovalPlan,
} from "@/lib/agents/resourceLifecycle";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { cn } from "@/lib/utils";
import { useLocationAdd } from "@/components/spaces/useLocationAdd";
import { useLocationManagerDialogState } from "@/components/spaces/useLocationManagerDialogState";

export function LocationManagerDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const {
		projects,
		pinnedProjectIds,
		sshHosts,
		activeSpaceId,
		togglePin,
		moveProject,
	} = useLocationManagerDialogState();
	// Folder registration is shared with the pane header's add menu.
	const { addFolder: addSuggestedFolder, pickLocalFolder } = useLocationAdd();
	const [query, setQuery] = useState("");
	const [addingHost, setAddingHost] = useState(false);
	const [remoteHostId, setRemoteHostId] = useState<string | null>(null);
	const draggedId = useRef<string | null>(null);
	const [dragOverId, setDragOverId] = useState<string | null>(null);

	const locations = useMemo(
		() =>
			selectManagedLocations({
				projects,
				pinnedProjectIds,
				sshHosts,
				query,
			}),
		[projects, pinnedProjectIds, sshHosts, query],
	);

	// 이 컴퓨터의 provider 대화 기록만 훑어 "일해 온 폴더"를 뽑는다. SSH 호스트는
	// 넘기지 않는다 — 폴더를 고르려고 연 다이얼로그가 잠든 원격을 깨우느라
	// 멈추면 안 된다.
	const [scannedRecords, setScannedRecords] = useState<
		readonly ProviderConversationRecord[] | undefined
	>();
	// 한 번 읽은 결과는 다이얼로그를 닫아도 들고 있는다. 이 다이얼로그는 온보딩
	// 전용이 아니라 공용 위치 관리자라, SSH 호스트 하나 지우려고 열 때마다 모든
	// provider 기록 디렉토리를 다시 훑을 이유가 없다.
	const scannedOnce = useRef(false);
	useEffect(() => {
		if (!open || scannedOnce.current) return;
		scannedOnce.current = true;
		let disposed = false;
		void listProviderConversations()
			.then((records) => {
				if (!disposed) setScannedRecords(records);
			})
			.catch(() => {
				// 제안은 편의 기능이다 — 실패하면 다시 시도할 수 있게 표시를 되돌린다.
				if (!disposed) {
					scannedOnce.current = false;
					setScannedRecords([]);
				}
			});
		return () => {
			disposed = true;
		};
	}, [open]);

	const recentSuggestions = useMemo(
		() =>
			localFolderSuggestions({
				records: scannedRecords ?? [],
				// 같은 경로라도 원격 위치는 로컬 제안을 가리지 않는다.
				registeredPaths: projects
					.filter((project) => project.kind === "local")
					.map((project) => project.path),
				query,
				limit: query.trim() ? Number.POSITIVE_INFINITY : undefined,
			}),
		[scannedRecords, projects, query],
	);
	const search = useLocalProjectSearch(open, query);
	const suggestions = useMemo(
		() => mergeProjectSearchResults(
			recentSuggestions,
			search.results,
			projects.filter((project) => project.kind === "local").map((project) => project.path),
		),
		[recentSuggestions, search.results, projects],
	);
	const scanning = query.trim()
		? search.loading
		: open && scannedRecords === undefined;


	// 확인은 그 자리에서(SOUL §6, 2026-08-31): 네이티브 confirm 팝업 대신
	// 행이 인라인 확인 행으로 바뀐다. 살아있는 에이전트 수 경고는 질문에
	// 붙여 위험 정보를 잃지 않는다.
	const [confirmingRemoval, setConfirmingRemoval] =
		useState<ProjectRemovalPlan | null>(null);
	const [removalBusy, setRemovalBusy] = useState(false);
	const removalQuestion = (plan: ProjectRemovalPlan) => {
		const base = t("spaces.locations.removeConfirm", {
			name: plan.project?.name ?? plan.projectId,
		});
		return plan.agents.length > 0
			? `${base} ${t("spaces.locations.removeAgentsWarning", {
					n: plan.agents.length,
				})}`
			: base;
	};
	const executeRemoval = async (plan: ProjectRemovalPlan) => {
		setRemovalBusy(true);
		try {
			await executeProjectRemoval(plan);
		} catch (error) {
			await messageDialog(
				t("spaces.locations.removeKillFailed", {
					error: String(error),
				}),
				{ title: t("spaces.locations.removeFailed"), kind: "error" },
			);
		} finally {
			setConfirmingRemoval(null);
			setRemovalBusy(false);
		}
	};

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					onOpenChange(next);
					if (!next) setQuery("");
				}}
			>
				<DialogContent className="grid max-h-[min(42rem,calc(100vh-2rem))] grid-rows-[auto_auto_auto_minmax(0,1fr)] sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{t("spaces.locations.manage")}</DialogTitle>
						<DialogDescription>
							{t("spaces.locations.dialogDescription")}
						</DialogDescription>
					</DialogHeader>

					<div className="flex items-center gap-2">
						<SearchField
							className="min-w-0 flex-1"
							icon={
								<Search
									aria-hidden
									className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
								/>
							}
							autoFocus
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							inputClassName="h-8 pl-8 text-xs"
							placeholder={t("spaces.locations.searchPlaceholder")}
						/>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<IconButton title={t("spaces.locations.add")}>
									<Plus />
								</IconButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-52">
								<DropdownMenuItem onClick={() => void pickLocalFolder()}>
									<Folder className="size-4" /> {t("spaces.locations.openLocalFolder")}
								</DropdownMenuItem>
								{sshHosts.map((host) => (
									<DropdownMenuItem
										key={host.id}
										onClick={() => {
											onOpenChange(false);
											setRemoteHostId(host.id);
										}}
									>
										<Server className="size-4" />
										{t("spaces.locations.openFromHost", { name: host.name })}
									</DropdownMenuItem>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={() => {
										onOpenChange(false);
										setAddingHost(true);
									}}
								>
									<Plus className="size-4" /> {t("spaces.locations.addSshHost")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					<p role={search.error ? "status" : undefined} className="text-xs text-muted-foreground">
						{t(search.error
							? "spaces.locations.searchComputerFailed"
							: "spaces.locations.searchComputerHint")}
					</p>
					<div className="min-h-0 overflow-y-auto rounded-md border border-border">
						{locations.length === 0 &&
							suggestions.length === 0 &&
							!scanning &&
							!search.error && (
								<EmptyHint className="px-4 py-8">
									{query.trim()
										? t("spaces.locations.noMatches")
										: t("spaces.locations.emptyList")}
								</EmptyHint>
							)}
						{locations.map(({ project, hostName, pinned }) => (
							<div
								key={project.id}
								data-location-id={project.id}
								className={cn(
									"group flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0 hover:bg-glass-tint-hover",
									dragOverId === project.id && "border-t-2 border-t-primary",
								)}
								draggable
								onDragStart={(event) => {
									draggedId.current = project.id;
									event.dataTransfer.effectAllowed = "move";
								}}
								onDragEnd={() => {
									draggedId.current = null;
									setDragOverId(null);
								}}
								onDragOver={(event) => {
									if (!draggedId.current || draggedId.current === project.id)
										return;
									event.preventDefault();
									setDragOverId(project.id);
								}}
								onDragLeave={() =>
									setDragOverId((current) =>
										current === project.id ? null : current,
									)
								}
								onDrop={(event) => {
									if (!draggedId.current || draggedId.current === project.id)
										return;
									event.preventDefault();
									moveProject(draggedId.current, project.id);
									draggedId.current = null;
									setDragOverId(null);
								}}
							>
								{confirmingRemoval?.projectId === project.id ? (
									<InlineConfirmRow
										className="-mx-2 flex-1"
										question={removalQuestion(confirmingRemoval)}
										confirmLabel={t("spaces.locations.remove")}
										busy={removalBusy}
										onConfirm={() => void executeRemoval(confirmingRemoval)}
										onCancel={() => setConfirmingRemoval(null)}
									/>
								) : (
									<>
								<span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
									{project.isRepo ? <FolderGit2 /> : <Folder />}
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="truncate text-xs font-medium">
											{project.name}
										</span>
										{hostName && (
											<Badge
												variant="outline"
												className="h-4 shrink-0 px-1 text-[9px]"
											>
												{hostName}
											</Badge>
										)}
										{pinned && (
											<Pin className="size-3 shrink-0 fill-current text-status-warn" />
										)}
									</span>
									<span className="block truncate font-mono text-meta text-muted-foreground">
										{project.path}
									</span>
								</span>
								<span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity [.group:focus-within_:where(&)]:opacity-100 group-hover:opacity-100">
									{project.isRepo && (
										<IconButton
											title="Git (pull·push·commit·PR)"
											onClick={() =>
												openGitPanel(activeSpaceId, project.id, project.name)
											}
										>
											<GitBranch />
										</IconButton>
									)}
									<IconButton
										title={pinned ? t("spaces.locations.unpin") : t("spaces.locations.pinToTop")}
										className={cn(pinned && "text-status-warn")}
										onClick={() => togglePin(project.id)}
									>
										<Pin className={cn(pinned && "fill-current")} />
									</IconButton>
									<IconButton
										title={t("spaces.locations.remove")}
										className="hover:text-destructive"
										onClick={() =>
											setConfirmingRemoval(planProjectRemoval(project.id))
										}
									>
										<Trash2 />
									</IconButton>
								</span>
									</>
								)}
							</div>
						))}

						{(scanning || suggestions.length > 0) && (
							<div data-location-suggestions>
								<p className="sticky top-0 z-10 border-b border-border/60 bg-background px-3 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
									{scanning
										? t(query.trim() ? "spaces.locations.searchingComputer" : "spaces.locations.recentProjectsLoading")
										: t(query.trim() ? "spaces.locations.computerResults" : "spaces.locations.recentProjects")}
								</p>
								{suggestions.map((suggestion) => (
									<button
										key={suggestion.path}
										type="button"
										data-location-suggestion={suggestion.path}
										className="group flex w-full min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-left last:border-b-0 hover:bg-glass-tint-hover"
										onClick={() => void addSuggestedFolder(suggestion.path)}
									>
										{suggestion.isRepo
											? <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
											: <Folder className="size-3.5 shrink-0 text-muted-foreground" />}
										<span className="min-w-0 flex-1">
											<span className="block truncate text-xs text-foreground">
												{suggestion.name}
											</span>
											<span className="block truncate font-mono text-meta text-muted-foreground">
												{suggestion.path}
											</span>
										</span>
										{suggestion.sessionCount > 0 && (
											<span className="shrink-0 text-meta text-muted-foreground">
												{t("spaces.locations.sessionCount", { n: suggestion.sessionCount })}
											</span>
										)}
										<Plus className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
									</button>
								))}
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>

			{addingHost && (
				<AddSshHostDialog
					onClose={() => {
						setAddingHost(false);
						onOpenChange(true);
					}}
				/>
			)}
			{remoteHostId && (
				<AddRemoteProjectDialog
					hostId={remoteHostId}
					onClose={() => {
						setRemoteHostId(null);
						onOpenChange(true);
					}}
				/>
			)}
		</>
	);
}

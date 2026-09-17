// 빈 데스크탑의 첫 화면 (hebbian-frontend-2y6tb).
//
// Empty-state actions remain usable without a detected provider.
// Space는 디렉토리에 묶여 있지 않으므로
// 상단 칩이 실행 위치를 한 번 정한다 — 바인딩이 아니라 바꿀 수 있는 선택.
// 터미널 행은 정확히 그 폴더에서 열리고, provider 행은 그 폴더가 속한
// 프로젝트 checkout에서 실행된다(저장소 quick-add와 같은 권위 —
// canonicalLocalProjectPath가 primary worktree로 정규화한다). 이 표면은 그
// 결정을 재해석하지 않고 넘겨줄 뿐이다.
//
// provider 감지는 확률적 표현을 쓴다 — installedAgents가 비어 있는 것은
// "설치 안 됨"의 증명이 아니라 "아직 감지 전"일 수도 있다(App 기동 프로브가
// 비동기). 그래서 "감지되지 않았다"라고만 말하고 단정하지 않는다.
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { SelectButton } from "@/components/ui/select";
import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PaneLaunchChoices } from "@/components/workspace/PaneLaunchChoices";
import { WorktreeAgentDialog } from "@/components/agents/WorktreeAgentDialog";
import {
	type RepositoryAddAgentDialogTarget,
	useRepositoryQuickAdd,
} from "@/components/spaces/useRepositoryQuickAdd";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { usePaneLaunchState } from "@/components/workspace/usePaneLaunchState";
import { listProviderConversations } from "@/lib/agents/providerConversationDiscovery";
import { pathBasename } from "@/lib/files/paths";
import { t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import {
	type LocalFolderSuggestion,
	localFolderSuggestions,
} from "@/lib/spaces/localFolderSuggestions";
import { openLocalTerminalPanel } from "@/lib/workspace/dock";
import {
	agentLaunchPlan,
	defaultLaunchDirectory,
	displayLaunchPath,
	type LaunchDirectory,
	terminalLaunchPlan,
} from "@/lib/workspace/emptySpaceLauncher";
import { useStore } from "@/store";
import type { Provider } from "@/types";

export function DesktopWatermark() {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const { rows, installed } = usePaneLaunchState();
	const projects = useStore((s) => s.projects);
	const spaceName = useStore(
		(s) => s.spaces.find((space) => space.id === desktopId)?.name ?? "",
	);

	// Resolved once per mount — a chip that flips while the user reads it is
	// unpredictable, so later focus changes do not re-enter the default.
	const [directory, setDirectory] = useState<LaunchDirectory>(() =>
		defaultLaunchDirectory({
			focusCtx: useStore.getState().focusCtx,
			projects: useStore.getState().projects,
		}),
	);
	const [home, setHome] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		void homeDir()
			.then((value) => {
				if (live) setHome(value);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	// null = not asked yet. Loaded on first menu open, never on mount — the
	// provider-record scan is menu content, not empty-screen content.
	const [suggestions, setSuggestions] = useState<
		LocalFolderSuggestion[] | null
	>(null);
	const suggestionsRequested = useRef(false);
	const loadSuggestions = () => {
		if (suggestionsRequested.current) return;
		suggestionsRequested.current = true;
		listProviderConversations()
			.then((records) =>
				setSuggestions(
					localFolderSuggestions({
						records,
						registeredPaths: useStore
							.getState()
							.projects.map((project) => project.path),
						limit: 8,
					}),
				),
			)
			.catch(() => setSuggestions([]));
	};

	const [dialog, setDialog] = useState<Omit<
		RepositoryAddAgentDialogTarget,
		"desktopId"
	> | null>(null);
	const quickAdd = useRepositoryQuickAdd(({ desktopId: _ignored, ...target }) =>
		setDialog(target),
	);

	const openTerminal = () => {
		if (!desktopId) return;
		const plan = terminalLaunchPlan(directory);
		if (plan.kind === "terminal" && plan.cwd) {
			quickAdd.onAddRepositoryTerminal(desktopId, {
				label: pathBasename(plan.cwd),
				path: plan.cwd,
			});
			return;
		}
		openLocalTerminalPanel(desktopId);
	};

	const openAgent = (provider: Provider) => {
		if (!desktopId) return;
		const plan = agentLaunchPlan(provider, directory, home);
		if (plan.kind === "agent-quick") {
			void quickAdd.onAddRepositoryAgent(
				desktopId,
				{ label: pathBasename(plan.path), path: plan.path },
				provider,
			);
			return;
		}
		setDialog({ initialProvider: provider });
	};

	const browseFolder = async () => {
		const picked = await openFolderDialog({
			directory: true,
			defaultPath: directory.path ?? undefined,
		}).catch(() => null);
		if (typeof picked === "string" && picked) {
			setDirectory({ path: picked, source: "chosen" });
		}
	};

	const localProjects = projects.filter((project) => project.kind === "local");

	return (
		// The empty desktop is a pane too: it paints glass/pane at the surface alpha
		// like a dockview group would, so the launcher sits on the same card floor
		// a terminal does instead of on bare shell glass with only the card ring
		// around it (owner request 2026-09-10).
		<div className="flex h-full flex-col items-center justify-center bg-surface-pane text-muted-foreground">
			<div className="flex max-h-full w-full max-w-md flex-col items-center gap-1 overflow-y-auto px-6 py-4">
				{spaceName && (
					<p className="text-sm font-medium text-foreground/90">{spaceName}</p>
				)}
				<DropdownMenu
					onOpenChange={(open) => {
						if (open) loadSuggestions();
					}}
				>
					<DropdownMenuTrigger asChild>
						<SelectButton
							aria-label={t("common.location")}
							className="w-80 max-w-full"
						>
							<FolderOpen className="size-3.5 shrink-0" />
							<span data-slot="select-value" className="font-mono">
								{directory.path
									? displayLaunchPath(directory.path, home)
									: t("agents.location.home")}
							</span>
						</SelectButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
						{localProjects.map((project) => (
							<DropdownMenuItem
								key={project.id}
								onSelect={() =>
									setDirectory({ path: project.path, source: "chosen" })
								}
							>
								<span className="truncate text-xs">{project.name}</span>
								<span className="ml-auto truncate pl-3 font-mono text-[11px] opacity-60">
									{displayLaunchPath(project.path, home)}
								</span>
							</DropdownMenuItem>
						))}
						{suggestions === null && (
							<DropdownMenuLabel className="text-xs font-normal opacity-60">
								{t("spaces.locations.recentProjectsLoading")}
							</DropdownMenuLabel>
						)}
						{suggestions !== null && suggestions.length > 0 && (
							<>
								{localProjects.length > 0 && <DropdownMenuSeparator />}
								<DropdownMenuLabel className="text-xs">
									{t("agents.location.recent")}
								</DropdownMenuLabel>
								{suggestions.map((suggestion) => (
									<DropdownMenuItem
										key={suggestion.path}
										onSelect={() =>
											setDirectory({ path: suggestion.path, source: "chosen" })
										}
									>
										<span className="truncate text-xs">{suggestion.name}</span>
										<span className="ml-auto truncate pl-3 font-mono text-[11px] opacity-60">
											{displayLaunchPath(suggestion.path, home)}
										</span>
									</DropdownMenuItem>
								))}
							</>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => void browseFolder()}>
							<span className="text-xs">
								{t("agents.location.chooseAnotherFolder")}
							</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>

				<PaneLaunchChoices
					rows={rows}
					onTerminal={openTerminal}
					onAgent={openAgent}
				/>

				{installed.length === 0 && (
					<p className="mt-2 text-xs opacity-60">
						{t("workspace.watermark.noAgentCli")}
					</p>
				)}
				<button
					type="button"
					className="mt-1 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-foreground"
					onClick={() => setDialog({})}
				>
					{t("spaces.repository.addWithOptions")}
				</button>
			</div>
			{desktopId && dialog && (
				<WorktreeAgentDialog
					desktopId={desktopId}
					host={dialog.host}
					// The dialog registers initialPath as a project the moment it
					// mounts, so only a location somebody owns may prefill: one the
					// user picked in the chip menu, or one already in the registry.
					// A focus-derived default stays out — cancelling the dialog must
					// not leave a phantom project behind.
					initialPath={
						dialog.initialPath ??
						(directory.source === "chosen" || directory.source === "project"
							? (directory.path ?? undefined)
							: undefined)
					}
					initialProvider={dialog.initialProvider}
					onClose={() => setDialog(null)}
				/>
			)}
		</div>
	);
}

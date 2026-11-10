import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Bot, File, FolderGit2, History, Search, TerminalSquare, Waypoints } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { Kbd, ShortcutKeys } from "@/components/ui/kbd";
import { Titled } from "@/components/ui/tooltip";
import {
	type ComponentType,
	type SVGProps,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	openAgentPanelOnDesktop,
	openSshTerminalPanelOnDesktop,
	openTerminalPanelOnDesktop,
} from "@/lib/workspace/dock";
import { openGitPanel } from "@/lib/workspace/dock/openScmPanel";
import { openFileViewer } from "@/lib/files/fileViewerPane";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { t } from "@/lib/i18n";
import {
	type NativeSearchItem,
	type NativeSearchKind,
	type NativeSearchStatus,
	parseNativeSearchQuery,
	rankNativeSearchItems,
} from "@/lib/search/nativeSearch";
import {
	buildNativeSearchCatalog,
	type NativeSearchPanelSnapshot,
	nativeSearchFileContexts,
} from "@/lib/search/nativeSearchCatalog";
import {
	type NativeSearchCommandContext,
	type NativeSearchSourceExecutor,
	searchNativeCommandHistory,
	searchNativeFiles,
} from "@/lib/search/nativeSearchSources";
import { appCommandSearchItems } from "@/lib/search/nativeSearchAppCommands";
import {
	readAppCommandContext,
	runAppCommand,
} from "@/lib/commands/appCommandRunner";
import type {
	AppCommandContext,
	AppCommandRequest,
} from "@/lib/commands/appCommands";
import { chordToLabels, shortcutChord } from "@/lib/settings/shortcutBindings";
import { runWorkspaceCommand } from "@/lib/workspace/workspaceCommand";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

type SearchIcon = ComponentType<SVGProps<SVGSVGElement>>;

const KIND_ICONS: Record<NativeSearchKind, SearchIcon> = {
	agent: Bot,
	session: TerminalSquare,
	worktree: Waypoints,
	file: File,
	command: History,
	repository: FolderGit2,
};

function kindLabel(kind: NativeSearchKind): string {
	if (kind === "agent") return t("common.agent");
	// "세션" 키는 세션 패널(탭·헤더)이 복수형 번역으로 쓴다 — 단일 결과 배지는
	// 단수 맥락이라 별도 키(승격 리뷰 발견 #12).
	if (kind === "session") return t("search.kind.session");
	if (kind === "worktree") return t("common.worktree");
	if (kind === "file") return t("common.file");
	if (kind === "command") return t("search.kind.command");
	return t("search.kind.repository");
}

function statusLabel(status: NativeSearchStatus): string {
	if (status === "working") return t("common.working");
	if (status === "waiting") return t("common.waiting");
	if (status === "done") return t("common.done");
	if (status === "connecting") return t("common.connecting");
	if (status === "blocked") return t("common.confirmationRequired");
	if (status === "connected") return t("common.connected");
	return t("common.exited");
}

function statusClass(status: NativeSearchStatus): string {
	if (status === "working" || status === "connected") return "bg-status-run";
	if (status === "done") return "bg-status-done";
	if (status === "blocked") return "bg-status-blocked";
	if (status === "waiting" || status === "connecting") return "bg-status-warn";
	return "bg-muted-foreground/45";
}

function snapshotLivePanels(): NativeSearchPanelSnapshot[] {
	return mountedDockviewEntries().flatMap(([desktopId, api]) =>
		api.panels.map((panel) => ({
			desktopId,
			...dockPanelReference(panel),
		})),
	);
}

/** Nothing applies while closed; the facts are read when the palette opens. */
const NO_APP_COMMAND_CONTEXT: AppCommandContext = {
	spaces: [],
	activeSpaceId: "",
	hasActivePane: false,
	canBalancePanes: false,
	canUndoPaneMove: false,
	hasNextUp: false,
	devBuild: false,
	proInterface: false,
};

export interface NativeSearchDialogRequest {
	revision: number;
	initialQuery: string;
}

export function NativeSearchDialog({
	request,
}: {
	request?: NativeSearchDialogRequest;
}) {
	const state = useStore(
		useShallow((current) => ({
			activeSpaceId: current.activeSpaceId,
			spaces: current.spaces,
			layouts: current.layouts,
			projects: current.projects,
			agents: current.agents,
			detected: current.detected,
			sshHosts: current.sshHosts,
			agentActivity: current.agentActivity,
			sessionAgentRuntimeState: current.sessionAgentRuntimeState,
			sessionCwd: current.sessionCwd,
			sessionAgent: current.sessionAgent,
			sessionAgentPin: current.sessionAgentPin,
			sessionTitle: current.sessionTitle,
			sessionActivity: current.sessionActivity,
			sshStates: current.sshStates,
		})),
	);
	const shortcutOverrides = useStore((current) => current.shortcutOverrides);
	const agentDisplayStates = useAgentAttention(
		(current) => current.displayStates,
	);
	const [open, setOpen] = useState(Boolean(request));
	const [query, setQuery] = useState(request?.initialQuery ?? "");
	const [asyncItems, setAsyncItems] = useState<NativeSearchItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const searchSequence = useRef(0);
	const selectedElement = useRef<HTMLButtonElement | null>(null);

	// An app command runs only once this palette is fully gone. Feedback
	// screenshots the window, so a capture during the close fade would photograph
	// the palette; focus moves and other dialogs would race its focus scope.
	// Rather than guess at a delay, the command waits for onCloseAutoFocus below,
	// Radix's own signal that the close animation and unmount have finished.
	const pendingAppCommand = useRef<AppCommandRequest | null>(null);

	useEffect(() => {
		if (!request) return;
		setQuery(request.initialQuery);
		setAsyncItems([]);
		setSelectedIndex(0);
		// Opening clears the pending command as well as closing does. Radix
		// skips onCloseAutoFocus entirely when a reopen cancels the unmount
		// mid-animation, and the command would then outlive the request that
		// set it and fire on some later, unrelated close, which a command the
		// user no longer asked for must never do. The command belongs to one
		// palette session; this is where a session begins.
		pendingAppCommand.current = null;
		setOpen(true);
	}, [request]);

	const catalog = useMemo(
		() => [
			...appCommandSearchItems(
				open ? readAppCommandContext() : NO_APP_COMMAND_CONTEXT,
				shortcutOverrides,
			),
			...buildNativeSearchCatalog({
				...state,
				agentDisplayStates,
				livePanels: open ? snapshotLivePanels() : [],
			}),
		],
		[agentDisplayStates, open, shortcutOverrides, state],
	);
	const fileContexts = useMemo(
		() => nativeSearchFileContexts(state),
		[state.projects, state.agents, state.detected],
	);
	const commandContexts = useMemo<NativeSearchCommandContext[]>(
		() => [
			{ id: "local", label: t("search.history.local"), source: "local" },
			...state.sshHosts.map((host) => ({
				id: `ssh:${host.id}`,
				label: t("search.history.host", { name: host.name }),
				source: "ssh" as const,
				hostId: host.id,
			})),
		],
		[state.sshHosts],
	);

	useEffect(() => {
		const parsed = parseNativeSearchQuery(query);
		if (!open || parsed.text.length < 2) {
			searchSequence.current += 1;
			setAsyncItems([]);
			setLoading(false);
			return;
		}

		const sequence = ++searchSequence.current;
		setAsyncItems([]);
		setLoading(true);
		const timer = setTimeout(() => {
			const executor: NativeSearchSourceExecutor = {
				local: (command) => runWorkspaceCommand({ source: "local" }, command),
				ssh: (hostId, command) => runWorkspaceCommand({ source: "ssh", hostId }, command),
			};
			const fileSearch = parsed.kinds.has("file")
				? searchNativeFiles(fileContexts, parsed.text, executor)
				: Promise.resolve([]);
			const historySearch = parsed.kinds.has("command")
				? searchNativeCommandHistory(commandContexts, parsed.text, executor)
				: Promise.resolve([]);
			void Promise.all([fileSearch, historySearch]).then(
				([files, commands]) => {
					if (sequence !== searchSequence.current) return;
					setAsyncItems([...files, ...commands]);
					setLoading(false);
				},
			);
		}, 180);
		return () => clearTimeout(timer);
	}, [commandContexts, fileContexts, open, query]);

	const results = useMemo(
		() => rankNativeSearchItems([...catalog, ...asyncItems], query),
		[asyncItems, catalog, query],
	);

	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);
	useEffect(() => {
		setSelectedIndex((current) =>
			Math.min(current, Math.max(0, results.length - 1)),
		);
	}, [results.length]);
	useEffect(() => {
		selectedElement.current?.scrollIntoView?.({ block: "nearest" });
	}, [selectedIndex]);

	const execute = useCallback(async (item: NativeSearchItem) => {
		const action = item.action;
		if (action.type === "unavailable") return;
		setOpen(false);
		const current = useStore.getState();
		if (action.type === "focus-panel") {
			navigateToPanel(action.desktopId, action.panelId);
			return;
		}
		if (action.type === "open-agent") {
			const agent = current.agents.find(
				(candidate) => candidate.id === action.agentId,
			);
			if (agent) openAgentPanelOnDesktop(action.desktopId, agent);
			return;
		}
		if (action.type === "open-worktree") {
			if (action.source === "local") {
				openTerminalPanelOnDesktop(current.activeSpaceId, action.path);
				return;
			}
			const host = current.sshHosts.find(
				(candidate) => candidate.id === action.hostId,
			);
			if (host) {
				openSshTerminalPanelOnDesktop(
					current.activeSpaceId,
					host.id,
					host.name,
					action.path,
				);
			}
			return;
		}
		if (action.type === "open-file") {
			openFileViewer(current.activeSpaceId, action);
			return;
		}
		if (action.type === "open-repository") {
			openGitPanel(current.activeSpaceId, action.projectId, action.name);
			return;
		}
		if (action.type === "copy-command") {
			await writeText(action.command);
			showToast(t("common.copiedToClipboard"));
			return;
		}
		pendingAppCommand.current = action;
	}, []);

	const moveSelection = (delta: number) => {
		if (results.length === 0) return;
		setSelectedIndex(
			(current) => (current + delta + results.length) % results.length,
		);
	};

	const parsedQuery = parseNativeSearchQuery(query);
	const paletteChord = shortcutChord("native-search", shortcutOverrides);
	const selectedAction = results[selectedIndex]?.action.type;
	const selectedCopies = selectedAction === "copy-command";
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				showCloseButton={false}
				// Radix calls this once this content has actually finished
				// unmounting — its internal Presence tracks the real
				// `animationend`/`animationcancel` events from the `animate-out`
				// class in dialog.tsx's className, so this fires exactly when the
				// close fade is done, whatever its duration is, rather than a
				// frame or timer count this file would have to keep in sync with
				// that CSS by hand. Default focus-return behavior is untouched —
				// this only piggybacks a side effect on the same signal.
				onCloseAutoFocus={() => {
					const command = pendingAppCommand.current;
					pendingAppCommand.current = null;
					if (command) runAppCommand(command);
				}}
				className="top-[18%] max-h-[min(680px,72vh)] w-[min(720px,calc(100vw-32px))] max-w-none translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-none"
			>
				<DialogTitle className="sr-only">{t("common.unifiedSearch")}</DialogTitle>
				<DialogDescription className="sr-only">
					{t("search.dialog.placeholder")}
				</DialogDescription>
				<div className="flex h-12 items-center gap-3 border-b border-border/70 px-4">
					{loading ? (
						<DureLoader size={16} className="shrink-0 text-muted-foreground" />
					) : (
						<Search className="size-4 shrink-0 text-muted-foreground" />
					)}
					<input
						autoFocus
						role="combobox"
						aria-expanded="true"
						aria-controls="native-search-results"
						aria-activedescendant={
							results[selectedIndex]
								? `native-search-result-${selectedIndex}`
								: undefined
						}
						className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
						placeholder={t("search.dialog.placeholder")}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (event.key === "ArrowDown") {
								event.preventDefault();
								moveSelection(1);
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								moveSelection(-1);
							} else if (event.key === "Enter" && results[selectedIndex]) {
								event.preventDefault();
								void execute(results[selectedIndex]);
							} else if (event.key === "Escape") {
								setOpen(false);
							}
						}}
					/>
					{paletteChord && (
						<Kbd size="sm">{chordToLabels(paletteChord).join("")}</Kbd>
					)}
				</div>

				<div
					id="native-search-results"
					role="listbox"
					className="min-h-0 flex-1 overflow-y-auto py-2"
				>
					{results.map((item, index) => {
						const Icon = KIND_ICONS[item.kind];
						const selected = index === selectedIndex;
						const unavailable = item.action.type === "unavailable";
						return (
							<button
								ref={selected ? selectedElement : undefined}
								id={`native-search-result-${index}`}
								key={item.id}
								type="button"
								role="option"
								aria-selected={selected}
								aria-disabled={unavailable || undefined}
								className={cn(
									"flex h-11 w-full min-w-0 items-center gap-3 px-4 text-left",
									selected
										? "bg-accent text-accent-foreground"
										: "hover:bg-accent/60",
									unavailable && "text-muted-foreground",
								)}
								onMouseMove={() => setSelectedIndex(index)}
								onClick={() => void execute(item)}
							>
								<Icon className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm">{item.title}</span>
									{item.detail && (
										<span className="block truncate text-[11px] text-muted-foreground">
											{item.detail}
										</span>
									)}
								</span>
								{item.status && (
									<Titled title={statusLabel(item.status)}>
										<span
											className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground"
										>
											<span
												className={cn(
													"size-1.5 rounded-full",
													statusClass(item.status),
												)}
											/>
											{statusLabel(item.status)}
										</span>
									</Titled>
								)}
								{item.shortcut && (
									<span className="flex shrink-0 items-center gap-1">
										<ShortcutKeys keys={item.shortcut} size="sm" />
									</span>
								)}
								<span className="w-16 shrink-0 text-right text-[10px] text-muted-foreground">
									{kindLabel(item.kind)}
								</span>
							</button>
						);
					})}
					{results.length === 0 && (
						<div className="flex h-28 items-center justify-center text-xs text-muted-foreground">
							{loading
								? t("common.searching")
								: parsedQuery.text.length > 0 && parsedQuery.text.length < 2
									? t("search.dialog.minChars")
									: t("search.results.empty")}
						</div>
					)}
				</div>

				<div className="flex h-8 items-center justify-between border-t border-border/70 px-4 text-[10px] text-muted-foreground">
					<div className="flex gap-3">
						<span>
							@ {t("common.agent")}·{t("common.session")}
						</span>
						<span>/ {t("common.file")}</span>
						<span>&gt; {t("search.kind.command")}</span>
						<span>
							# {t("common.worktree")}·{t("search.kind.repository")}
						</span>
					</div>
					<div className="flex gap-3">
						<span>↑↓ {t("search.footer.navigate")}</span>
						{selectedAction !== "unavailable" && (
							<span>Enter {selectedCopies ? t("common.copy") : t("common.open")}</span>
						)}
						<span>Esc {t("common.close")}</span>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

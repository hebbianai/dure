import {
	Download,
	Folder,
	GitBranch,
	History,
	LayoutGrid,
	Plug,
	Settings,
	Workflow,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { PluginMark } from "@/components/plugins/PluginMark";
import { usePluginPermissionWorkspace } from "@/components/plugins/usePluginPermissionWorkspace";
import { SshRailIcon } from "@/components/sidebar/RailIcons";
import { Titled, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { resolveLang, t } from "@/lib/i18n";
import {
	useBasicFoldedRailTabs,
	useEffectiveSidebarTab,
} from "@/components/workspace/useInterfaceMode";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { countAttentionDisplayStates } from "@/lib/spaces/spacesStateFilter";
import {
	pluginLocalizedText,
	type DurePluginViewContainer,
} from "@/lib/plugins/durePlugins";
import { pluginSidebarContainerKey } from "@/lib/plugins/pluginSidebarSelection";
import { isIssueTrackerPermissionEnabled } from "@/lib/plugins/issueTrackerClaimConfiguration";
import { pluginWorkspaceContext } from "@/lib/plugins/pluginWorkspace";
import {
	RAIL_ICON_SIZE,
	RAIL_ITEM_BASE,
	railItemSurface,
} from "@/lib/sidebar/railTone";
import { cn } from "@/lib/utils";
import {
	dismissUpdateNotice,
	resurfaceUpdateNotices,
} from "@/lib/updates/updateNotice";
import { useUpdateNoticeSnapshot } from "@/lib/updates/useUpdateNoticeSnapshot";
import { SIDEBAR_RAIL_WIDTH } from "@/lib/sidebar/windowSidebarState";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";

/** 왼쪽 아이콘 레일 — 항상 고정. 아이콘 클릭으로 오른쪽 패널 내용을 전환하고,
 *  이미 활성인 아이콘을 다시 클릭하면 패널을 접는다 (VS Code 액티비티 바).
 *
 *  Sidebar.tsx에서 떼어낸 것이다. 리디자인이 손대는 표면(활성 칩·호버 틴트·
 *  사이드바와의 헤어라인)이 전부 여기 모여 있는데, 그걸 950줄짜리 god-file
 *  안에서 고치면 다음 사람이 또 그 파일에서 충돌한다. 동작은 그대로다. */
// 글리프는 시안 2386:41102가 정한다. 스페이스만 시안(Bot)과 다르다 —
// LayoutGrid다(소유자 결정 2026-09-04, 시안 갱신 대상).
//
// Bot은 이 패널이 '에이전트 목록'이던 시절의 글리프다. 그 뒤 패널이 저장소
// 중심으로 재편되면서(등록된 저장소 전량 나열·핀 밴드·위치/환경별 그룹핑·
// 런타임 패싯) 지금은 "작업이 벌어지는 장소들"을 담는다. LayoutGrid가 그
// 의미고, 16px에서 획이 적어 레일의 나머지 글리프와 밀도가 맞는다.
// 한때 여기 있던 SquareStack으로 되돌리지 말 것 — 그건 시안과 어긋나 있던
// 값이지 대안으로 검토된 값이 아니다.
//
// Puzzle은 여전히 금지다: 플러그인 컨테이너 버튼이 쓰고 있어 라벨 없는
// 레일에서 같은 글리프가 둘이 된다. 구분선 아래는 시안도 Plug이므로 그대로 둔다 — Puzzle은 시안에서
// 구분선 *위* 묶음에 있는 다른 항목이고, 여기에 쓰면 puzzle 아이콘을 고른
// 플러그인 컨테이너 버튼과 나란히 같은 글리프가 두 개 생긴다(레일은 라벨이
// 없어 툴팁 말고는 구분할 방법이 없다).
// 순서는 시안(Bot·Folder·Github·Puzzle·터미널)과 다르게 현재 배치를 지킨다 —
// 매일 쓰는 내비게이션이라 아이콘이 바뀌는 것과 자리가 바뀌는 것은 비용이 다르다.
// Labels are thunks so t() resolves at render time — a module-scope t() call
// would freeze the boot language.
const RAIL_TABS = [
	{ id: "spaces", icon: LayoutGrid, label: () => t("common.space") },
	// id는 영속 키라 "recovery" 유지 — 라벨만 "세션" 패널로 승격(2026-08-01)
	{ id: "recovery", icon: History, label: () => t("common.session") },
	{ id: "files", icon: Folder, label: () => t("common.file") },
	{ id: "ssh", icon: SshRailIcon, label: () => "SSH" },
	// The branch, not the octocat: this panel is the app's own git (worktrees,
	// branches, commits). The GitHub mark means the GitHub service and stays
	// with GitHub-specific surfaces — the add-agent Github tab today, the
	// GitHub plugin next (owner decision 2026-09-03). The id stays "github":
	// it is a persisted sidebar key.
	{ id: "github", icon: GitBranch, label: () => t("common.sourceControl") },
	{ id: "automations", icon: Workflow, label: () => t("automations.title") },
] as const;

function PluginRailItem({
	pluginId,
	children,
}: {
	pluginId: string;
	children: ReactNode;
}) {
	// GitHub is a permanent navigation entry; visibility grants no access.
	const alwaysVisible = pluginId === "dure.github";
	const focus = useStore((state) => state.focusCtx);
	const projects = useStore((state) => state.projects);
	const workspace = useMemo(
		() => pluginWorkspaceContext(focus, projects),
		[focus, projects],
	);
	const { permission } = usePluginPermissionWorkspace(
		!alwaysVisible && workspace?.source === "local"
			? { pluginId, workspaceRoot: workspace.root }
			: null,
	);
	// A bundled contribution is available to enable, not implicitly enabled.
	// Reuse the same native receipt as settings and tracker reads.
	return alwaysVisible || isIssueTrackerPermissionEnabled(permission)
		? children
		: null;
}

/** What a click on the item you are already on will do. */
function railToggleHint(sidebarOpen: boolean): string {
	return sidebarOpen
		? t("sidebar.rail.hideSidebar")
		: t("sidebar.rail.showSidebar");
}

export function ActivityRail({
	onOpenSettings,
	pluginContainers = [],
	activePluginContainerKey = null,
	onOpenPluginContainer,
}: {
	onOpenSettings: () => void;
	pluginContainers?: DurePluginViewContainer[];
	activePluginContainerKey?: string | null;
	onOpenPluginContainer?: (containerKey: string) => void;
}) {
	const sidebarOpen = useWindowSidebarStore((state) => state.open);
	// 기본 모드 간소화(2026-08-31): pro 표면 탭들은 공유 해석기 하나가 접고,
	// 저장된 선택은 같은 훅이 spaces로 읽어 칩과 패널이 함께 움직인다.
	const foldedRailTabs = useBasicFoldedRailTabs();
	const railTabs = RAIL_TABS.filter((tab) => !foldedRailTabs.has(tab.id));
	const sidebarTab = useEffectiveSidebarTab();
	const setSidebarTab = useWindowSidebarStore((state) => state.setTab);
	const toggleSidebar = useWindowSidebarStore((state) => state.toggle);
	const agentDisplayStates = useAgentAttention(
		(state) => state.displayStates,
	);
	const spacesAttentionCount = countAttentionDisplayStates(agentDisplayStates);
	const language = useStore((state) => state.language);
	const lang = resolveLang(language);
	const updateNotices = useUpdateNoticeSnapshot();
	const updateCount = updateNotices.unresolvedCount;
	// The badge toggles the notice stack: with the cards already on screen a
	// click that only resurfaced them did nothing visible and read as broken
	// (owner report 2026-09-15); now it puts them away, and the next click
	// brings them back. Dismissing hides, it does not resolve — the count
	// stays until the update is acted on.
	const updateNoticesShown = updateNotices.notices.some(
		(notice) => !notice.dismissed,
	);
	const toggleUpdateNotices = () => {
		if (updateNoticesShown) {
			for (const notice of updateNotices.notices)
				dismissUpdateNotice(notice.sourceRef);
		} else {
			resurfaceUpdateNotices();
		}
	};
	const updateLabel = t("sidebar.rail.updatesNeedAction", {
		count: updateCount,
	});
	return (
		// 레일과 패널 사이 경계는 --border가 아니라 glass 헤어라인이다. 사이드바
		// 전체가 하나의 표면이고 레일은 그 안의 구획이라, 창 바깥 테두리와 같은
		// 굵기로 그으면 레일이 별개 패널처럼 떨어져 보인다.
		//
		// 폭은 테두리 포함이다 (2061:13945 — Figma는 선을 안쪽에 긋고,
		// Tailwind preflight의 border-box도 같다). 값은 SIDEBAR_RAIL_WIDTH
		// 한 곳에서만 정한다 — 사이드바 접힘 폭이 같은 값을 써야 한다.
		//
		// 헤어라인은 패널이 열려 있을 때만 긋는다. 접히면 레일 오른쪽에 있는 건
		// 패널이 아니라 워크스페이스 카드이고, 그 경계는 이미 카드의 여백·모서리·
		// 그림자가 맡는다 — 접힌 시안(2104:15791)의 레일 오른쪽 끝에 선이 없는
		// 이유다. 남겨 두면 카드 그림자 바로 옆에 세로줄이 하나 더 생겨 레일이
		// 셸에서 떨어진 별개 패널처럼 보인다.
		<div
			className={cn(
				"flex shrink-0 flex-col items-center gap-1 pb-2.5",
				sidebarOpen && "border-r border-glass-hairline",
			)}
			style={{ width: SIDEBAR_RAIL_WIDTH }}
		>
			{railTabs.map(({ id, icon: Icon, label }) => {
				// 선택 표시는 접힌 상태에서도 유지한다 (2104:15771에서 첫 아이콘이
				// 칩을 달고 있다). 접히면 표시가 사라지던 예전 동작은, 다시 열 때
				// 어느 패널이 나올지 아이콘만 보고는 알 수 없게 만들었다.
				//
				// 그래서 두 축을 따로 말한다: aria-pressed는 칩과 같은 뜻으로
				// "이 탭이 선택돼 있다", aria-expanded는 "그 패널이 지금 보인다".
				// 하나로 합치면 접힘에서 화면에는 눌린 칩이 있는데 AT에는 전부
				// pressed=false로 나가, 이 커밋이 없애려던 정보 손실이 AT 쪽에만
				// 그대로 남는다.
				const selected = sidebarTab === id;
				const labelText = label();
				const attentionLabel =
					id === "spaces" && spacesAttentionCount > 0
						? `${labelText} · ${t("spaces.rail.needsAttention", { n: spacesAttentionCount })}`
						: labelText;
				// Clicking the item you are already on toggles the sidebar rather
				// than switching to it, so on that item the tooltip says what the
				// click does. `aria-expanded` below already told assistive tech;
				// the sighted reader had to find it by accident (owner report
				// 2026-09-08). The name stays the accessible one — the tooltip is
				// the hint, not the label.
				const hint = selected ? railToggleHint(sidebarOpen) : attentionLabel;
				return (
					// The app's own tooltip, not the `title` attribute's — that one
					// is the OS's plain box and looked nothing like the rest of the
					// app (owner report 2026-09-08). `aria-label` still carries the
					// accessible name; the tooltip carries the hint.
					<Tooltip key={id}>
						<TooltipTrigger asChild>
							<button
								type="button"
								className={cn(
									RAIL_ITEM_BASE,
									"relative",
									railItemSurface(selected),
								)}
								aria-label={attentionLabel}
								aria-pressed={selected}
								aria-expanded={selected && sidebarOpen}
								onClick={() => {
									if (sidebarTab === id) {
										toggleSidebar();
									} else {
										setSidebarTab(id);
										if (!sidebarOpen) toggleSidebar();
									}
								}}
							>
								<Icon className={RAIL_ICON_SIZE} />
								{id === "spaces" && spacesAttentionCount > 0 ? (
									<span
										className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-status-blocked px-1 text-center text-[9px] leading-3.5 font-semibold text-background"
										aria-hidden="true"
									>
										{Math.min(spacesAttentionCount, 99)}
									</span>
								) : null}
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">{hint}</TooltipContent>
					</Tooltip>
				);
			})}
			{/* 구분선 뒤 아이콘은 하나. 아이콘 묶음 바로 아래에 붙는다 —
			    2061:13945의 Margin(py-8px)+Divider(1px·24px)로 17px을 차지하고,
			    레일 맨 아래로 내려가지 않는다. 바닥에 붙이면 구분선이 '레일의
			    끝'을 뜻하게 되어, 탭 묶음과 유틸리티 액션을 가른다는 원래 의미가
			    사라진다. */}
			<div className="flex flex-col items-center gap-1">
				<div className="my-2 h-px w-6 bg-glass-hairline" />
				{pluginContainers.map((contribution) => {
					const label = pluginLocalizedText(contribution.container.title, lang);
					const containerKey = pluginSidebarContainerKey(contribution);
					const selected =
						sidebarTab === "plugin" &&
						activePluginContainerKey === containerKey;
					return (
						<PluginRailItem
							key={containerKey}
							pluginId={contribution.plugin.manifest.id}
						>
						{/* The same tooltip the core tabs wear (owner request 2026-09-10):
						    the native title showed as the browser's own black box and
						    the GitHub entry looked as if it had none. */}
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className={cn(RAIL_ITEM_BASE, railItemSurface(selected))}
									aria-label={label}
									aria-pressed={selected}
									aria-expanded={selected && sidebarOpen}
									onClick={() => {
										if (selected) {
											toggleSidebar();
											return;
										}
										onOpenPluginContainer?.(containerKey);
										setSidebarTab("plugin");
										if (!sidebarOpen) toggleSidebar();
									}}
								>
									<PluginMark
										icon={contribution.container.icon}
										className={RAIL_ICON_SIZE}
									/>
								</button>
							</TooltipTrigger>
							<TooltipContent side="right">
								{selected ? railToggleHint(sidebarOpen) : label}
							</TooltipContent>
						</Tooltip>
						</PluginRailItem>
					);
				})}
				{/* Agent Accounts는 전체 설정에 이미 있다. 이 유틸리티 자리는
				    Dure 자체 확장 기능을 여는 플러그인 진입점으로 사용한다. */}
				{!foldedRailTabs.has("extension") && (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							className={cn(
								RAIL_ITEM_BASE,
								railItemSurface(sidebarTab === "extension"),
							)}
							aria-label={t("common.plugin")}
							aria-pressed={sidebarTab === "extension"}
							aria-expanded={sidebarTab === "extension" && sidebarOpen}
							onClick={() => {
								if (sidebarTab === "extension") {
									toggleSidebar();
								} else {
									setSidebarTab("extension");
									if (!sidebarOpen) toggleSidebar();
								}
							}}
						>
							<Plug className={RAIL_ICON_SIZE} />
						</button>
					</TooltipTrigger>
					<TooltipContent side="right">
						{sidebarTab === "extension"
							? railToggleHint(sidebarOpen)
							: t("common.plugin")}
					</TooltipContent>
				</Tooltip>
				)}
			</div>
			{updateCount > 0 ? (
				<Titled title={updateLabel} side="right">
					<button
						type="button"
						className={cn(
							RAIL_ITEM_BASE,
							railItemSurface(false),
							"relative mt-auto",
						)}
						aria-label={updateLabel}
						onClick={toggleUpdateNotices}
					>
						<Download className={RAIL_ICON_SIZE} />
						<span
							// A neutral count, not the attention tone: orange on this rail
							// means an agent is waiting on a decision (the Spaces badge);
							// an available update is optional maintenance and only needs
							// to be seen (owner call 2026-09-15). The selection tint —
							// brightness says "worth a look", the app's rule.
							className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-foreground/[0.13] px-1 text-center text-[9px] leading-3.5 font-semibold text-foreground"
							aria-hidden="true"
						>
							{Math.min(updateCount, 99)}
						</span>
					</button>
				</Titled>
			) : null}
			{/* Settings remains the final rail action. The update affordance, when
			    present, owns the bottom spacer immediately above it. */}
			<Titled title={t("sidebar.rail.settings")} side="right">
				<button
					type="button"
					className={cn(
						RAIL_ITEM_BASE,
						railItemSurface(false),
						updateCount === 0 && "mt-auto",
					)}
					aria-label={t("sidebar.rail.settings")}
					onClick={onOpenSettings}
				>
					<Settings className={RAIL_ICON_SIZE} />
				</button>
			</Titled>
		</div>
	);
}

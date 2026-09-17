// Context-menu content for the Spaces rows — extracted from SpacesRows so the
// menu's store subscriptions (accounts, installed providers, desktops) and
// entry building run only while a menu is actually open. Radix mounts
// ContextMenuContent children on open, so mounting these components there IS
// the lazy gate: a list of N rows pays zero menu work until a right-click.
// Menu semantics while open are unchanged — the same subscriptions drive the
// same entries, they just live inside the menu's lifetime.

import {
	Check,
	EyeOff,
	GitFork,
	PencilLine,
	Pin,
	PinOff,
	Play,
	RotateCw,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { useMemo } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import type {
	SpaceMenuHandlers,
	SpaceRowView,
} from "@/components/spaces/spacesRowTypes";
import {
	useSpaceMenuAccountsState,
	useOpenSpaceMenuState,
} from "@/components/spaces/useSpacesRowsState";
import {
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useAvailableProviders } from "@/lib/agents/agentInstalls";
import { providerForkInheritsConversation } from "@/lib/agents/providerForkCapability";
import { t } from "@/lib/i18n";
import {
	buildSpaceMenu,
	type SpaceMenuAccount,
	type SpaceMenuEntry,
} from "@/lib/spaces/spacesActions";
import { cn } from "@/lib/utils";
import { type Agent, PROVIDERS, type Provider } from "@/types";

/** 시안 2092:16182이 지정한 항목별 글리프. 계정 줄은 Check라 여기 없다. */
const MENU_ICONS: Partial<Record<string, React.ReactNode>> = {
	pin: <Pin />,
	unpin: <PinOff />,
	restart: <RotateCw />,
	fork: <GitFork />,
	"promote-managed": <ShieldCheck />,
	kill: <Trash2 />,
};

function renderMenuEntries(
	entries: SpaceMenuEntry[],
	spaceKey: string,
	handlers: SpaceMenuHandlers & { onTogglePin: () => void },
) {
	return entries.map((entry) => {
		if (entry.kind === "label") {
			return <ContextMenuLabel key={entry.id}>{entry.label}</ContextMenuLabel>;
		}
		if (entry.kind === "separator") {
			return <ContextMenuSeparator key={entry.id} />;
		}
		if (entry.kind === "submenu") {
			// 옆으로 열리는 하위 목록 — 항목 렌더 규칙은 본 메뉴와 동일해야 하므로
			// 재귀 한 번으로 끝낸다 (PaneActionMenu의 Sub 계열과 같은 관례).
			return (
				<ContextMenuSub key={entry.id}>
					<ContextMenuSubTrigger>
						<span className="min-w-0 flex-1 truncate">{entry.label}</span>
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						{renderMenuEntries(entry.entries, spaceKey, handlers)}
					</ContextMenuSubContent>
				</ContextMenuSub>
			);
		}
		const action = entry.action;
		const onSelect = () => {
			if (action.type === "switch-account" && entry.checked) return;
			if (action.type === "pin" || action.type === "unpin") handlers.onTogglePin();
			else if (action.type === "view-diff") handlers.onViewDiff(spaceKey);
			else if (action.type === "move-to-desktop")
				handlers.onMoveToDesktop(spaceKey, action.desktopId);
			else if (action.type === "move-to-new-desktop")
				handlers.onMoveToNewDesktop(spaceKey);
			else if (action.type === "restart") handlers.onRestart(spaceKey);
			else if (action.type === "fork")
				handlers.onFork(spaceKey, action.provider);
			else if (action.type === "promote-managed")
				handlers.onPromoteManaged(spaceKey);
			else if (action.type === "switch-account")
				handlers.onSwitchAccount(spaceKey, action.accountId);
			else handlers.onKill(spaceKey);
		};
		// 시안 2092:16182 — 항목은 12px 아이콘 + 8px 간격. 계정 줄은 아이콘 자리에
		// 체크를 두고, 안 고른 줄도 그 자리를 비워 글자 시작점을 맞춘다.
		const icon = MENU_ICONS[action.type];
		return (
			<ContextMenuItem
				key={entry.id}
				variant={entry.variant}
				disabled={entry.disabled}
				onSelect={onSelect}
			>
				{action.type === "switch-account" ? (
					<Check
						className={cn("size-3 shrink-0", !entry.checked && "opacity-0")}
					/>
				) : (
					icon && (
						<span className="flex size-3 shrink-0 items-center justify-center [&_svg]:size-3">
							{icon}
						</span>
					)
				)}
				<span className="min-w-0 flex-1 truncate">{entry.label}</span>
			</ContextMenuItem>
		);
	});
}

/** 이 에이전트 프로바이더로 고를 수 있는 계정들 — 시안 2092:16182의 "계정 전환".
 *  Agent 행은 실행 중 runtime에 커밋된 credential만 표시하고, 일반 Terminal
 *  행만 다음 launch를 위한 provider 활성 계정을 표시한다.
 *
 *  시안에 있는 "45% 남음" 잔량은 아직 넣지 못한다: usage_recent가 프로바이더
 *  단위 집계라 계정별로 쪼갤 수 없다. 숫자를 지어내는 대신 비워 둔다. */
function useSpaceMenuAccounts(
	agentId: string | undefined,
	provider: Provider | null | undefined,
): SpaceMenuAccount[] | undefined {
	const { accounts, activeAccounts, assigned } =
		useSpaceMenuAccountsState(agentId);
	return useMemo(() => {
		if (!provider) return undefined;
		const pool = accounts.filter((account) => account.provider === provider);
		if (pool.length === 0) return undefined;
		const current = agentId
			? (assigned ?? null)
			: (activeAccounts[provider] ?? null);
		return [
			{ id: null, name: t("common.default"), active: current === null },
			...pool.map((account) => ({
				id: account.id,
				name: account.name,
				active: account.id === current,
			})),
		];
	}, [agentId, provider, accounts, activeAccounts, assigned]);
}

/** Open-row context menu body — mounted by Radix only while the menu is open. */
export function OpenSpaceRowMenu({
	space,
	canViewDiff,
	selectionCount,
	promotionEligibleCount,
	promotionDeferredCount,
	menuHandlers,
}: {
	space: SpaceRowView;
	canViewDiff: boolean;
	selectionCount: number;
	promotionEligibleCount: number;
	promotionDeferredCount: number;
	menuHandlers: SpaceMenuHandlers;
}) {
	const accounts = useSpaceMenuAccounts(space.agentId, space.provider);
	const forkProviders = useAvailableProviders();
	// 이동 서브메뉴의 대상 후보 — popout·현재 데스크탑 필터는 buildSpaceMenu가
	// 소유하므로 여기서는 스토어 목록을 그대로 흘린다.
	const { desktops, pinned, togglePin } = useOpenSpaceMenuState(space);
	// 메뉴는 렌더마다가 아니라 실제 입력이 바뀔 때만 다시 만든다.
	const entries = useMemo(
		() =>
			buildSpaceMenu({
				count: selectionCount,
				pinned,
				currentDesktopId: space.desktopId,
				desktops,
				canViewDiff,
				isAgent: Boolean(space.agentId),
				hasProvider: Boolean(space.provider),
				accounts,
				managedPromotion: space.managedPromotion,
				managedPromotionEligibleCount: promotionEligibleCount,
				managedPromotionDeferredCount: promotionDeferredCount,
				provider: space.provider,
				forkProviders: space.agentId ? forkProviders : undefined,
			}),
		[
			selectionCount,
			pinned,
			space.desktopId,
			desktops,
			canViewDiff,
			space.agentId,
			space.provider,
			forkProviders,
			space.managedPromotion,
			promotionEligibleCount,
			promotionDeferredCount,
			accounts,
		],
	);
	return <>{renderMenuEntries(entries, space.key, { ...menuHandlers, onTogglePin: togglePin })}</>;
}

/** Unopened-row context menu body — same lazy-mount contract as above. */
export function UnopenedAgentRowMenu({
	agent,
	displayName,
	onOpen,
	onViewDiff,
	onRename,
	onHide,
	onFork,
	onKill,
}: {
	agent: Agent;
	displayName: string;
	onOpen: (agent: Agent) => void;
	onViewDiff: (agent: Agent) => void;
	onRename: () => void;
	onHide: (agent: Agent) => void;
	onFork: (agent: Agent, provider: Provider) => void;
	onKill: (agent: Agent) => void;
}) {
	const forkProviders = useAvailableProviders();
	return (
		<>
			<ContextMenuLabel>{displayName}</ContextMenuLabel>
			<ContextMenuItem onSelect={() => onOpen(agent)}>
				<Play className="fill-current" />
				{t("common.resumeContinue")}
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => onViewDiff(agent)}>
				{t("spaces.actions.viewDiff")}
			</ContextMenuItem>
			<ContextMenuItem onSelect={onRename}>
				<PencilLine />
				{t("common.agentRename.menu")}
			</ContextMenuItem>
			{/* 감지 워크트리 행과 같은 문법 — 숨겨도 등록·세션은 그대로고,
			    새 attention 에피소드가 행을 자동으로 되살린다. */}
			<ContextMenuItem onSelect={() => onHide(agent)}>
				<EyeOff />
				{t("common.hideFromList")}
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuLabel className="flex items-center gap-1.5">
				<GitFork className="size-3" /> {t("common.sessionForkNewWorktree")}
			</ContextMenuLabel>
			{forkProviders.map((provider) => (
				<ContextMenuItem
					key={provider}
					onSelect={() => onFork(agent, provider)}
				>
					<ProviderGlyph provider={provider} />
					{t("spaces.actions.forkTo", {
						provider: PROVIDERS[provider].label,
						mode: providerForkInheritsConversation(agent.provider, provider)
							? t("common.conversationFork")
							: t("common.newConversation"),
					})}
				</ContextMenuItem>
			))}
			<ContextMenuSeparator />
			<ContextMenuItem variant="destructive" onSelect={() => onKill(agent)}>
				<Trash2 />
				{t("spaces.actions.removeAgent")}
			</ContextMenuItem>
		</>
	);
}

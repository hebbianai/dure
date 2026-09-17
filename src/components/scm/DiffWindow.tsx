import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Titled } from "@/components/ui/tooltip";
import { DiffPanel } from "@/components/scm/DiffPanel";
import {
	SecondaryWindowShell,
	useSecondaryWindowBoot,
	windowChromeDragHandler,
} from "@/components/workspace/SecondaryWindowShell";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { t } from "@/lib/i18n";
import { startDiffReviewTargetRetention } from "@/lib/scm/review/diffReviewRetention";
import {
	type DiffReviewPanelParams,
	newDiffReviewId,
} from "@/lib/scm/review/diffReviewTarget";
import { agentPaneTitle } from "@/lib/workspace/pane/paneTitle";
import { useDurableWindowClose } from "@/lib/workspace/window/useDurableWindowClose";
import { useStore } from "@/store";

/** dockview 없이 DiffPanel을 단독 렌더하기 위한 최소 pane api.
 *  단독 창은 layout params를 저장할 Dockview가 없으므로 reviewId를 처음부터
 *  제공한다. 창 수명 동안 같은 id를 써서 재렌더가 review 대상을 바꾸지 않는다. */
function standaloneDiffProps(
	agentId: string,
	reviewId: string,
): IDockviewPanelProps<DiffReviewPanelParams> {
	return {
		params: { agentId, reviewId },
		api: {
			id: `diff-window:${agentId}`,
			isVisible: true,
			onDidVisibilityChange: () => ({ dispose() {} }),
		},
		// DiffPanel은 containerApi를 쓰지 않지만 타입을 만족시키기 위한 껍데기.
		containerApi: {},
	} as unknown as IDockviewPanelProps<DiffReviewPanelParams>;
}

/** ?diff=<agentId>로 열린 단독 Diff 창의 루트. 사이드바·데스크탑 탭 등 IDE
 *  chrome 없이, 상단 드래그 스트립 + 전체 화면 DiffPanel만 렌더한다. */
export function DiffWindowRoot({ agentId }: { agentId: string }) {
	const [reviewId] = useState(newDiffReviewId);
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const agentCwd = useStore((s) =>
		agent ? s.sessionCwd[agent.sessionId] : undefined,
	);

	// Shared secondary-window boot (dark class, language, keyboard focus,
	// store sync) — the native title follows the agent name too (taskbar /
	// window-switcher identity).
	const lang = useSecondaryWindowBoot(
		agent ? `Diff — ${agentDisplayName(agent)}` : "Diff",
	);
	useDurableWindowClose();
	useEffect(() => startDiffReviewTargetRetention(), []);

	const heading = agent
		? agentPaneTitle(agentDisplayName(agent), agentCwd, agent.worktreePath)
		: t("common.agentDeleted");

	return (
		<SecondaryWindowShell key={lang} className="overflow-hidden">
			{/* 상단 드래그 스트립 — 신호등(overlay) 자리 82px 비우고 제목만 표시 */}
			<div
				className="z-10 flex h-[var(--app-chrome-bar-height)] shrink-0 items-center gap-2 border-b border-border/60 bg-sidebar pr-3 text-sidebar-foreground select-none"
				onMouseDown={windowChromeDragHandler()}
			>
				<span className="w-[82px] shrink-0" aria-hidden="true" />
				<Titled title={heading}>
					<span
						className="min-w-0 flex-1 truncate text-xs font-medium"
					>
						{heading}
					</span>
				</Titled>
			</div>
			<div className="relative min-h-0 flex-1">
				{agent ? (
					<DiffPanel {...standaloneDiffProps(agentId, reviewId)} />
				) : (
					<PanelStatus>{t("common.agentDeleted")}</PanelStatus>
				)}
			</div>
		</SecondaryWindowShell>
	);
}

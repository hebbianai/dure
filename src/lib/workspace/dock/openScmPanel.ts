/** The source-control panes a Space can open: one Git panel per project and
 * one Diff Review per Agent worktree or standalone session. Each reuses the
 * pane already showing that target instead of opening a second one. */

import { track } from "@/lib/ipc/telemetry";
import { gitProjectIdFromPane } from "@/lib/scm/gitPaneTarget";
import { newDiffReviewId } from "@/lib/scm/review/diffReviewTarget";
import {
	dockPanelParameters,
	dockPanelReference,
} from "@/lib/workspace/dock/dockPanelParameters";
import { dockviewRegistry as registry } from "@/lib/workspace/dock/dockRegistry";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";

/** 프로젝트별 Git 패널을 연다 (pull/push/commit/PR 등). */
export function openGitPanel(
	desktopId: string,
	projectId: string,
	name: string,
) {
	const api = registry.get(desktopId);
	if (!api) return;
	const existing = api.panels.find(
		(panel) => gitProjectIdFromPane(dockPanelReference(panel)) === projectId,
	);
	if (!existing) track("git_panel_opened");
	openOrFocusPanel({
		api,
		panelId: existing?.id ?? createPaneId(),
		component: "git",
		title: `Git · ${name}`,
		params: { projectId },
	});
}

/** 에이전트 워크트리의 Diff Review 패널을 연다 — fork-point 대비 읽기 전용. */
export function openDiffPanel(
	desktopId: string,
	agentId: string,
	name: string,
) {
	const api = registry.get(desktopId);
	if (!api) return;
	const existing = api.panels.find((panel) => {
		const current = dockPanelReference(panel);
		return current.component === "diff" && current.params.agentId === agentId;
	});
	openOrFocusPanel({
		api,
		panelId: existing?.id ?? createPaneId(),
		component: "diff",
		title: `Diff · ${name}`,
		params: { agentId, reviewId: newDiffReviewId() },
		onExisting: (existing) => {
			const existingParams = dockPanelParameters(existing);
			if (typeof existingParams.reviewId !== "string") {
				existing.api.updateParameters({
					...existingParams,
					reviewId: newDiffReviewId(),
				});
			}
			// 에이전트가 개명된 뒤 다시 열면 탭 제목도 따라가야 한다.
			applyAutomaticPaneTitle(existing.api, `Diff · ${name}`);
		},
	});
}

/**
 * standalone 로컬 세션의 현재 관측 cwd를 review 후보로 한 번 캡처한다.
 * DiffPanel/backend가 실제 Git worktree root를 검증·정규화하며, 열린 pane은
 * 이후 sessionCwd 변경을 구독하지 않는다.
 */
export function openSessionDiffPanel(
	desktopId: string,
	sessionId: string,
	cwd: string,
	name: string,
) {
	const api = registry.get(desktopId);
	if (!api || !cwd.trim()) return;
	const existing = api.panels.find((panel) => {
		const current = dockPanelReference(panel);
		return (
			current.component === "diff" &&
			current.params.agentId === undefined &&
			current.params.sessionId === sessionId
		);
	});
	const params = { cwd, sessionId, reviewId: newDiffReviewId() };
	openOrFocusPanel({
		api,
		panelId: existing?.id ?? createPaneId(),
		component: "diff",
		title: `Diff · ${name}`,
		params,
		onExisting: (existing) => {
			existing.api.updateParameters({
				...dockPanelParameters(existing),
				...params,
			});
			applyAutomaticPaneTitle(existing.api, `Diff · ${name}`);
		},
	});
}

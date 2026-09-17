import type { Agent } from "@/types";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";

/** Dockview에 저장되는 Diff pane 대상. 기존 pane은 agentId만 가진다. */
export interface DiffReviewPanelParams {
	/** 불변 backend review target identity. 기존 pane은 처음 reveal 때 추가된다. */
	readonly reviewId?: string;
	readonly agentId?: string;
	/** standalone 세션에서 Diff를 연 순간 캡처한 cwd. 백엔드가 worktree root로 정규화한다. */
	readonly cwd?: string;
	/** standalone review의 출처 provenance. 피드백 라우팅 권한은 부여하지 않는다. */
	readonly sessionId?: string;
}

export type DiffReviewTarget =
	| {
			readonly status: "ready";
			readonly sourcePath: string;
			readonly revisionLabel: string;
			readonly feedbackAgentId?: string;
	  }
	| { readonly status: "missing-agent" }
	| { readonly status: "missing-path" };

/**
 * Diff의 Git 대상과 피드백 수신자를 분리한다.
 *
 * managed pane은 durable Agent binding이 권위이고, standalone pane은 사용자가
 * Diff를 연 순간 저장한 cwd만 사용한다. 라이브 cwd를 구독하지 않으므로 이후
 * `cd`가 이미 열린 리뷰를 다른 저장소로 바꾸지 않는다.
 */
export function resolveDiffReviewTarget(
	params: DiffReviewPanelParams,
	agent: Agent | undefined,
): DiffReviewTarget {
	if (params.agentId) {
		if (!agent || agent.id !== params.agentId)
			return { status: "missing-agent" };
		if (!agent.worktreePath.trim()) return { status: "missing-path" };
		return {
			status: "ready",
			sourcePath: agent.worktreePath,
			revisionLabel: agent.branch || "HEAD",
			feedbackAgentId: agent.id,
		};
	}

	const sourcePath = params.cwd;
	if (!sourcePath?.trim()) return { status: "missing-path" };
	return {
		status: "ready",
		sourcePath,
		revisionLabel: "HEAD",
	};
}

/** Dock layout에 저장해 같은 pane의 create 재시도를 멱등하게 만드는 review id. */
export function newDiffReviewId(
	randomUuid: () => string = () =>
		globalThis.crypto?.randomUUID?.() ??
		`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
): string {
	return `review-${randomUuid()}`;
}

/**
 * Persisted Dock layouts are the durable roots for immutable review targets.
 * Invalid or duplicate ids are ignored so one stale pane cannot block the
 * fail-safe reconciliation of every other restorable review.
 */
export function reviewIdsFromLayouts(
	layouts: Readonly<Record<string, unknown>>,
): readonly string[] {
	const reviewIds = new Set<string>();
	for (const layout of Object.values(layouts)) {
		for (const panel of panelsFromLayout(layout)) {
			if (panel.component !== "diff") continue;
			const reviewId = panel.params.reviewId;
			if (
				typeof reviewId !== "string" ||
				reviewId.length === 0 ||
				reviewId.length > 160
			) {
				continue;
			}
			if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(reviewId)) continue;
			reviewIds.add(reviewId);
		}
	}
	return [...reviewIds].sort();
}

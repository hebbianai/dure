// 데스크탑 티어 재조정(reconcileDesktopTiers)의 트리거 코얼레서.
//
// 재조정 커널은 호출마다 전체 성능 스냅샷 + 전 레이아웃 순회를 지불하는데,
// 리소스 변화(microtask)·hover 프리웜·이웃 웜 세 트리거가
// 각자 즉시 호출해 스트리밍 중 같은 프레임에 여러 번 겹쳤다(2026-08-04
// 전수조사: "트리거 5곳이 부르는 무거운 커널"). 이 코얼레서는 대기 의도를
// 하나로 병합해 catchup 레인 슬라이스당 최대 1회 실행한다 — 상호작용(특히
// 데스크탑 전환) 중에는 정지되므로 전환 프레임의 재조정 churn도 사라진다.
//
// 활성 데스크탑 미마운트 폴백·활성 전환 효과는 correctness라 이 경로를
// 거치지 않고 동기 실행을 유지한다(WorkspaceDeck 참조).

import { getFrameBudgetScheduler } from "@/lib/scheduling/frameBudgetScheduler";
import type { WorkspaceCacheTiers } from "./workspaceCachePolicy";

export interface TierReconcileIntent {
	/** 압력 축출을 허용하는 리소스 변화 재조정(수축 가능). */
	resourceChange?: boolean;
	warmCandidates?: readonly string[];
	retainCandidates?: readonly string[];
	/** 실행 시점의 current.warm을 보호 warm 후보로 쓸 것(스윕 visit 의미론). */
	protectedWarmFromCurrent?: boolean;
}

export interface MergedTierReconcileIntent {
	resourceChange: boolean;
	warmCandidates: string[];
	retainCandidates: string[];
	protectedWarmFromCurrent: boolean;
}

type LaneSchedule = (task: () => void) => () => void;

const defaultCatchupLane: LaneSchedule = (task) =>
	getFrameBudgetScheduler().schedule("catchup", task, "workspace-tier-reconcile");

function emptyIntent(): MergedTierReconcileIntent {
	return {
		resourceChange: false,
		warmCandidates: [],
		retainCandidates: [],
		protectedWarmFromCurrent: false,
	};
}

function appendUnique(target: string[], source: readonly string[] = []): void {
	for (const id of source) {
		if (!target.includes(id)) target.push(id);
	}
}

export interface MergedTierReconcileResolution {
	current: WorkspaceCacheTiers;
	intent: MergedTierReconcileIntent;
	/** 재조정 커널 — base 티어와 후보들로 새 선택을 계산한다. */
	reconcile(
		base: WorkspaceCacheTiers,
		warmCandidates: readonly string[],
		retainCandidates: readonly string[],
		protectedWarmCandidates: readonly string[],
	): WorkspaceCacheTiers;
	/** 수축 없는 프리웜 승인(acceptWorkspacePrewarmTiers). */
	accept(
		base: WorkspaceCacheTiers,
		next: WorkspaceCacheTiers,
	): WorkspaceCacheTiers;
	same(a: WorkspaceCacheTiers, b: WorkspaceCacheTiers): boolean;
}

/** 병합 의도의 2단 적용 — 압력 패스(수축 허용)는 투기 후보 없이 돌고,
 *  후보 패스는 그 결과 위에 수축 없는 승인으로만 얹는다. 투기 후보가 raw
 *  적용에 참여하면 예산이 빡빡할 때 기존 warm 데스크탑을 강등시켜 WebGL
 *  렌더러를 파괴할 수 있다(2026-08-05 리뷰: "프리웜은 warm 렌더러를 파괴할
 *  수 없다" 불변식). 접힌 경우에만 커널이 2회 돌고, 레인 유닛은 여전히
 *  1개다. */
export function resolveMergedTierReconcile(
	input: MergedTierReconcileResolution,
): WorkspaceCacheTiers {
	const { current, intent } = input;
	let base = current;
	if (intent.resourceChange) {
		const pressured = input.reconcile(current, [], [], []);
		base = input.same(pressured, current) ? current : pressured;
	}
	const hasCandidates =
		intent.warmCandidates.length > 0 ||
		intent.retainCandidates.length > 0 ||
		intent.protectedWarmFromCurrent;
	if (!hasCandidates) return base;
	const next = input.reconcile(
		base,
		intent.warmCandidates,
		intent.retainCandidates,
		intent.protectedWarmFromCurrent ? base.warm : [],
	);
	return input.accept(base, next);
}

export class TierReconcileScheduler {
	private pending: MergedTierReconcileIntent | undefined;
	private cancelUnit: (() => void) | undefined;
	private disposed = false;

	constructor(
		private readonly run: (intent: MergedTierReconcileIntent) => void,
		private readonly lane: LaneSchedule = defaultCatchupLane,
	) {}

	/** 의도를 대기분에 병합한다 — 후보는 합집합, 플래그는 OR. 재조정은
	 *  최신 상태를 스스로 읽으므로 접기(코얼레싱)가 안전하다.
	 *
	 *  urgent: run the merged pending immediately instead of riding the
	 *  catchup lane. The lane pauses during sustained interaction (desktop
	 *  switches keep it paused up to the 10s starvation cap), which is exactly
	 *  when severe WebGL-context overshoot must reclaim before WKWebView
	 *  silently LRU-kills contexts. Consume-and-clear semantics: the bypass
	 *  runs the full merged intent (never a stale replay) and cancels the
	 *  pending lane unit so the kernel still runs at most once per trigger. */
	request(intent: TierReconcileIntent, urgent = false): void {
		if (this.disposed) return;
		const pending = this.pending ?? emptyIntent();
		pending.resourceChange ||= intent.resourceChange ?? false;
		pending.protectedWarmFromCurrent ||=
			intent.protectedWarmFromCurrent ?? false;
		appendUnique(pending.warmCandidates, intent.warmCandidates);
		appendUnique(pending.retainCandidates, intent.retainCandidates);
		this.pending = pending;
		if (urgent) {
			this.cancelUnit?.();
			this.cancelUnit = undefined;
			this.pending = undefined;
			this.run(pending);
			return;
		}
		if (this.cancelUnit) return;
		this.cancelUnit = this.lane(() => {
			this.cancelUnit = undefined;
			const merged = this.pending;
			this.pending = undefined;
			if (!merged || this.disposed) return;
			this.run(merged);
		});
	}

	dispose(): void {
		this.disposed = true;
		this.cancelUnit?.();
		this.cancelUnit = undefined;
		this.pending = undefined;
	}
}

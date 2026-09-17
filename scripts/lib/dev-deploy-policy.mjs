/**
 * 라이브 daily-driver 워크트리를 언제 새 main으로 옮길지 정하는 순수 판정
 * (hebbian-frontend-x6r.11).
 *
 * 배경: 여러 에이전트가 main에 커밋할 때마다 공유 dev 워크트리를 각자
 * `git merge --ff-only` 하면, Tauri dev watcher가 그때마다 frontend reload와
 * Rust 재컴파일을 일으킨다. 모든 pane이 동시에 render_backlog/controller
 * recovery로 들어가 입력이 수십 초 멈춘다(2026-07-29 qa.log: 30분 사이 boot
 * 11회, 회복 31~44초).
 *
 * 그래서 배포는 커밋 단위 이벤트가 아니라 **정책 경계**로 다룬다:
 *  - 이미 최신이면 아무것도 하지 않는다 → 연속 landing이 배포 1회로 접힌다.
 *  - main이 아직 들썩이면 잠잠해질 때까지 미룬다(버스트 병합).
 *  - 사용자가 쓰고 있으면 미룬다. 강제 상한을 두지 않는다 — 시간이 됐다고
 *    남의 입력을 끊는 건 이 이슈가 고치려는 바로 그 증상이다. 늦추는 대신
 *    얼마나 밀렸는지를 드러내고, 즉시 필요하면 호출자가 force로 넘긴다.
 */

/** 기본 정책. 호출자가 필요한 항목만 덮어쓴다. */
export const DEFAULT_DEPLOY_POLICY = {
  /** main이 이 시간만큼 조용해야 배포한다 (연속 landing 병합). */
  quietWindowMs: 90_000,
  /** 사용자가 이 시간 이상 입력이 없어야 배포한다 (머신 HID idle). */
  minUserIdleSeconds: 45,
  /** 라이브 앱 pane에 이 시간 안에 입력이 있었으면 배포하지 않는다. */
  paneInputQuietMs: 120_000,
};

/** 판정 결과의 action 값. */
export const DEPLOY_ACTIONS = Object.freeze({
  SKIP: "skip",
  DEFER: "defer",
  DEPLOY: "deploy",
});

function pendingLabel(pendingCommits) {
  if (typeof pendingCommits !== "number" || pendingCommits <= 0) return "";
  return ` (${pendingCommits} commit(s) pending)`;
}

/**
 * @param {object} input
 * @param {string} input.currentHead 라이브 워크트리의 현재 커밋
 * @param {string} input.targetHead 옮겨갈 커밋(origin/main)
 * @param {number} [input.pendingCommits] 밀려 있는 커밋 수 — 보고용
 * @param {number|null} [input.targetAgeMs] target 커밋이 landing된 뒤 경과 시간.
 *   null이면 알 수 없음으로 보고 quiet window를 통과시킨다(막지 않는다).
 * @param {number|null} [input.userIdleSeconds] 머신 HID idle. null이면 미지원.
 * @param {number|null} [input.paneInputAgeMs] 라이브 앱 pane 마지막 입력 경과.
 *   null이면 관측 불가.
 * @param {boolean} [input.force] 명시적 maintenance 배포 — 정책을 건너뛴다.
 * @param {object} [input.impact] 아직 활성화하지 못한 target-bound impact.
 * @param {object} [policy]
 * @returns {{action: string, reason: string}}
 */
export function decideDevDeploy(input, policy = {}) {
  const {
    quietWindowMs,
    minUserIdleSeconds,
    paneInputQuietMs,
  } = { ...DEFAULT_DEPLOY_POLICY, ...policy };
  const {
    currentHead,
    targetHead,
    pendingCommits,
    targetAgeMs = null,
    userIdleSeconds = null,
    paneInputAgeMs = null,
    force = false,
    impact,
  } = input;

  if (!currentHead || !targetHead) {
    throw new Error("decideDevDeploy needs both currentHead and targetHead");
  }
  // A matching checkout still owes a selected backend lifecycle action when
  // an older attempt applied HEAD but did not dispatch that action. This is
  // deploy execution, not runtime or product verification.
  if (currentHead === targetHead && impact?.backendChanged !== true) {
    return { action: DEPLOY_ACTIONS.SKIP, reason: "live worktree is already at target" };
  }
  if (force) {
    return {
      action: DEPLOY_ACTIONS.DEPLOY,
      reason: `explicit maintenance deploy${pendingLabel(pendingCommits)}`,
    };
  }
  if (targetAgeMs !== null && targetAgeMs < quietWindowMs) {
    return {
      action: DEPLOY_ACTIONS.DEFER,
      reason:
        `main landed ${Math.round(targetAgeMs / 1000)}s ago; waiting ` +
        `${Math.round(quietWindowMs / 1000)}s of quiet to coalesce` +
        pendingLabel(pendingCommits),
    };
  }
  if (userIdleSeconds !== null && userIdleSeconds < minUserIdleSeconds) {
    return {
      action: DEPLOY_ACTIONS.DEFER,
      reason:
        `user active ${Math.round(userIdleSeconds)}s ago; needs ` +
        `${minUserIdleSeconds}s idle` +
        pendingLabel(pendingCommits),
    };
  }
  if (paneInputAgeMs !== null && paneInputAgeMs < paneInputQuietMs) {
    return {
      action: DEPLOY_ACTIONS.DEFER,
      reason:
        `pane input ${Math.round(paneInputAgeMs / 1000)}s ago; needs ` +
        `${Math.round(paneInputQuietMs / 1000)}s quiet` +
        pendingLabel(pendingCommits),
    };
  }
  return {
    action: DEPLOY_ACTIONS.DEPLOY,
    reason: `quiet boundary reached${pendingLabel(pendingCommits)}`,
  };
}

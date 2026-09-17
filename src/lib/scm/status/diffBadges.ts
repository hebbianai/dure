// 사이드바 에이전트 diff 배지(±N)의 순수 로직 — zustand/Tauri 없이 vitest로
// 검증 가능해야 한다. 폴링 데이터 → 배지 값 변환과 표시 판단만 담당.

import { statTotals } from "@/lib/scm/diff/diffReview";
import type { AgentDiffStat, DiffFileStat } from "@/lib/ipc";

export interface DiffBadgeSlice {
  added: number;
  deleted: number;
  binary: number;
  files: number;
}

export interface DiffBadge extends DiffBadgeSlice {
  /** fork-point..HEAD의 커밋된 branch patch. */
  committed: DiffBadgeSlice;
  /** HEAD..working tree의 staged/unstaged/untracked patch. */
  worktree: DiffBadgeSlice;
  ahead: number;
  behind: number;
}

/** agent_diff_stat 결과의 files 배열을 배지 값으로 접는다. */
export function badgeFromFiles(
  files: { added: number | null; deleted: number | null }[],
): DiffBadgeSlice {
  const totals = statTotals(files);
  return { ...totals, files: files.length };
}

/** New frontend + old backend HMR도 안전하게 소비한다. 구 backend는 기존
 * 합산 diff를 committed로 보수적으로 표시하고 WIP/분기 수를 꾸며내지 않는다. */
export function badgeFromStat(stat: AgentDiffStat): DiffBadge {
  const committedFiles: DiffFileStat[] = stat.committedFiles ?? stat.files;
  const worktreeFiles: DiffFileStat[] = stat.worktreeFiles ?? [];
  const ahead =
    typeof stat.ahead === "number" && Number.isInteger(stat.ahead) && stat.ahead >= 0
      ? stat.ahead
      : 0;
  const behind =
    typeof stat.behind === "number" && Number.isInteger(stat.behind) && stat.behind >= 0
      ? stat.behind
      : 0;
  return {
    ...badgeFromFiles(stat.files),
    committed: badgeFromFiles(committedFiles),
    worktree: badgeFromFiles(worktreeFiles),
    ahead,
    behind,
  };
}

const EMPTY_SLICE: DiffBadgeSlice = Object.freeze({
  added: 0,
  deleted: 0,
  binary: 0,
  files: 0,
});

/** Frontend HMR 중 남아 있는 구형 flat badge도 다음 poll 전까지 안전하게
 * 표시한다. durable 상태 변환은 아니며 새 write는 항상 v2 shape이다. */
export function normalizeDiffBadge(badge: DiffBadge | DiffBadgeSlice): DiffBadge {
  const candidate = badge as Partial<DiffBadge>;
  return {
    added: badge.added,
    deleted: badge.deleted,
    binary: badge.binary,
    files: badge.files,
    committed: candidate.committed ?? {
      added: badge.added,
      deleted: badge.deleted,
      binary: badge.binary,
      files: badge.files,
    },
    worktree: candidate.worktree ?? EMPTY_SLICE,
    ahead:
      typeof candidate.ahead === "number" && candidate.ahead >= 0
        ? candidate.ahead
        : 0,
    behind:
      typeof candidate.behind === "number" && candidate.behind >= 0
        ? candidate.behind
        : 0,
  };
}

/** 변경이 하나도 없으면 배지를 그리지 않는다 (0 소음 방지). */
export function hasChanges(badge: DiffBadgeSlice | undefined | null): boolean {
  return !!badge && badge.files > 0;
}

/** 두 배지가 같으면 스토어 갱신(=리렌더)을 건너뛰기 위한 비교. */
export function sameBadge(a: DiffBadge | undefined, b: DiffBadge): boolean {
  if (!a) return false;
  const left = normalizeDiffBadge(a);
  const right = normalizeDiffBadge(b);
  return (
    left.added === right.added &&
    left.deleted === right.deleted &&
    left.binary === right.binary &&
    left.files === right.files &&
    left.committed.added === right.committed.added &&
    left.committed.deleted === right.committed.deleted &&
    left.committed.binary === right.committed.binary &&
    left.committed.files === right.committed.files &&
    left.worktree.added === right.worktree.added &&
    left.worktree.deleted === right.worktree.deleted &&
    left.worktree.binary === right.worktree.binary &&
    left.worktree.files === right.worktree.files &&
    left.ahead === right.ahead &&
    left.behind === right.behind
  );
}

import type { GitCommit } from "@/lib/scm/history/git";

/** Figma base/lane palette as theme tokens. The hex values live in
 *  index.css — :root = light (379:19004), .dark = dark (379:18956) — so the
 *  CSS cascade picks the mode and consumers need no dark/light branch. */
export const LANE_COLORS = Array.from({ length: 10 }, (_, i) => `var(--scm-lane-${i})`);

/** 한 행의 그래프: 노드 위치/색 + 이 행을 지나는 선분들 */
export interface GraphRow {
  commit: GitCommit;
  nodeLane: number;
  nodeColorIdx: number;
  /** 이 행 높이 안의 선분. top/bottom은 레인 인덱스, 색은 팔레트 인덱스.
   *  half: "upper"=위→노드(0~0.5), "lower"=노드→아래(0.5~1), "full"=위→아래 통과 */
  segments: { top: number; bottom: number; colorIdx: number; half: "upper" | "lower" | "full" }[];
  /** 이 행에서 동시에 존재하는 최대 레인 수 (열 너비 계산용) */
  width: number;
}

interface Lane {
  hash: string; // 이 레인이 다음에 기다리는 커밋
  colorIdx: number;
}

/**
 * 커밋 목록(최신순, topo-order)을 멀티레인 그래프 행으로 변환.
 * VS Code/git log --graph와 유사한 레인 배정 알고리즘.
 */
export function computeGraph(commits: GitCommit[]): GraphRow[] {
  const rows: GraphRow[] = [];
  let lanes: (Lane | null)[] = [];
  let colorCounter = 0;
  const nextColor = () => colorCounter++ % LANE_COLORS.length;

  const firstFree = (arr: (Lane | null)[]) => {
    const i = arr.indexOf(null);
    return i === -1 ? arr.length : i;
  };

  for (const commit of commits) {
    const prev = lanes;
    // 이 커밋을 기다리는 레인들 (여러 자식이 머지된 지점이면 2개 이상)
    const waiting: number[] = [];
    for (let j = 0; j < prev.length; j++) if (prev[j]?.hash === commit.hash) waiting.push(j);

    let nodeLane: number;
    let nodeColorIdx: number;
    if (waiting.length > 0) {
      nodeLane = waiting[0];
      nodeColorIdx = prev[nodeLane]!.colorIdx;
    } else {
      // 브랜치 팁 — 새 레인
      nodeLane = firstFree(prev);
      nodeColorIdx = nextColor();
    }

    // 다음 상태 구성: 기다리던 레인들은 비우고, 부모들을 배치
    const next: (Lane | null)[] = prev.slice();
    for (const j of waiting) next[j] = null;
    if (waiting.length === 0 && nodeLane >= next.length) next[nodeLane] = null;

    const parentLane = new Map<string, number>();
    commit.parents.forEach((p, i) => {
      // 이미 다른 레인이 이 부모를 기다리면 거기로 합류
      const existing = next.findIndex((l) => l?.hash === p);
      if (existing !== -1) {
        parentLane.set(p, existing);
        return;
      }
      if (i === 0) {
        next[nodeLane] = { hash: p, colorIdx: nodeColorIdx };
        parentLane.set(p, nodeLane);
      } else {
        const lane = firstFree(next);
        next[lane] = { hash: p, colorIdx: nextColor() };
        parentLane.set(p, lane);
      }
    });
    if (commit.parents.length === 0) next[nodeLane] = null; // 루트 커밋

    // 꼬리의 null 제거
    while (next.length && next[next.length - 1] === null) next.pop();

    // 선분 계산
    const segments: GraphRow["segments"] = [];
    // 위→(노드 또는 아래)로 이어지는 각 top 레인
    for (let j = 0; j < prev.length; j++) {
      const lane = prev[j];
      if (!lane) continue;
      if (lane.hash === commit.hash) {
        // 노드로 합류
        segments.push({ top: j, bottom: nodeLane, colorIdx: lane.colorIdx, half: "upper" });
      } else {
        // 계속 통과 — 다음 상태에서의 위치 찾기
        const k = next.findIndex((l) => l && l.hash === lane.hash && l.colorIdx === lane.colorIdx);
        if (k !== -1) segments.push({ top: j, bottom: k, colorIdx: lane.colorIdx, half: "full" });
      }
    }
    // 노드→부모 레인 (아래쪽 절반)
    for (const [p, lane] of parentLane) {
      const colorIdx = next[lane]?.colorIdx ?? nodeColorIdx;
      // 이미 통과 선분으로 그려진 부모(다른 자식과 공유)는 노드→아래만 추가
      segments.push({ top: nodeLane, bottom: lane, colorIdx, half: "lower" });
      void p;
    }

    const width = Math.max(prev.length, next.length, nodeLane + 1);
    rows.push({ commit, nodeLane, nodeColorIdx, segments, width });
    lanes = next;
  }
  return rows;
}

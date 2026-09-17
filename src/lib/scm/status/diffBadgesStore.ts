import { create } from "zustand";
import { type DiffBadge, sameBadge } from "@/lib/scm/status/diffBadges";

interface DiffBadgesStore {
  /** agentId → fork-point 대비 ±합계. 없음 = 아직 못 읽었거나 실패. */
  badges: Record<string, DiffBadge>;
  setBadge: (agentId: string, badge: DiffBadge | null) => void;
  /** 제거된 에이전트의 잔재 정리 — 폴링 루프가 한 바퀴마다 호출한다. */
  prune: (alive: ReadonlySet<string>) => void;
}

/** 메인 스토어와 분리된 휘발성 배지 상태 — 폴링마다 앱 durable 스냅샷을
 *  건드리지 않고, store.ts(충돌 1순위 파일)도 키우지 않는다. */
export const useDiffBadges = create<DiffBadgesStore>()((set) => ({
  badges: {},
  setBadge: (agentId, badge) =>
    set((s) => {
      if (badge === null) {
        if (!(agentId in s.badges)) return s;
        const next = { ...s.badges };
        delete next[agentId];
        return { badges: next };
      }
      if (sameBadge(s.badges[agentId], badge)) return s;
      return { badges: { ...s.badges, [agentId]: badge } };
    }),
  prune: (alive) =>
    set((s) => {
      const stale = Object.keys(s.badges).filter((id) => !alive.has(id));
      if (stale.length === 0) return s;
      const next = { ...s.badges };
      for (const id of stale) delete next[id];
      return { badges: next };
    }),
}));

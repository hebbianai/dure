import { create } from "zustand";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

/** attention 에피소드의 알림 분류 — 표시 상태(blocked)만으로는 승인과 단순
 *  입력 요청(input_required)을 구분할 수 없어 watcher가 전이 시점에 확정한다. */
export type AttentionEpisodeKind = "approval" | "done";

export interface AttentionBump {
  agentId: string;
  kind: AttentionEpisodeKind;
  /** Host generation/counter에서 만든 안정적 사건 id. legacy는 store seq로 폴백. */
  eventId?: string;
}

interface AgentAttentionStore {
  /** agentId → attention 에피소드 단조 시퀀스 */
  episodes: Record<string, number>;
  /** agentId → 사용자가 확인(ack)한 마지막 에피소드 시퀀스 */
  acks: Record<string, number>;
  /** agentId → 마지막 에피소드의 알림 분류 */
  episodeKinds: Record<string, AttentionEpisodeKind>;
  /** agentId → 마지막 에피소드의 정확 dedupe id */
  episodeIds: Record<string, string>;
  /** agentId → watcher가 해석한 현재 표시 상태 — dot/정렬의 단일 소스 */
  displayStates: Record<string, AgentDisplayState>;
  /** sessionId → 완료 알림 armed (사용자/위임 입력이 있었던 사이클) */
  armedCompletions: Record<string, true>;
  /** watcher 전용 — 해석 결과를 한 번의 set으로 반영한다. */
  applyAttentionResolution: (update: {
    displayStates: Record<string, AgentDisplayState>;
    bumps: readonly AttentionBump[];
    consumedArms: readonly string[];
  }) => void;
  ack: (agentId: string) => void;
  /** 사용자 키 입력·위임 입력이 세션에 들어감 — 완료 알림 1회를 arm */
  armCompletion: (sessionId: string) => void;
  prune: (aliveSessionIds: ReadonlySet<string>, aliveAgentIds: ReadonlySet<string>) => void;
}

function filterKeys<T>(record: Record<string, T>, alive: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(record).filter(([id]) => alive.has(id)));
}

/** 표시 상태·unread 에피소드용 전용 store. 세션 runtime의 진실은 Host가
 *  다시 보내며 여기에는 UI projection만 남는다.
 *  에피소드 생산자는 agentAttentionWatch 하나뿐이다 — 생산자가 여럿이면
 *  같은 턴이 이중 알림되거나 tier별 에지 감지가 어긋난다. */
export const useAgentAttention = create<AgentAttentionStore>()((set) => ({
  episodes: {},
  acks: {},
  episodeKinds: {},
  episodeIds: {},
  displayStates: {},
  armedCompletions: {},
  applyAttentionResolution: ({ displayStates, bumps, consumedArms }) =>
    set((s) => {
      const next: Partial<AgentAttentionStore> = { displayStates };
      if (bumps.length > 0) {
        const episodes = { ...s.episodes };
        const episodeKinds = { ...s.episodeKinds };
        const episodeIds = { ...s.episodeIds };
        for (const bump of bumps) {
          const episode = (episodes[bump.agentId] ?? 0) + 1;
          episodes[bump.agentId] = episode;
          episodeKinds[bump.agentId] = bump.kind;
          episodeIds[bump.agentId] =
            bump.eventId ?? `local:${bump.agentId}:${episode}`;
        }
        next.episodes = episodes;
        next.episodeKinds = episodeKinds;
        next.episodeIds = episodeIds;
      }
      if (consumedArms.length > 0) {
        const armedCompletions = { ...s.armedCompletions };
        for (const sessionId of consumedArms) delete armedCompletions[sessionId];
        next.armedCompletions = armedCompletions;
      }
      return next;
    }),
  ack: (agentId) =>
    set((s) => {
      const episode = s.episodes[agentId] ?? 0;
      if ((s.acks[agentId] ?? 0) >= episode) return s;
      return { acks: { ...s.acks, [agentId]: episode } };
    }),
  armCompletion: (sessionId) =>
    set((s) =>
      s.armedCompletions[sessionId]
        ? s
        : { armedCompletions: { ...s.armedCompletions, [sessionId]: true } },
    ),
  prune: (aliveSessionIds, aliveAgentIds) =>
    set((s) => {
      const next = {
        armedCompletions: filterKeys(s.armedCompletions, aliveSessionIds),
        episodes: filterKeys(s.episodes, aliveAgentIds),
        acks: filterKeys(s.acks, aliveAgentIds),
        episodeKinds: filterKeys(s.episodeKinds, aliveAgentIds),
        episodeIds: filterKeys(s.episodeIds, aliveAgentIds),
        displayStates: filterKeys(s.displayStates, aliveAgentIds),
      };
      const unchanged = (Object.keys(next) as (keyof typeof next)[]).every(
        (key) => Object.keys(next[key]).length === Object.keys(s[key]).length,
      );
      return unchanged ? s : next;
    }),
}));

/** agentId가 unread인가 — 에피소드 seq가 ack seq보다 크면 참. */
export function isAgentUnread(
  episodes: Record<string, number>,
  acks: Record<string, number>,
  agentId: string,
): boolean {
  return (episodes[agentId] ?? 0) > (acks[agentId] ?? 0);
}

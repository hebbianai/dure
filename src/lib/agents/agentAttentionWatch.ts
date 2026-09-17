// attention 전이의 단일 감지자 (§B-② v2).
//
// 표시 상태 해석을 에이전트별로 한 곳에서 수행하고,
// 해석 "결과"의 전이에만 isAttentionTransition을 적용해 에피소드를 만든다.
// 생산자가 하나라서: 훅 Stop과 휴리스틱 quiet-edge가 같은 턴에 이중 에피소드를
// 못 만들고(전이 없음), attention=error도 blocked 전이로 자연히 잡히고,
// attentionId 재사용/누락(dedupe 키 함정)이 아예 개입하지 않는다.
//
// 알림 분류(kind)는 전이 시점에 tier 원본(hmux.attention 등)으로 확정해
// 에피소드에 싣는다 — 전달 시점 재해석은 훅 working 힌트가 완료 알림을
// 삼키는 원인이었다.

import { useStore } from "@/store";
import {
  type AttentionBump,
  useAgentAttention,
} from "@/lib/agents/agentAttentionStore";
import {
  type AgentDisplayState,
  type AgentTierInputs,
  attentionEquivalentState,
  isAttentionTransition,
  resolveAgentDisplayFromTiers,
  UNOBSERVED_AGENT_ACTIVITY,
} from "@/lib/agents/agentStateModel";
import { managedLocalRuntimeLiveness } from "@/lib/terminal/hmuxManagedAttachConcurrency";
import { hasSessionAgentRuntimeObservation } from "@/lib/sessions/runtime/sessionRuntimeStoreSlice";

export interface AgentAttentionSource {
  agentId: string;
  sessionId: string;
  tiers: AgentTierInputs;
}

export interface AttentionResolution {
  displayStates: Record<string, AgentDisplayState>;
  bumps: AttentionBump[];
  consumedArms: string[];
  /** agentId → 마지막으로 에피소드를 만든 승인 신호 서명 (다음 라운드 입력) */
  approvalSignatures: Map<string, string>;
  /** agentId → 마지막으로 관측한 host 완료 카운터 (다음 라운드 입력) */
  turnCompletedCounts: Map<string, string>;
}

/** 순수 코어: 이전 표시 상태 + 이번 원료 → 새 표시 상태와 에피소드 목록.
 *
 *  bump 정책 (기존 UX 보존 + 결함 수정):
 *  - blocked 진입: 같은 승인 신호(서명)가 pending인 동안의 재진입(휴리스틱
 *    working 플랩)은 1회만 bump. 사용자가 입력하면(armed) 서명이 리셋돼
 *    다음 승인은 다시 알린다. kind는 hmux attention이 input_required면 done
 *    (단순 입력 요청 — 승인 아님), 그 외(approval_required/error)는
 *    approval.
 *  - host 완료 카운터(turnCompletedCount) 증가: 항상 bump (kind done) + armed
 *    소비. 표시 삼중항이 그대로인 no-op 완료(waiting→waiting)도 카운터
 *    증가로 잡힌다. blocked 전이는 별개 사건이라 그대로 bump된다. 카운터
 *    감소(새 provider epoch)는 기준선 재설정이며 에피소드가 아니다.
 *  - presentation-only working/waiting transitions never create completion.
 *  - exited 도달: 에피소드 없음 + 남은 arm 폐기 — 죽은 사이클의 arm이
 *    재접속 리플레이에서 유령 완료 알림을 만들지 않게 한다.
 *  - 첫 관측(prev 없음): 기준선만 잡는다. 단 baseline이 아닌 라운드(운영 중
 *    adopt/spawn)에 이미 blocked인 세션은 이 사용자에게 새 attention이므로
 *    bump한다.
 */
export function deriveAttentionResolution(
  previousDisplay: ReadonlyMap<string, AgentDisplayState>,
  sources: readonly AgentAttentionSource[],
  armed: Readonly<Record<string, true>>,
  options?: {
    /** watcher 설치 직후 첫 라운드 — 전부 기준선 처리 (부팅 리플레이 억제) */
    baseline?: boolean;
    /** 직전 라운드까지의 승인 신호 서명 */
    approvalSignatures?: ReadonlyMap<string, string>;
    /** 직전 라운드까지 관측한 host 완료 카운터 */
    turnCompletedCounts?: ReadonlyMap<string, string>;
  },
): AttentionResolution {
  const displayStates: Record<string, AgentDisplayState> = {};
  const bumps: AttentionBump[] = [];
  const consumedArms: string[] = [];
  const remainingArms = { ...armed };
  const approvalSignatures = new Map(options?.approvalSignatures ?? []);
  const turnCompletedCounts = new Map(options?.turnCompletedCounts ?? []);
  for (const source of sources) {
    const next = resolveAgentDisplayFromTiers(source.tiers);
    displayStates[source.agentId] = next;
    // 에피소드/서명/알림 로직은 error를 blocked와 동일 취급한다 — 표시(dot)만
    // 다르고 사건 의미는 같아, 정책 분기가 두 배로 갈라지는 것을 막는다.
    const episode = attentionEquivalentState(next);
    const prev = previousDisplay.get(source.agentId);
    // host 완료 카운터 — tier가 잠시 빠져도(관찰자 재접속) 이전 값을 유지해
    // 짧은 공백 사이의 완료를 잃지 않는다. 첫 관측은 기준선(에피소드 없음),
    // 감소(새 provider epoch)도 기준선 재설정이다.
    const reportedCount = source.tiers.hmux?.turnCompletedCount;
    const previousCount = turnCompletedCounts.get(source.agentId);
    if (reportedCount !== undefined) {
      turnCompletedCounts.set(source.agentId, reportedCount);
    }
    const completionIncrement =
      !options?.baseline &&
      reportedCount !== undefined &&
      previousCount !== undefined &&
      decimalGreaterThan(reportedCount, previousCount);
    const dropArm = () => {
      if (!remainingArms[source.sessionId]) return false;
      delete remainingArms[source.sessionId];
      consumedArms.push(source.sessionId);
      return true;
    };
    // 승인 서명 수명: 프롬프트가 해소된 상태(waiting/exited/connecting)에
    // 도달하면 리셋. working 인터루드(출력 플랩)에는 유지해 재알림을 막는다.
    if (episode !== "blocked" && episode !== "working" && episode !== "unknown") {
      approvalSignatures.delete(source.agentId);
    }
    if (episode === "exited") {
      dropArm();
      continue;
    }
    // 카운터 증가 = 턴 완료 에피소드. 훅 done 진입과 동일하게 항상 bump하고
    // armed와 무관하다 — armed는 소비만 한다(유령 완료 알림 방지용 arm 정리).
    if (completionIncrement) {
      dropArm();
      bumps.push({
        agentId: source.agentId,
        kind: "done",
        ...optionalEventId(stableHostEventId(source, "turn", reportedCount)),
      });
    }
    if (prev === undefined) {
      // 운영 중 새로 관측된 세션이 이미 승인 대기면 새 attention이다.
      if (!options?.baseline && episode === "blocked") {
        const kind =
          source.tiers.hmux?.attention === "input_required" ? "done" : "approval";
        approvalSignatures.set(source.agentId, blockedSignature(source));
        bumps.push({
          agentId: source.agentId,
          kind,
          ...optionalEventId(
            stableHostEventId(source, "attention", source.tiers.hmux?.attentionId),
          ),
        });
      }
      continue;
    }
    if (!isAttentionTransition(prev, next)) continue;
    if (episode === "blocked") {
      const kind =
        source.tiers.hmux?.attention === "input_required" ? "done" : "approval";
      const signature = blockedSignature(source);
      // 사용자 입력(armed)은 서명을 무효화한다 — 입력 후의 승인은 새 사건.
      const staleSignature =
        !remainingArms[source.sessionId] &&
        approvalSignatures.get(source.agentId) === signature;
      if (staleSignature) continue;
      approvalSignatures.set(source.agentId, signature);
      if (kind === "done") dropArm();
      bumps.push({
        agentId: source.agentId,
        kind,
        ...optionalEventId(
          stableHostEventId(source, "attention", source.tiers.hmux?.attentionId),
        ),
      });
    }
  }
  // 사라진 에이전트의 카운터 기준선 정리 — previousDisplay 청소와 같은 수명.
  for (const agentId of [...turnCompletedCounts.keys()]) {
    if (!(agentId in displayStates)) turnCompletedCounts.delete(agentId);
  }
  return {
    displayStates,
    bumps,
    consumedArms,
    approvalSignatures,
    turnCompletedCounts,
  };
}

/** u64 10진 문자열 비교 — Number 변환은 2^53 넘는 카운터에서 어긋난다.
 *  host가 u64::to_string으로 만들어 앞자리 0이 없는 canonical 형태다. */
function decimalGreaterThan(left: string, right: string): boolean {
  if (left.length !== right.length) return left.length > right.length;
  return left > right;
}

/** blocked 에피소드의 Host-owned dedupe 서명. 프롬프트 해소 시 서명이
 * 리셋되므로 epoch 간 attentionId 재사용은 문제가 되지 않는다. */
function blockedSignature(source: AgentAttentionSource): string {
  const hmux = source.tiers.hmux;
  return `hmux:${hmux?.terminalEpoch ?? "na"}:${hmux?.attention ?? "none"}:${hmux?.attentionId ?? "na"}`;
}

/** Host generation + monotonic event discriminator. 같은 replay는 같은 id이고,
 * 새 terminal epoch의 0/1 카운터는 이전 provider 사건과 충돌하지 않는다. */
function stableHostEventId(
  source: AgentAttentionSource,
  kind: "attention" | "turn",
  discriminator: string | undefined,
): string | undefined {
  const epoch = source.tiers.hmux?.terminalEpoch;
  if (!epoch || !discriminator) return undefined;
  return `hmux:${source.sessionId}:${epoch}:${kind}:${discriminator}`;
}

function optionalEventId(eventId: string | undefined): { eventId: string } | object {
  return eventId ? { eventId } : {};
}

function collectSources(): AgentAttentionSource[] {
  const st = useStore.getState();
  return st.agents.map((agent) => ({
    agentId: agent.id,
    sessionId: agent.sessionId,
    tiers: {
      heuristic: st.agentActivity[agent.id] ?? UNOBSERVED_AGENT_ACTIVITY,
      hmuxLiveness: managedLocalRuntimeLiveness(
        agent.runtimeBinding,
        st.hmuxSessionMetadata,
      ),
      hmux: st.sessionAgentRuntimeState[agent.sessionId],
      hmuxObserved: hasSessionAgentRuntimeObservation(
        st.sessionAgentRuntimeState[agent.sessionId],
        st.sessionAgentRuntimeObservers[agent.sessionId],
      ),
    },
  }));
}

/** 감지자 설치 — 모든 창에서 1회 (dot/unread는 창별 스토어). 반환값으로 해제. */
export function installAgentAttentionWatch(): () => void {
  const previousDisplay = new Map<string, AgentDisplayState>();
  let approvalSignatures: ReadonlyMap<string, string> = new Map();
  let turnCompletedCounts: ReadonlyMap<string, string> = new Map();
  let baseline = true;
  let disposed = false;

  const recompute = () => {
    if (disposed) return;
    const sources = collectSources();
    const attention = useAgentAttention.getState();
    const resolution = deriveAttentionResolution(
      previousDisplay,
      sources,
      attention.armedCompletions,
      { baseline, approvalSignatures, turnCompletedCounts },
    );
    baseline = false;
    approvalSignatures = resolution.approvalSignatures;
    turnCompletedCounts = resolution.turnCompletedCounts;
    for (const source of sources) {
      previousDisplay.set(source.agentId, resolution.displayStates[source.agentId]);
    }
    for (const agentId of [...previousDisplay.keys()]) {
      if (!(agentId in resolution.displayStates)) previousDisplay.delete(agentId);
    }
    // 변화 없으면 set 자체를 생략 — displayStates 정체성이 구독자 재렌더 신호다.
    const prevStates = attention.displayStates;
    const prevKeys = Object.keys(prevStates);
    const changed =
      resolution.bumps.length > 0 ||
      resolution.consumedArms.length > 0 ||
      prevKeys.length !== Object.keys(resolution.displayStates).length ||
      prevKeys.some((id) => prevStates[id] !== resolution.displayStates[id]);
    if (changed) {
      attention.applyAttentionResolution(resolution);
    }
  };

  const unsubStore = useStore.subscribe((state, previous) => {
    if (
      state.agents !== previous.agents ||
      state.agentActivity !== previous.agentActivity ||
      state.hmuxSessionMetadata !== previous.hmuxSessionMetadata ||
      state.sessionAgentRuntimeState !== previous.sessionAgentRuntimeState ||
      state.sessionAgentRuntimeObservers !== previous.sessionAgentRuntimeObservers
    ) {
      recompute();
    }
  });
  const unsubAttention = useAgentAttention.subscribe((state, previous) => {
    if (state.armedCompletions !== previous.armedCompletions) {
      recompute();
    }
  });
  recompute();
  return () => {
    disposed = true;
    unsubStore();
    unsubAttention();
  };
}

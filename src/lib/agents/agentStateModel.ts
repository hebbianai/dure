// 에이전트 표시 상태 모델의 순수 로직 — 결정표와 검증만.
// zustand/Tauri 없이 vitest로 검증 가능해야 한다.
//
// 중재 원칙(hmux 아키텍처 불변식):
// - Hmux 세션의 lifecycle/activity는 exact attachment로 들어온 Host 권위다.
// - agentActivity is presentation-only lifecycle evidence while an exact Host
//   projection is unavailable; it never invents semantic attention or done.

import type { AgentActivity } from "@/types";

/** 표시 상태 — 기존 AgentActivity(4종)에 input/blocked/error를 더한 상위
 * 집합. input은 정상 입력 대기, blocked는 승인 필요, error는 원인 조사다.
 * 화면에서는 구분하되 알림/에피소드 계층은 attentionEquivalentState로 같은
 * attention 계열로 취급해 기존 dedupe 계약을 보존한다. */
export type AgentDisplayState =
  | "unknown"
  | "connecting"
  | "working"
  | "error"
  | "input"
  | "blocked"
  | "waiting"
  | "exited";

/** 알림·unread 에피소드 계층의 등가 상태 — input/error는 기존 blocked
 * 에피소드 정책을 그대로 쓴다. 표시만 분리해 정상 입력 대기와 실제 승인·오류를
 * 같은 빨간 점으로 오해하지 않게 한다. */
export function attentionEquivalentState(
  state: AgentDisplayState,
): Exclude<AgentDisplayState, "error" | "input"> {
  return state === "error" || state === "input" ? "blocked" : state;
}

export type HookState = "working" | "blocked" | "waiting" | "done";

export interface HmuxStateInput {
  /** 같은 세션 재생·재접속을 가르는 Host terminal generation. */
  terminalEpoch?: string;
  lifecycle: "starting" | "running" | "exited";
  activity: "working" | "waiting";
  attention: "none" | "input_required" | "approval_required" | "error";
  /** host가 부여한 attention 식별자 — blocked 에피소드 dedupe 서명에만 쓴다 */
  attentionId?: string;
  /** Host-owned observation authority. */
  source?:
    | "provider_event"
    | "orchestration_event"
    | "controller_input"
    | "process_lifecycle";
  /** host 완료 카운터(u64 → 10진 문자열) — 증가가 곧 턴 완료 에피소드다.
   *  triple(활동/attention/lifecycle)이 그대로여도 완료를 잃지 않는다. */
  turnCompletedCount?: string;
}

export function resolveAgentState(input: {
  /** Presentation lifecycle while the Host projection is unavailable. */
  heuristic: AgentActivity;
  /** Existing exact managed Host census projection. It fences impossible
   * legacy lifecycle values; semantic Host state still owns activity. */
  hmuxLiveness?: "alive" | "exited" | "unknown";
  /** Whether a current stream substantiates the retained Host snapshot. */
  hmuxObserved?: boolean;
  hmux?: HmuxStateInput;
}): AgentDisplayState {
  const { heuristic, hmuxLiveness, hmux } = input;
  if (hmuxLiveness === "exited") return "exited";
  if (hmux?.lifecycle === "exited") return "exited";
  if (input.hmuxObserved === false) return "unknown";
  if (hmux) {
    if (hmux.lifecycle === "starting") return "connecting";
    if (hmux.activity === "working") return "working";
    if (hmux.attention === "error") return "error";
    if (hmux.attention === "input_required") return "input";
    if (hmux.attention === "approval_required") return "blocked";
    return "waiting";
  }
  const fencedHeuristic =
    hmuxLiveness === "alive" &&
    (heuristic === "exited" || heuristic === "connecting")
      ? "waiting"
      : heuristic;
  if (fencedHeuristic === "exited") return "exited";
  if (fencedHeuristic === "connecting") return "connecting";
  return fencedHeuristic;
}

export interface AgentTierInputs {
  heuristic: AgentActivity;
  hmuxLiveness?: "alive" | "exited" | "unknown";
  /** Whether a current stream substantiates the retained Host snapshot. */
  hmuxObserved?: boolean;
  hmux?: HmuxStateInput;
}

/** Legacy presentation fallback before a runtime observation lifetime exists.
 * Managed streams explicitly withdraw unavailable observations as unknown. */
export const UNOBSERVED_AGENT_ACTIVITY: AgentActivity = "exited";

/** The state a surface presents for an agent: the attention watcher's
 * projection when it has one, otherwise the presentation lifecycle the store
 * holds, otherwise the unobserved default. useAgentDisplayState, the Spaces
 * rows and native search all present through this — the fallback chain is
 * not spelled anywhere else. */
export function presentedAgentDisplayState(
  resolved: AgentDisplayState | undefined,
  activity: AgentActivity | undefined,
): AgentDisplayState {
  return resolved ?? activity ?? UNOBSERVED_AGENT_ACTIVITY;
}

/** 스토어 원료 → 표시 상태 해석의 단일 어댑터. useAgentDisplayState·Spaces·
 *  attention watcher가 전부 이걸 쓴다 — 어댑터 사본이 갈라지면 dot과 알림이
 *  같은 세션을 다르게 읽는 split-brain이 된다. */
export function resolveAgentDisplayFromTiers(input: AgentTierInputs): AgentDisplayState {
  return resolveAgentState({
    heuristic: input.heuristic,
    hmuxLiveness: input.hmuxLiveness,
    hmuxObserved: input.hmuxObserved,
    hmux: input.hmux,
  });
}

/**
 * unread 에피소드 판정: Host-owned blocked 진입만 상태 전이에서 만든다.
 * Completion is a monotonic Host counter event, not a display-state guess.
 * unread = 에피소드 seq > ack seq (단조 시퀀스 — 시계 비교 금지).
 */
export function isAttentionTransition(
  prev: AgentDisplayState | undefined,
  next: AgentDisplayState,
): boolean {
  // error↔blocked는 표시만 다른 같은 사건이다 — 전이로 세지 않는다.
  const prevEq = prev === undefined ? undefined : attentionEquivalentState(prev);
  const nextEq = attentionEquivalentState(next);
  if (prevEq === nextEq) return false;
  return nextEq === "blocked";
}

const HOOK_STATES: readonly HookState[] = ["working", "blocked", "waiting", "done"];
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ParsedHookEvent {
  sessionId: string;
  state: HookState;
  provider?: string;
  event?: string;
  /** 이 훅 설치가 종료/승인 이벤트까지 등록했다는 설치자(installer)의 선언
   *  — provider 이름 분기 대신 capability로 sticky lease를 결정한다. */
  terminalEvents: boolean;
}

/** /hooks 페이로드 검증 — enum·세션 id 형식·길이를 엄격히 제한한다.
 *  (localhost+bearer만으로 들어오는 표면이므로 여기서 한 번 더 좁힌다.) */
export function parseHookEvent(params: unknown): ParsedHookEvent | null {
  // 서버는 유효한 JSON이면 null/배열도 그대로 넘긴다 — 객체만 통과시킨다.
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const state = p.state;
  if (typeof state !== "string" || !(HOOK_STATES as readonly string[]).includes(state)) {
    return null;
  }
  // (readString: fitness 게이트의 provider-리터럴 분기 regex가 typeof 검사에
  //  오탐하지 않도록 비교식을 헬퍼로 감싼다 — 의미는 typeof 문자열 검사다.)
  const readString = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const provider = readString(p.provider)?.slice(0, 32);
  const event = readString(p.event)?.slice(0, 64);
  return {
    sessionId,
    state: state as HookState,
    provider,
    event,
    terminalEvents: p.terminalEvents === true,
  };
}

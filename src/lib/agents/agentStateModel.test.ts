import { describe, expect, it } from "vitest";
import {
  presentedAgentDisplayState,
  UNOBSERVED_AGENT_ACTIVITY,
  type AgentDisplayState,
  isAttentionTransition,
  parseHookEvent,
  resolveAgentState,
} from "@/lib/agents/agentStateModel";

describe("resolveAgentState — 결정표", () => {
  // [heuristic, Host projection, expected]
  const table: [
    string,
    Parameters<typeof resolveAgentState>[0],
    AgentDisplayState,
  ][] = [
    // Hmux Host projection이 있으면 legacy 사망/연결 휴리스틱보다 우선
    [
      "hmux working beats a stale legacy exit",
      {
        heuristic: "exited",
        hmux: { lifecycle: "running", activity: "working", attention: "none" },
      },
      "working",
    ],
    [
      "hmux waiting beats a stale legacy connecting state",
      {
        heuristic: "connecting",
        hmux: { lifecycle: "running", activity: "waiting", attention: "none" },
      },
      "waiting",
    ],
    [
      "hmux starting owns its connecting state",
      {
        heuristic: "waiting",
        hmux: { lifecycle: "starting", activity: "waiting", attention: "none" },
      },
      "connecting",
    ],
    [
      "hmux exited owns lifecycle",
      {
        heuristic: "waiting",
        hmux: { lifecycle: "exited", activity: "waiting", attention: "none" },
      },
      "exited",
    ],
    ["connecting passes through", { heuristic: "connecting" }, "connecting"],
    [
      "hmux working owns semantic activity",
      {
        heuristic: "waiting",
        hmux: { lifecycle: "running", activity: "working", attention: "none" },
      },
      "working",
    ],
    [
      "hmux approval attention → blocked",
      {
        heuristic: "waiting",
        hmux: { lifecycle: "running", activity: "waiting", attention: "approval_required" },
      },
      "blocked",
    ],
    [
      "hmux input attention → input",
      {
        heuristic: "waiting",
        hmux: { lifecycle: "running", activity: "waiting", attention: "input_required" },
      },
      "input",
    ],
    [
      // 표시 상태는 error로 분리한다(blocked=승인 필요, error=고장 — 대응이
      // 정반대). 알림/에피소드 계층은 attentionEquivalentState로 blocked 취급.
      "hmux error attention → error",
      {
        heuristic: "waiting",
        hmux: { lifecycle: "running", activity: "waiting", attention: "error" },
      },
      "error",
    ],
    [
      "hmux idle → waiting",
      {
        heuristic: "waiting",
        hmux: { lifecycle: "running", activity: "waiting", attention: "none" },
      },
      "waiting",
    ],
    // Host projection이 아직 없으면 presentation lifecycle만 사용한다.
    ["heuristic working", { heuristic: "working" }, "working"],
    ["heuristic waiting", { heuristic: "waiting" }, "waiting"],
  ];

  for (const [name, input, expected] of table) {
    it(name, () => {
      expect(resolveAgentState(input)).toBe(expected);
    });
  }
});

describe("isAttentionTransition — unread 에피소드 결정표", () => {
  const table: [AgentDisplayState | undefined, AgentDisplayState, boolean][] = [
    ["working", "input", true],
    ["working", "blocked", true],
    ["waiting", "blocked", true],
    ["working", "waiting", false], // presentation state is not completion authority
    [undefined, "waiting", false],
    ["blocked", "blocked", false], // 같은 상태 반복은 새 에피소드 아님
    ["input", "input", false],
    ["input", "blocked", false], // 표시만 다르고 같은 attention 사건
    ["blocked", "input", false],
    ["waiting", "working", false],
    ["working", "exited", false], // 종료는 별도 알림 경로
    ["working", "connecting", false],
    // error는 에피소드 계층에서 blocked와 등가 — 표시(dot 색)만 다르다.
    ["working", "error", true],
    ["blocked", "error", false], // 같은 사건의 표시 변형은 재알림 아님
    ["error", "blocked", false],
  ];
  for (const [prev, next, expected] of table) {
    it(`${prev ?? "∅"} → ${next} = ${expected}`, () => {
      expect(isAttentionTransition(prev, next)).toBe(expected);
    });
  }
});

describe("parseHookEvent — 페이로드 검증", () => {
  it("accepts a valid payload", () => {
    expect(
      parseHookEvent({
        sessionId: "agent-1.2:x_y",
        state: "done",
        provider: "claude",
        event: "Stop",
        terminalEvents: true,
      }),
    ).toEqual({
      sessionId: "agent-1.2:x_y",
      state: "done",
      provider: "claude",
      event: "Stop",
      terminalEvents: true,
    });
  });

  it("rejects non-object payloads (server forwards any valid JSON verbatim)", () => {
    expect(parseHookEvent(null)).toBeNull();
    expect(parseHookEvent("done")).toBeNull();
    expect(parseHookEvent([{ sessionId: "s", state: "done" }])).toBeNull();
    expect(parseHookEvent(42)).toBeNull();
  });

  it("rejects bad states, ids, and types", () => {
    expect(parseHookEvent({ sessionId: "s", state: "exploded" })).toBeNull();
    expect(parseHookEvent({ sessionId: "", state: "done" })).toBeNull();
    expect(parseHookEvent({ sessionId: "has space", state: "done" })).toBeNull();
    expect(parseHookEvent({ sessionId: "x".repeat(129), state: "done" })).toBeNull();
    expect(parseHookEvent({ sessionId: "s", state: 3 })).toBeNull();
    expect(parseHookEvent({ state: "done" })).toBeNull();
  });

  it("truncates oversized optional fields", () => {
    const parsed = parseHookEvent({
      sessionId: "s1",
      state: "working",
      provider: "p".repeat(100),
      event: "e".repeat(100),
    });
    expect(parsed?.provider).toHaveLength(32);
    expect(parsed?.event).toHaveLength(64);
    // terminalEvents는 boolean true만 참 — 문자열/숫자 truthy는 거부
    expect(parsed?.terminalEvents).toBe(false);
    expect(
      parseHookEvent({ sessionId: "s1", state: "working", terminalEvents: "yes" })?.terminalEvents,
    ).toBe(false);
  });
});

describe("presentedAgentDisplayState", () => {
  it("prefers the watcher's projection over the presentation lifecycle", () => {
    expect(presentedAgentDisplayState("blocked", "working")).toBe("blocked");
  });

  it("falls back to the lifecycle the store holds before the first projection", () => {
    expect(presentedAgentDisplayState(undefined, "connecting")).toBe("connecting");
  });

  it("presents an agent nobody has observed as the one unobserved default", () => {
    expect(presentedAgentDisplayState(undefined, undefined)).toBe(
      UNOBSERVED_AGENT_ACTIVITY,
    );
    expect(UNOBSERVED_AGENT_ACTIVITY).toBe("exited");
  });
});

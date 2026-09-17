import { describe, expect, it } from "vitest";
import {
  type AgentAttentionSource,
  deriveAttentionResolution,
} from "@/lib/agents/agentAttentionWatch";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

const src = (
  agentId: string,
  tiers: Partial<AgentAttentionSource["tiers"]>,
): AgentAttentionSource => ({
  agentId,
  sessionId: `sess-${agentId}`,
  tiers: { heuristic: "waiting", ...tiers },
});

const prev = (entries: Record<string, AgentDisplayState>) => new Map(Object.entries(entries));

describe("deriveAttentionResolution", () => {
  it("baselines first observation without bumping (boot replay suppression)", () => {
    const r = deriveAttentionResolution(
      new Map(),
      [
        src("a", { heuristic: "waiting" }),
        src("b", {
          heuristic: "waiting",
          hmux: { lifecycle: "running", activity: "waiting", attention: "approval_required" },
        }),
      ],
      {},
      { baseline: true },
    );
    expect(r.displayStates.a).toBe("waiting");
    expect(r.bumps).toEqual([]);
  });

  it("bumps a session adopted mid-run that is already blocked (baseline 아님)", () => {
    const r = deriveAttentionResolution(
      new Map(),
      [
        src("a", {
          heuristic: "waiting",
          hmux: { lifecycle: "running", activity: "waiting", attention: "approval_required" },
        }),
      ],
      {},
    );
    expect(r.bumps).toEqual([{ agentId: "a", kind: "approval" }]);
  });

  it("suppresses re-notify for the same pending approval across working flaps", () => {
    const pending = {
      terminalEpoch: "terminal-a",
      lifecycle: "running",
      activity: "waiting",
      attention: "approval_required",
      attentionId: "approval-a",
    } as const;
    // 승인 #1
    const first = deriveAttentionResolution(
      prev({ a: "working" }),
      [src("a", { heuristic: "waiting", hmux: pending })],
      {},
    );
    expect(first.bumps).toHaveLength(1);
    // 출력 플랩으로 working 인터루드 → 다시 blocked: 같은 서명이라 무음
    const flap = deriveAttentionResolution(
      prev({ a: "working" }),
      [src("a", { heuristic: "waiting", hmux: pending })],
      {},
      { approvalSignatures: first.approvalSignatures },
    );
    expect(flap.bumps).toEqual([]);
    // 사용자가 입력(armed)하면 서명이 무효 — 다음 승인은 새 사건
    const afterInput = deriveAttentionResolution(
      prev({ a: "working" }),
      [src("a", { heuristic: "waiting", hmux: pending })],
      { "sess-a": true },
      { approvalSignatures: first.approvalSignatures },
    );
    expect(afterInput.bumps).toHaveLength(1);
  });

  it("drops an unconsumed arm when the session exits (유령 완료 알림 방지)", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [src("a", { heuristic: "exited" })],
      { "sess-a": true },
    );
    expect(r.bumps).toEqual([]);
    expect(r.consumedArms).toEqual(["sess-a"]);
  });

  it("bumps blocked always — including hmux attention=error", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [
        src("a", {
          heuristic: "waiting",
          hmux: { lifecycle: "running", activity: "waiting", attention: "error" },
        }),
      ],
      {},
    );
    expect(r.bumps).toEqual([{ agentId: "a", kind: "approval" }]);
  });

  it("uses the Host attention id for replay-safe blocked delivery", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [
        src("a", {
          heuristic: "waiting",
          hmux: {
            terminalEpoch: "terminal-7",
            lifecycle: "running",
            activity: "waiting",
            attention: "approval_required",
            attentionId: "approval-3",
          },
        }),
      ],
      {},
    );
    expect(r.bumps).toEqual([
      {
        agentId: "a",
        kind: "approval",
        eventId: "hmux:sess-a:terminal-7:attention:approval-3",
      },
    ]);
  });

  it("classifies hmux input_required as done-kind (질문이지 승인이 아니다)", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [
        src("a", {
          heuristic: "waiting",
          hmux: { lifecycle: "running", activity: "waiting", attention: "input_required" },
        }),
      ],
      { "sess-a": true },
    );
    expect(r.displayStates.a).toBe("input");
    expect(r.bumps).toEqual([{ agentId: "a", kind: "done" }]);
    expect(r.consumedArms).toEqual(["sess-a"]);
  });

  it("provider 사건發 input_required는 그대로 알린다 (턴 사실)", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [
        src("a", {
          heuristic: "waiting",
          hmux: {
            lifecycle: "running",
            activity: "waiting",
            attention: "input_required",
            source: "provider_event",
          },
        }),
      ],
      {},
    );
    expect(r.displayStates.a).toBe("input");
    expect(r.bumps).toEqual([{ agentId: "a", kind: "done" }]);
  });

  it("does not infer completion from a presentation-only waiting transition", () => {
    const armed = deriveAttentionResolution(
      prev({ a: "working" }),
      [src("a", { heuristic: "waiting" })],
      { "sess-a": true },
    );
    expect(armed.bumps).toEqual([]);
    expect(armed.consumedArms).toEqual([]);
  });

  it("second approval in the same session bumps again (전이가 dedupe다)", () => {
    // 승인 #1 → 사용자가 승인 → working → 승인 #2: blocked→working→blocked.
    const again = deriveAttentionResolution(
      prev({ a: "working" }),
      [
        src("a", {
          heuristic: "waiting",
          hmux: { lifecycle: "running", activity: "waiting", attention: "approval_required" },
        }),
      ],
      {},
    );
    expect(again.bumps).toHaveLength(1);
    expect(again.bumps[0].kind).toBe("approval");
  });

  it("never bumps into exited (lifecycle 통지는 별도 경로)", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [src("a", { heuristic: "exited" })],
      { "sess-a": true },
    );
    expect(r.displayStates.a).toBe("exited");
    expect(r.bumps).toEqual([]);
  });
});

describe("deriveAttentionResolution — host 완료 카운터(turnCompletedCount)", () => {
  const hmuxWaiting = (turnCompletedCount?: string) =>
    ({
      lifecycle: "running",
      activity: "waiting",
      attention: "none",
      ...(turnCompletedCount === undefined ? {} : { turnCompletedCount }),
    }) as const;
  const counts = (entries: Record<string, string>) =>
    new Map(Object.entries(entries));

  it("첫 관측은 기준선 — bump 없이 카운터만 기록한다", () => {
    const r = deriveAttentionResolution(
      prev({ a: "waiting" }),
      [src("a", { hmux: hmuxWaiting("2") })],
      {},
    );
    expect(r.bumps).toEqual([]);
    expect(r.turnCompletedCounts.get("a")).toBe("2");
  });

  it("카운터 증가는 armed와 무관하게 항상 done 에피소드다 (no-op 완료 포함)", () => {
    // waiting→waiting: 표시 전이가 전혀 없어도 카운터 증가로 잡힌다.
    const r = deriveAttentionResolution(
      prev({ a: "waiting" }),
      [src("a", { hmux: hmuxWaiting("3") })],
      {},
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(r.bumps).toEqual([{ agentId: "a", kind: "done" }]);
    expect(r.turnCompletedCounts.get("a")).toBe("3");
  });

  it("Host terminal epoch와 완료 카운터로 replay-safe event id를 만든다", () => {
    const r = deriveAttentionResolution(
      prev({ a: "waiting" }),
      [
        src("a", {
          hmux: {
            ...hmuxWaiting("3"),
            terminalEpoch: "terminal-7",
          },
        }),
      ],
      {},
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(r.bumps).toEqual([
      {
        agentId: "a",
        kind: "done",
        eventId: "hmux:sess-a:terminal-7:turn:3",
      },
    ]);
  });

  it("증가 시 남은 arm을 소비한다", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [src("a", { heuristic: "working", hmux: { ...hmuxWaiting("3"), activity: "working" } })],
      { "sess-a": true },
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(r.bumps).toEqual([{ agentId: "a", kind: "done" }]);
    expect(r.consumedArms).toEqual(["sess-a"]);
  });

  it("같은 라운드의 working→waiting(armed) 전이는 카운터 에피소드가 대표한다", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [src("a", { hmux: hmuxWaiting("3") })],
      { "sess-a": true },
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    // 이중 에피소드 금지: completion event 1건만.
    expect(r.bumps).toEqual([{ agentId: "a", kind: "done" }]);
  });

  it("같은 라운드의 blocked 전이는 별개 사건으로 함께 bump된다", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [
        src("a", {
          hmux: { ...hmuxWaiting("3"), attention: "approval_required" },
        }),
      ],
      {},
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(r.bumps).toEqual([
      { agentId: "a", kind: "done" },
      { agentId: "a", kind: "approval" },
    ]);
  });

  it("변화 없음·감소(새 provider epoch)는 에피소드가 아니다 — 기준선 재설정", () => {
    const unchanged = deriveAttentionResolution(
      prev({ a: "waiting" }),
      [src("a", { hmux: hmuxWaiting("2") })],
      {},
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(unchanged.bumps).toEqual([]);
    const reset = deriveAttentionResolution(
      prev({ a: "waiting" }),
      [src("a", { hmux: hmuxWaiting("1") })],
      {},
      { turnCompletedCounts: counts({ a: "9" }) },
    );
    expect(reset.bumps).toEqual([]);
    expect(reset.turnCompletedCounts.get("a")).toBe("1");
  });

  it("자릿수가 다른 카운터도 10진 크기로 비교한다 (문자열 사전순 함정 방지)", () => {
    const r = deriveAttentionResolution(
      prev({ a: "waiting" }),
      [src("a", { hmux: hmuxWaiting("10") })],
      {},
      { turnCompletedCounts: counts({ a: "9" }) },
    );
    expect(r.bumps).toEqual([{ agentId: "a", kind: "done" }]);
  });

  it("exited에선 카운터가 늘어도 bump하지 않는다", () => {
    const r = deriveAttentionResolution(
      prev({ a: "working" }),
      [
        src("a", {
          heuristic: "exited",
          hmux: { ...hmuxWaiting("3"), lifecycle: "exited" },
        }),
      ],
      {},
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(r.bumps).toEqual([]);
  });

  it("tier가 잠시 빠져도 기준선을 유지하고, 사라진 에이전트는 정리한다", () => {
    // 관찰자 재접속 등으로 hmux tier가 한 라운드 비어도 기준선은 유지된다.
    const gap = deriveAttentionResolution(
      prev({ a: "waiting" }),
      [src("a", {})],
      {},
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(gap.turnCompletedCounts.get("a")).toBe("2");
    // 에이전트 자체가 사라지면 previousDisplay와 같은 수명으로 정리.
    const gone = deriveAttentionResolution(
      prev({ a: "waiting" }),
      [],
      {},
      { turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(gone.turnCompletedCounts.has("a")).toBe(false);
  });

  it("baseline 라운드에선 증가처럼 보여도 bump하지 않는다", () => {
    const r = deriveAttentionResolution(
      new Map(),
      [src("a", { hmux: hmuxWaiting("3") })],
      {},
      { baseline: true, turnCompletedCounts: counts({ a: "2" }) },
    );
    expect(r.bumps).toEqual([]);
    expect(r.turnCompletedCounts.get("a")).toBe("3");
  });
});

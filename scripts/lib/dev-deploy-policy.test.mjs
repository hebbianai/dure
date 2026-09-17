import { describe, expect, it } from "vitest";
import {
  DEPLOY_ACTIONS,
  DEFAULT_DEPLOY_POLICY,
  decideDevDeploy,
} from "./dev-deploy-policy.mjs";

const quiet = {
  currentHead: "aaa",
  targetHead: "bbb",
  targetAgeMs: 10 * 60_000,
  userIdleSeconds: 600,
  paneInputAgeMs: 10 * 60_000,
};

describe("decideDevDeploy", () => {
  it("이미 target이면 아무것도 하지 않는다 — 연속 landing이 배포 1회로 접히는 지점", () => {
    const decision = decideDevDeploy({ ...quiet, currentHead: "bbb" });
    expect(decision.action).toBe(DEPLOY_ACTIONS.SKIP);
  });

  it("force여도 옮길 곳이 없으면 재시작하지 않는다", () => {
    const decision = decideDevDeploy({ ...quiet, currentHead: "bbb", force: true });
    expect(decision.action).toBe(DEPLOY_ACTIONS.SKIP);
  });

  it("does not skip a selected backend action after HEAD reaches the target", () => {
    const decision = decideDevDeploy({
      ...quiet,
      currentHead: "bbb",
      force: true,
      impact: { kind: "backend_rebuild", backendChanged: true },
    });
    expect(decision.action).toBe(DEPLOY_ACTIONS.DEPLOY);
  });

  it("조용한 경계에서는 배포한다", () => {
    expect(decideDevDeploy(quiet).action).toBe(DEPLOY_ACTIONS.DEPLOY);
  });

  // 30분 사이 boot 11회를 만든 원인: 커밋마다 즉시 옮겼다.
  it("main이 방금 landing했으면 잠잠해질 때까지 미룬다", () => {
    const decision = decideDevDeploy({ ...quiet, targetAgeMs: 5_000, pendingCommits: 4 });
    expect(decision.action).toBe(DEPLOY_ACTIONS.DEFER);
    expect(decision.reason).toMatch(/coalesce/);
    expect(decision.reason).toMatch(/4 commit/);
  });

  it("사용자가 방금 타이핑했으면 미룬다", () => {
    const decision = decideDevDeploy({ ...quiet, userIdleSeconds: 3 });
    expect(decision.action).toBe(DEPLOY_ACTIONS.DEFER);
    expect(decision.reason).toMatch(/user active/);
  });

  it("pane 입력이 최근이면 미룬다 — 작업 중 세션을 끊지 않는다", () => {
    const decision = decideDevDeploy({ ...quiet, paneInputAgeMs: 2_000 });
    expect(decision.action).toBe(DEPLOY_ACTIONS.DEFER);
    expect(decision.reason).toMatch(/pane input/);
  });

  it("관측할 수 없는 신호는 배포를 막지 않는다 (null = 미지원)", () => {
    const decision = decideDevDeploy({
      currentHead: "aaa",
      targetHead: "bbb",
      targetAgeMs: null,
      userIdleSeconds: null,
      paneInputAgeMs: null,
    });
    expect(decision.action).toBe(DEPLOY_ACTIONS.DEPLOY);
  });

  // 시간이 됐다고 남의 입력을 끊는 건 이 이슈가 고치려는 바로 그 증상이다.
  it("아무리 밀려도 사용자가 활동 중이면 스스로 강제하지 않는다", () => {
    const decision = decideDevDeploy({
      ...quiet,
      userIdleSeconds: 0,
      pendingCommits: 50,
    });
    expect(decision.action).toBe(DEPLOY_ACTIONS.DEFER);
    expect(decision.reason).toMatch(/50 commit/);
  });

  it("force는 활동 중이어도 명시적 maintenance로 배포한다", () => {
    const decision = decideDevDeploy({
      ...quiet,
      userIdleSeconds: 0,
      targetAgeMs: 0,
      force: true,
    });
    expect(decision.action).toBe(DEPLOY_ACTIONS.DEPLOY);
    expect(decision.reason).toMatch(/maintenance/);
  });

  it("정책은 호출자가 항목별로 덮어쓸 수 있다", () => {
    const decision = decideDevDeploy(
      { ...quiet, targetAgeMs: 20_000 },
      { quietWindowMs: 10_000 },
    );
    expect(decision.action).toBe(DEPLOY_ACTIONS.DEPLOY);
  });

  it("head가 없으면 조용히 배포하지 않고 실패한다", () => {
    expect(() => decideDevDeploy({ currentHead: "aaa" })).toThrow(/currentHead and targetHead/);
    expect(() => decideDevDeploy({ targetHead: "bbb" })).toThrow(/currentHead and targetHead/);
  });

  it("기본 정책은 버스트를 실제로 덮을 만큼 넓다", () => {
    // 오늘 밤 실측: 커밋이 2~3분 간격으로 연달아 들어왔다.
    expect(DEFAULT_DEPLOY_POLICY.quietWindowMs).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_DEPLOY_POLICY.minUserIdleSeconds).toBeGreaterThanOrEqual(30);
  });
});

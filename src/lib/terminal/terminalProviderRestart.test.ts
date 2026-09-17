import { describe, expect, it } from "vitest";
import {
  type ProviderRowActionDeps,
  restartProviderRow,
  switchProviderRowAccount,
} from "@/lib/terminal/terminalProviderRestart";

function deps() {
  const calls: string[] = [];
  const value: ProviderRowActionDeps = {
    requestAgentRestart: (id) => calls.push(`restart-agent:${id}`),
    switchAgentCredential: async (id, accountId, panelId) => {
      calls.push(`agent-credential:${id}:${accountId}:${panelId}`);
    },
    setActiveAccount: (provider, accountId) =>
      calls.push(`active-account:${provider}:${accountId ?? "null"}`),
  };
  return { value, calls };
}

describe("restartProviderRow", () => {
  it("등록 에이전트는 세션을 다시 만든다", async () => {
    const d = deps();
    await restartProviderRow(
      { key: "agent:a1", agentId: "a1", provider: "claude", sessionId: "s1", kind: "agent" },
      d.value,
    );
    expect(d.calls).toEqual(["restart-agent:a1"]);
  });

  it("등록 레코드가 없는 행은 재시작 authority가 없다", async () => {
    // legacy 키 시퀀스 재시작은 데몬 은퇴(2026-08-16)와 함께 제거됐다.
    const d = deps();
    expect(
      await restartProviderRow(
        { key: "pane-terminal", provider: "claude", sessionId: "s1", kind: "term" },
        d.value,
      ),
    ).toBe(false);
    expect(d.calls).toEqual([]);
  });
});

describe("switchProviderRowAccount", () => {
  it("에이전트는 실행 중 runtime의 credential을 전환한다", async () => {
    const d = deps();
    await switchProviderRowAccount(
      { key: "agent:a1", agentId: "a1", provider: "claude", kind: "agent" },
      "acc",
      d.value,
    );
    expect(d.calls).toEqual(["agent-credential:a1:acc:agent:a1"]);
  });

  it.each(["pane-neutral", "launcher:historical", "agent:someone-else"])(
    "keeps the actual pane %s separate from its Agent target",
    async (key) => {
      const d = deps();
      await switchProviderRowAccount(
        { key, agentId: "a1", provider: "claude", kind: "agent" }, "acc", d.value,
      );
      expect(d.calls).toEqual([`agent-credential:a1:acc:${key}`]);
    },
  );

  it("터미널은 프로바이더의 활성 계정을 바꾼다 — 세션별 계정 개념이 없다", async () => {
    const d = deps();
    await switchProviderRowAccount(
      { key: "pane-terminal", provider: "claude", sessionId: "s1", kind: "term" },
      "acc",
      d.value,
    );
    expect(d.calls).toEqual(["active-account:claude:acc"]);
  });

  it("'기본'(null)은 활성 계정을 비운다", async () => {
    const d = deps();
    await switchProviderRowAccount(
      { key: "pane-terminal", provider: "claude", sessionId: "s1", kind: "term" },
      null,
      d.value,
    );
    expect(d.calls).toEqual(["active-account:claude:null"]);
  });
});

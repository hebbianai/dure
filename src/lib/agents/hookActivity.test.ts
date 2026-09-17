import { beforeEach, describe, expect, it } from "vitest";
import { handleActivity } from "@/lib/agents/hookActivity";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

function managedAgent(): Agent {
  return agentFixture({
    name: "codex-1",
    projectId: "workspace-1",
    worktreePath: "/repo/worktree",
    branch: "agent/codex-1",
    sessionId: "managed-1",
    runtimeBinding: managedBindingFixture({
      sessionId: "managed-1",
      createIdempotencyKey: undefined,
    }),
  });
}

beforeEach(() => {
  useStore.setState({
    agents: [managedAgent()],
    sessionActivity: {},
    sessionAgentPin: {},
  });
});

describe("hook activity wiring", () => {
  it("records prompt presentation without owning conversation identity", () => {
    handleActivity({
      sessionId: "managed-1",
      provider: "codex",
      text: "재부팅 복구 구현",
      conversationId: "conversation-safe:1",
    });

    const state = useStore.getState();
    expect(state.agents[0].conversationId).toBeUndefined();
    expect(state.sessionActivity["managed-1"]?.text).toBe("재부팅 복구 구현");
    expect(state.sessionAgentPin["managed-1"]).toBe("codex");
  });

  it("does not turn fenced activity into a second identity writer", () => {
    handleActivity({
      sessionId: "managed-1",
      provider: "codex",
      text: "fenced activity",
      conversationId: "conversation-fenced",
      sessionFence: {
        sessionId: "managed-1",
        workspaceId: "workspace-1",
        runnerPrincipal: "local-user",
        runnerInstance: "runner-1",
        channelEpoch: "1",
        hostInstanceId: "host-1",
        terminalEpoch: "terminal-1",
      },
    });

    expect(useStore.getState().agents[0].conversationId).toBeUndefined();
    expect(useStore.getState().sessionActivity["managed-1"]?.text).toBe(
      "fenced activity",
    );
  });
});

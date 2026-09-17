import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRemovalDialogSnapshot,
  closeAgentRemovalDialog,
  openAgentRemovalDialog,
  subscribeAgentRemovalDialog,
} from "@/lib/agents/agentRemovalDialog";
import type { Agent } from "@/types";

const agent: Agent = {
  id: "agent-1",
  name: "codex-1",
  provider: "codex",
  projectId: "project-1",
  worktreePath: "/repo/.worktrees/codex-1",
  branch: "agent/codex-1",
  sessionId: "session-1",
  sessionKind: "pty",
};

beforeEach(() => {
  const current = agentRemovalDialogSnapshot();
  if (current) closeAgentRemovalDialog(current.requestId);
});

describe("agentRemovalDialog", () => {
  it("keeps an agent snapshot until the matching app-level dialog closes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentRemovalDialog(listener);

    openAgentRemovalDialog(agent);
    const opened = agentRemovalDialogSnapshot();

    expect(opened?.agent).toEqual(agent);
    expect(opened?.agent).not.toBe(agent);
    expect(listener).toHaveBeenCalledOnce();

    closeAgentRemovalDialog((opened?.requestId ?? 0) + 1);
    expect(agentRemovalDialogSnapshot()).toBe(opened);

    closeAgentRemovalDialog(opened?.requestId ?? 0);
    expect(agentRemovalDialogSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

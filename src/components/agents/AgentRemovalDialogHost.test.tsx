// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/types";

vi.mock("@/components/agents/KillAgentDialog", () => ({
  KillAgentDialog: ({
    agent,
    onClose,
  }: {
    agent: Agent;
    onClose: () => void;
  }) => <button type="button" onClick={onClose}>remove:{agent.id}</button>,
}));

import { AgentRemovalDialogHost } from "@/components/agents/AgentRemovalDialogHost";
import {
  agentRemovalDialogSnapshot,
  closeAgentRemovalDialog,
  openAgentRemovalDialog,
} from "@/lib/agents/agentRemovalDialog";

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

afterEach(() => {
  cleanup();
});

describe("AgentRemovalDialogHost", () => {
  it("owns the dialog independently of the pane that opened it", () => {
    render(<AgentRemovalDialogHost />);

    act(() => openAgentRemovalDialog(agent));
    fireEvent.click(screen.getByRole("button", { name: "remove:agent-1" }));

    expect(agentRemovalDialogSnapshot()).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

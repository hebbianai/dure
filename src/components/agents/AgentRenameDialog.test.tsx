// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRenameDialog } from "@/components/agents/AgentRenameDialog";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const agent: Agent = {
  id: "agent-1",
  name: "agent-1",
  provider: "codex",
  projectId: "project-1",
  worktreePath: "/repo/.worktrees/agent-1",
  branch: "agent/agent-1",
  sessionId: "session-1",
  sessionKind: "pty",
  displayName: "Reviewer",
};

afterEach(() => {
  cleanup();
});

describe("AgentRenameDialog", () => {
  it("prefills the current display name and falls back to the canonical name", () => {
    render(<AgentRenameDialog agent={agent} open onOpenChange={() => {}} />);

    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect(input.value).toBe("Reviewer");
    expect(input.placeholder).toBe("agent-1");
  });

  it("saves through renameAgentDisplayName and closes", () => {
    useStore.setState({ agents: [agent] });
    let open = true;
    render(
      <AgentRenameDialog
        agent={agent}
        open
        onOpenChange={(next) => {
          open = next;
        }}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Landing pilot  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(useStore.getState().agents[0]?.displayName).toBe("Landing pilot");
    expect(open).toBe(false);
  });
});

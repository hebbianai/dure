// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetectedWorktreeRow } from "@/components/spaces/DetectedWorktreeRow";
import type { DetectedWorktreeSession } from "@/lib/spaces/detectedWorktreeSessions";

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));

const candidate: DetectedWorktreeSession = {
  projectId: "project-1",
  projectName: "app",
  projectKind: "local",
  name: "fresh",
  provider: "claude",
  lastActivityAt: Date.now(),
  worktree: {
    path: "/repo/.worktrees/fresh",
    branch: "agent/fresh",
    isMain: false,
    claudeSessions: 2,
    claudeLastTs: Date.now(),
    codexSessions: 1,
    codexLastTs: Date.now() - 1000,
  },
};

describe("DetectedWorktreeRow", () => {
  it("resumes the recommended provider on click and exposes explicit provider choices", async () => {
    const onAdopt = vi.fn().mockResolvedValue(undefined);
    const onHide = vi.fn();
    render(
      <DetectedWorktreeRow
        candidate={candidate}
        onAdopt={onAdopt}
        onHide={onHide}
      />,
    );

    fireEvent.click(screen.getByText("fresh"));
    await waitFor(() => expect(onAdopt).toHaveBeenCalledWith(candidate, "claude"));

    onAdopt.mockClear();
    fireEvent.pointerDown(screen.getByRole("button", { name: "이어받기 옵션" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText("Codex로 이어받기"));
    await waitFor(() => expect(onAdopt).toHaveBeenCalledWith(candidate, "codex"));

    fireEvent.pointerDown(screen.getByRole("button", { name: "이어받기 옵션" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText("목록에서 숨기기"));
    expect(onHide).toHaveBeenCalledWith(candidate);
  });
});

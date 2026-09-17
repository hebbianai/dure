import { describe, expect, it } from "vitest";
import {
  detectedWorktreeProvider,
  selectDetectedWorktreeSessions,
} from "@/lib/spaces/detectedWorktreeSessions";

const projects = [
  { id: "local", name: "app", path: "/repo", kind: "local" as const, isRepo: true },
  {
    id: "remote",
    name: "remote-app",
    path: "/repo",
    kind: "ssh" as const,
    sshHostId: "host-1",
    isRepo: true,
  },
  { id: "folder", name: "notes", path: "/notes", kind: "local" as const, isRepo: false },
];

describe("detected worktree sessions", () => {
  it("shows only unregistered external worktrees and keeps equal paths on different locations distinct", () => {
    const sessions = selectDetectedWorktreeSessions({
      projects,
      detected: {
        local: [
          {
            path: "/repo/.worktrees/taken",
            branch: "agent/taken",
            isMain: false,
            claudeSessions: 1,
            codexSessions: 0,
            claudeLastTs: 10,
          },
          {
            path: "/repo/.worktrees/fresh",
            branch: "agent/fresh",
            isMain: false,
            claudeSessions: 1,
            codexSessions: 2,
            claudeLastTs: 20,
            codexLastTs: 30,
          },
          {
            path: "/repo",
            branch: "main",
            isMain: true,
            claudeSessions: 3,
            codexSessions: 0,
          },
        ],
        remote: [
          {
            path: "/repo/.worktrees/taken",
            branch: "agent/remote",
            isMain: false,
            claudeSessions: 0,
            codexSessions: 1,
            codexLastTs: 40,
          },
        ],
      },
      agents: [
        {
          projectId: "local",
          worktreePath: "/repo/.worktrees/taken",
        },
      ],
    });

    expect(sessions.map((session) => [session.projectId, session.name])).toEqual([
      ["remote", "taken"],
      ["local", "fresh"],
    ]);
    expect(sessions[1]).toMatchObject({
      provider: "codex",
      lastActivityAt: 30,
    });
  });

  it("searches location, path, branch, and provider evidence", () => {
    const detected = {
      remote: [
        {
          path: "/repo/.worktrees/payments",
          branch: "agent/billing",
          isMain: false,
          claudeSessions: 0,
          codexSessions: 1,
        },
      ],
    };
    const input = { projects, detected, agents: [] };

    expect(selectDetectedWorktreeSessions({ ...input, query: "remote-app" })).toHaveLength(1);
    expect(selectDetectedWorktreeSessions({ ...input, query: "billing" })).toHaveLength(1);
    expect(selectDetectedWorktreeSessions({ ...input, query: "codex" })).toHaveLength(1);
    expect(selectDetectedWorktreeSessions({ ...input, query: "claude" })).toHaveLength(0);
  });

  it("recommends the provider with the newest evidence", () => {
    expect(
      detectedWorktreeProvider({
        path: "/repo/.worktrees/a",
        branch: "a",
        isMain: false,
        claudeSessions: 2,
        codexSessions: 1,
        claudeLastTs: 50,
        codexLastTs: 40,
      }),
    ).toBe("claude");
  });
});

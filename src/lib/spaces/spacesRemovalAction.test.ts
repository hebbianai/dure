import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import {
  planSpacesRemoval,
  spacesRemovalConfirmMessage,
} from "@/lib/spaces/spacesRemovalAction";

describe("planSpacesRemoval", () => {
  it("routes one registered agent through the resource removal dialog", () => {
    expect(
      planSpacesRemoval([
        {
          panelId: "agent:agent-1",
          desktopId: "desktop-1",
          kind: "agent",
          agentId: "agent-1",
        },
      ]),
    ).toEqual({
      kind: "agent-dialog",
      agentId: "agent-1",
      items: [{ panelId: "agent:agent-1", desktopId: "desktop-1" }],
    });
  });

  it("keeps multi-selection on the bulk session termination path", () => {
    expect(
      planSpacesRemoval([
        {
          panelId: "agent:agent-1",
          desktopId: "desktop-1",
          kind: "agent",
          agentId: "agent-1",
        },
        {
          panelId: "agent:agent-2",
          desktopId: "desktop-1",
          kind: "agent",
          agentId: "agent-2",
        },
      ]),
    ).toEqual({
      kind: "sessions",
      items: [
        { panelId: "agent:agent-1", desktopId: "desktop-1" },
        { panelId: "agent:agent-2", desktopId: "desktop-1" },
      ],
      agentCount: 2,
    });
  });

  it("counts registered agents in a bulk termination so the confirm can state its scope", () => {
    const intent = planSpacesRemoval([
      {
        panelId: "agent:agent-1",
        desktopId: "desktop-1",
        kind: "agent",
        agentId: "agent-1",
      },
      { panelId: "term:1", desktopId: "desktop-1", kind: "term" },
      // Agent-shaped but unregistered — no registration/worktree to speak of.
      { panelId: "agent:missing", desktopId: "desktop-1", kind: "agent" },
    ]);
    expect(intent.kind).toBe("sessions");
    expect(intent.kind === "sessions" && intent.agentCount).toBe(1);
  });

  it("does not treat an unregistered agent-shaped row or terminal as owned resources", () => {
    expect(
      planSpacesRemoval([
        {
          panelId: "agent:missing",
          desktopId: "desktop-1",
          kind: "agent",
        },
      ]).kind,
    ).toBe("sessions");
    expect(
      planSpacesRemoval([
        {
          panelId: "term:1",
          desktopId: "desktop-1",
          kind: "term",
        },
      ]).kind,
    ).toBe("sessions");
  });
});

describe("spacesRemovalConfirmMessage", () => {
  const items = [
    { panelId: "agent:agent-1", desktopId: "desktop-1" },
    { panelId: "term:1", desktopId: "desktop-1" },
  ];

  it("states that agent registrations and worktrees survive a mixed pane kill", () => {
    const message = spacesRemovalConfirmMessage({
      kind: "sessions",
      items,
      agentCount: 1,
    });
    expect(message).toContain(t("spaces.kill.confirmMany", { n: 2 }));
    expect(message).toContain(t("spaces.kill.agentsKeepRegistration"));
  });

  it("keeps the plain confirmation when no registered agent is in scope", () => {
    expect(
      spacesRemovalConfirmMessage({ kind: "sessions", items, agentCount: 0 }),
    ).toBe(t("spaces.kill.confirmMany", { n: 2 }));
    expect(
      spacesRemovalConfirmMessage({
        kind: "sessions",
        items: items.slice(1),
        agentCount: 0,
      }),
    ).toBe(t("spaces.kill.confirmOne"));
  });
});

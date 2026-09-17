import { describe, expect, it } from "vitest";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { terminalSessionsFromLayout } from "@/lib/workspace/layout/terminalSessionRefs";

const legacyLocalBinding = (sessionId: string) =>
  ({
    schemaVersion: 1,
    runtime: "legacy_session_v1",
    source: "local",
    hostId: "local",
    sessionId,
  }) as unknown as TerminalPaneBindingV1;

describe("terminalSessionsFromLayout", () => {
  it("takes current content and session references independently of the pane ID", () => {
    const binding = hmuxStandaloneBinding("current", "workspace-1");
    expect(
      terminalSessionsFromLayout({
        panels: {
          "agent:old": {
            contentComponent: "terminal",
            params: { sessionId: "current", binding },
          },
          "pane:opaque": {
            contentComponent: "ssh", params: { sessionId: "remote" },
          },
          "term:old": {
            contentComponent: "agent", params: { sessionId: "stale" },
          },
          "ssh:old": {
            contentComponent: "launcher", params: { sessionId: "stale" },
          },
          "term:extension": {
            contentComponent: "extension-view", params: { sessionId: "stale" },
          },
        },
      }),
    ).toEqual([
      { panelId: "agent:old", kind: "pty", sessionId: "current", persistent: true },
      { panelId: "pane:opaque", kind: "ssh", sessionId: "remote", persistent: false },
    ]);
  });

  it("does not invent a session target from the pane ID when the current content has none", () => {
    expect(
      terminalSessionsFromLayout({
        panels: {
          "term:not-a-session": { contentComponent: "terminal", params: {} },
          "pane:opaque": { contentComponent: "terminal", params: {} },
          "term:unobserved": { params: { sessionId: "unobserved" } },
        },
      }),
    ).toEqual([]);
  });

  it("marks Hmux bindings persistent while leaving legacy sessions owned", () => {
    expect(
      terminalSessionsFromLayout({
        panels: {
          "term:legacy": {
            contentComponent: "terminal",
            params: {
              sessionId: "legacy",
              binding: legacyLocalBinding("legacy"),
            },
          },
          "term:hmux": {
            contentComponent: "terminal",
            params: {
              sessionId: "hmux",
              binding: hmuxStandaloneBinding("hmux", "workspace-1"),
            },
          },
          "term:managed": {
            contentComponent: "terminal",
            params: {
              sessionId: "managed",
              binding: hmuxManagedBinding("managed", "workspace-1"),
            },
          },
        },
      }),
    ).toEqual([
      {
        kind: "pty",
        sessionId: "legacy",
        panelId: "term:legacy",
        persistent: false,
      },
      {
        kind: "pty",
        sessionId: "hmux",
        panelId: "term:hmux",
        persistent: true,
      },
      {
        kind: "pty",
        sessionId: "managed",
        panelId: "term:managed",
        persistent: true,
      },
    ]);
  });
});

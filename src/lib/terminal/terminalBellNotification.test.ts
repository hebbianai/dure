import { describe, expect, it, vi } from "vitest";
import {
  createTerminalBellNotificationHandler,
  shouldDeliverTerminalBellNotification,
} from "@/lib/terminal/terminalBellNotification";

const enabledBell = {
  enabled: true,
  suppressWhenVisible: false,
  terminalBell: true,
  visible: false,
} as const;

describe("terminal bell notification policy", () => {
  it("suppresses generic BEL notifications for provider TUIs", () => {
    expect(
      shouldDeliverTerminalBellNotification({
        ...enabledBell,
        provider: "claude",
      }),
    ).toBe(false);
    expect(
      shouldDeliverTerminalBellNotification({
        ...enabledBell,
        provider: "codex",
      }),
    ).toBe(false);
  });

  it("keeps configured BEL notifications for ordinary shell terminals", () => {
    expect(shouldDeliverTerminalBellNotification(enabledBell)).toBe(true);
    expect(
      shouldDeliverTerminalBellNotification({
        ...enabledBell,
        suppressWhenVisible: true,
        visible: true,
      }),
    ).toBe(false);
    expect(
      shouldDeliverTerminalBellNotification({
        ...enabledBell,
        terminalBell: false,
      }),
    ).toBe(false);
  });

  it("resolves registered providers at delivery time", () => {
    const notify = vi.fn();
    const state = {
      notifyPrefs: enabledBell,
      agents: [{ sessionId: "agent-session", provider: "codex" as const }],
      sessionAgentPin: {},
      sessionAgent: {},
      sessionTitle: {},
    };
    const deliver = createTerminalBellNotificationHandler({
      sessionId: "agent-session",
      getState: () => state,
      isVisible: () => false,
      notify,
      translate: (source) => source,
    });

    deliver();

    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the Agent provider authoritative while rehost joins lag", () => {
    const notify = vi.fn();
    const deliver = createTerminalBellNotificationHandler({
      sessionId: "replacement-session",
      providerHint: "claude",
      getState: () => ({
        notifyPrefs: enabledBell,
        agents: [],
        sessionAgentPin: {},
        sessionAgent: {},
        sessionTitle: {},
      }),
      isVisible: () => false,
      notify,
      translate: (source) => source,
    });

    deliver();

    expect(notify).not.toHaveBeenCalled();
  });

  it("delivers ordinary terminal bells with their title and debounces bursts", () => {
    const notify = vi.fn();
    let currentTime = 100;
    const deliver = createTerminalBellNotificationHandler({
      sessionId: "shell-session",
      getState: () => ({
        notifyPrefs: enabledBell,
        agents: [],
        sessionAgentPin: {},
        sessionAgent: {},
        sessionTitle: { "shell-session": " Build logs " },
      }),
      isVisible: () => false,
      notify,
      translate: (source) => source,
      now: () => currentTime,
    });

    deliver();
    currentTime += 2999;
    deliver();
    currentTime += 1;
    deliver();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith("Build logs", "terminal.bell.rang");
  });
});

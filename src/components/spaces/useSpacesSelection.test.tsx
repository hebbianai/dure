// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent } from "react";
import { useSpacesSelection } from "@/components/spaces/useSpacesSelection";
import type { SpaceRow } from "@/components/spaces/useSpaces";
import { t } from "@/lib/i18n";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => {
  const agent = { id: "agent-1" } as Agent;
  const state = {
    addSpace: vi.fn(),
    agents: [agent],
  };
  return {
    agent,
    state,
    confirmDialog: vi.fn(),
    killPanels: vi.fn(),
    movePanelsToDesktop: vi.fn(),
    requestAgentCredentialTransition: vi.fn(),
  };
});

vi.mock("@/store", () => {
  const useStore = Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  );
  return { useStore };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  confirm: mocks.confirmDialog,
  message: vi.fn(),
}));

vi.mock("@/lib/workspace/dock/openScmPanel", () => ({
  openSessionDiffPanel: vi.fn(),
}));
vi.mock("@/lib/workspace/dock", () => ({
  movePanelsToDesktop: mocks.movePanelsToDesktop,
  openAgentPanel: vi.fn(),
}));
vi.mock("@/lib/agents/agentCredentialTransition", () => ({
  requestAgentCredentialTransition: mocks.requestAgentCredentialTransition,
}));
vi.mock("@/lib/workspace/pane/paneCloseCoordinator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/pane/paneCloseCoordinator")>()),
  killPanels: mocks.killPanels,
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/dock/panelFocusHandoff")>()),
  navigateToPanel: vi.fn(),
}));

describe("useSpacesSelection agent removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockReset();
    mocks.killPanels.mockReset();
    mocks.state.agents = [mocks.agent];
    mocks.requestAgentCredentialTransition.mockResolvedValue({
      kind: "completed", conversationId: "conversation-1",
    });
  });

  it.each(["pane-neutral", "launcher:historical", "agent:agent-1"])(
    "passes the selected %s row to credential switching without recreating its ID",
    async (key) => {
      const space = {
        key, desktopId: "desktop-1", sessionId: "session-1",
        kind: "agent", agentId: "agent-1", managedPromotion: "hidden",
      } as SpaceRow;
      const hook = renderHook(() => useSpacesSelection({
        spaces: [space], selectionOrder: [key], diffCapabilities: new Map(),
        probeDiffCapability: vi.fn(), onRequestAgentRemoval: vi.fn(),
      }));
      await act(async () => {
        hook.result.current.menuHandlers.onSwitchAccount(key, "account-selected");
      });
      expect(mocks.requestAgentCredentialTransition).toHaveBeenCalledExactlyOnceWith({
        agentId: space.agentId, targetCredentialId: "account-selected", sourcePanelId: key,
      });
      expect(mocks.killPanels).not.toHaveBeenCalled();
    },
  );

  it("opens the resource-aware agent dialog instead of the generic session confirmation", async () => {
    const space = {
      key: "agent:agent-1",
      desktopId: "desktop-1",
      sessionId: "session-1",
      kind: "agent",
      agentId: "agent-1",
      managedPromotion: "hidden",
    } as SpaceRow;
    const onRequestAgentRemoval = vi.fn();
    const hook = renderHook(() =>
      useSpacesSelection({
        spaces: [space],
        selectionOrder: [space].map((row) => row.key),
        diffCapabilities: new Map(),
        probeDiffCapability: vi.fn(),
        onRequestAgentRemoval,
      }),
    );

    await act(async () => {
      await hook.result.current.menuHandlers.onKill(space.key);
    });

    expect(onRequestAgentRemoval).toHaveBeenCalledOnce();
    expect(onRequestAgentRemoval).toHaveBeenCalledWith(mocks.agent);
    expect(hook.result.current.killConfirm).toBeNull();
    expect(mocks.killPanels).not.toHaveBeenCalled();
  });

  it("falls back to session termination if the registered agent disappeared", async () => {
    const space = {
      key: "agent:agent-1",
      desktopId: "desktop-1",
      sessionId: "session-1",
      kind: "agent",
      agentId: "agent-1",
      managedPromotion: "hidden",
    } as SpaceRow;
    const onRequestAgentRemoval = vi.fn();
    mocks.state.agents = [];
    mocks.killPanels.mockResolvedValue({ failed: [] });
    const hook = renderHook(() =>
      useSpacesSelection({
        spaces: [space],
        selectionOrder: [space].map((row) => row.key),
        diffCapabilities: new Map(),
        probeDiffCapability: vi.fn(),
        onRequestAgentRemoval,
      }),
    );

    await act(async () => {
      await hook.result.current.menuHandlers.onKill(space.key);
    });

    // The menu action only arms the in-place confirm (SOUL §6) — nothing is
    // killed until the row's own destructive action runs.
    expect(onRequestAgentRemoval).not.toHaveBeenCalled();
    expect(hook.result.current.killConfirm?.anchorKey).toBe(space.key);
    expect(mocks.killPanels).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.confirmKill();
    });

    expect(mocks.killPanels).toHaveBeenCalledWith([
      { panelId: space.key, desktopId: space.desktopId },
    ]);
    expect(hook.result.current.killConfirm).toBeNull();
  });

  it("cancelling the in-place confirm kills nothing and disarms", async () => {
    const space = {
      key: "term:1",
      desktopId: "desktop-1",
      sessionId: "session-1",
      kind: "term",
      managedPromotion: "hidden",
    } as SpaceRow;
    const hook = renderHook(() =>
      useSpacesSelection({
        spaces: [space],
        selectionOrder: [space].map((row) => row.key),
        diffCapabilities: new Map(),
        probeDiffCapability: vi.fn(),
        onRequestAgentRemoval: vi.fn(),
      }),
    );

    await act(async () => {
      await hook.result.current.menuHandlers.onKill(space.key);
    });
    expect(hook.result.current.killConfirm?.anchorKey).toBe(space.key);

    act(() => {
      hook.result.current.cancelKillConfirm();
    });

    expect(hook.result.current.killConfirm).toBeNull();
    expect(mocks.killPanels).not.toHaveBeenCalled();
  });

  it("spells out the narrower agent destruction scope in a mixed bulk kill", async () => {
    const agentSpace = {
      key: "agent:agent-1",
      desktopId: "desktop-1",
      sessionId: "session-1",
      kind: "agent",
      agentId: "agent-1",
      managedPromotion: "hidden",
    } as SpaceRow;
    const termSpace = {
      key: "term:1",
      desktopId: "desktop-1",
      sessionId: "session-2",
      kind: "term",
      managedPromotion: "hidden",
    } as SpaceRow;
    const hook = renderHook(() =>
      useSpacesSelection({
        spaces: [agentSpace, termSpace],
        selectionOrder: [agentSpace, termSpace].map((row) => row.key),
        diffCapabilities: new Map(),
        probeDiffCapability: vi.fn(),
        onRequestAgentRemoval: vi.fn(),
      }),
    );
    const metaClick = { metaKey: true, preventDefault: () => {} } as MouseEvent;
    act(() => {
      hook.result.current.onSpaceClick(metaClick, agentSpace.key, "desktop-1");
    });
    act(() => {
      hook.result.current.onSpaceClick(metaClick, termSpace.key, "desktop-1");
    });

    await act(async () => {
      await hook.result.current.menuHandlers.onKill(termSpace.key);
    });

    const message = hook.result.current.killConfirm?.question ?? "";
    expect(message).toContain(t("spaces.kill.confirmMany", { n: 2 }));
    expect(message).toContain(t("spaces.kill.agentsKeepRegistration"));
    expect(mocks.killPanels).not.toHaveBeenCalled();
  });

  it("moves the whole selection to a specific desktop, skipping rows already there", async () => {
    const first = {
      key: "term:1",
      desktopId: "desktop-1",
      sessionId: "session-1",
      kind: "term",
      managedPromotion: "hidden",
    } as SpaceRow;
    const second = {
      key: "term:2",
      desktopId: "desktop-2",
      sessionId: "session-2",
      kind: "term",
      managedPromotion: "hidden",
    } as SpaceRow;
    const hook = renderHook(() =>
      useSpacesSelection({
        spaces: [first, second],
        selectionOrder: [first, second].map((row) => row.key),
        diffCapabilities: new Map(),
        probeDiffCapability: vi.fn(),
        onRequestAgentRemoval: vi.fn(),
      }),
    );
    const metaClick = { metaKey: true, preventDefault: () => {} } as MouseEvent;
    act(() => {
      hook.result.current.onSpaceClick(metaClick, first.key, "desktop-1");
    });
    act(() => {
      hook.result.current.onSpaceClick(metaClick, second.key, "desktop-2");
    });

    await act(async () => {
      await hook.result.current.menuHandlers.onMoveToDesktop(
        first.key,
        "desktop-2",
      );
    });

    // 드래그 드롭과 같은 의미 — 대상에 이미 있는 행은 이동 목록에서 빠진다.
    expect(mocks.movePanelsToDesktop).toHaveBeenCalledOnce();
    expect(mocks.movePanelsToDesktop).toHaveBeenCalledWith(
      [{ panelId: first.key, fromDesktopId: "desktop-1" }],
      "desktop-2",
    );
    expect(hook.result.current.selected.size).toBe(0);

    mocks.movePanelsToDesktop.mockClear();
    await act(async () => {
      await hook.result.current.menuHandlers.onMoveToDesktop(
        second.key,
        "desktop-2",
      );
    });
    // 전부 이미 대상에 있으면 이동 자체가 없다.
    expect(mocks.movePanelsToDesktop).not.toHaveBeenCalled();
  });
});

import type { DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDockview, unregisterDockview } from "@/lib/workspace/dock/dockRegistry";
import {
  applyPendingPanelFocus,
  navigateToPanel,
  peekPendingPanelFocus,
} from "@/lib/workspace/dock/panelFocusHandoff";
import { currentPaneContentFocus } from "@/lib/workspace/pane/paneContentFocusHandoff";
import { useStore } from "@/store";

/** visibility 복원과 setActive 호출을 관측하는 최소 dockview. */
function fakeDockview(panelIds: readonly string[]) {
  const setActive = vi.fn();
  const setVisible = vi.fn();
  const focus = vi.fn();
  const ownerDocument = {
    activeElement: null,
    addEventListener: vi.fn(),
  } as unknown as Document;
  const group = {
    api: { setVisible },
    element: { contains: () => false } as unknown as HTMLElement,
    panels: [] as unknown[],
  };
  const panelApi = {
    setActive,
    getWindow: () => ({ document: ownerDocument }) as Window,
    group,
  };
  const panel = { api: panelApi, group };
  group.panels = [panel];
  const api = {
    focus,
    getPanel: (id: string) =>
      panelIds.includes(id)
        ? panel
        : undefined,
  } as unknown as DockviewApi;
  return { api, focus, panelApi, setActive, setVisible };
}

const registered: { desktopId: string; api: DockviewApi }[] = [];

function register(desktopId: string, panelIds: readonly string[]) {
  const { api, focus, panelApi, setActive, setVisible } = fakeDockview(panelIds);
  registerDockview(desktopId, api);
  registered.push({ desktopId, api });
  return { focus, panelApi, setActive, setVisible };
}

// 대기표는 모듈 상태이고 5초 뒤에야 만료된다 — 테스트마다 다른 데스크탑 id를 써서
// 순서에 의존하지 않게 한다.
let seq = 0;
const nextDesktopId = () => `desktop-${++seq}`;

afterEach(() => {
  for (const entry of registered.splice(0)) {
    unregisterDockview(entry.desktopId, entry.api);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("navigateToPanel", () => {
  it("같은 데스크탑이면 바로 앞으로 가져온다", () => {
    const here = nextDesktopId();
    const { focus, panelApi, setActive, setVisible } = register(here, ["pane-1"]);
    let focusRequestWasActiveDuringActivation = false;
    setActive.mockImplementation(() => {
      focusRequestWasActiveDuringActivation =
        currentPaneContentFocus(panelApi) !== undefined;
    });
    useStore.setState({ activeSpaceId: here });

    navigateToPanel(here, "pane-1");

    expect(focusRequestWasActiveDuringActivation).toBe(true);
    expect(setVisible).toHaveBeenCalledWith(true);
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setVisible.mock.invocationCallOrder[0]).toBeLessThan(
      setActive.mock.invocationCallOrder[0],
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(setActive.mock.invocationCallOrder[0]).toBeLessThan(
      focus.mock.invocationCallOrder[0],
    );
    expect(peekPendingPanelFocus(here)).toBeUndefined();
  });

  it("다른 데스크탑이면 전환하고 대기표를 남긴다", () => {
    const target = nextDesktopId();
    const { focus } = register(target, ["pane-1"]);
    useStore.setState({ activeSpaceId: nextDesktopId() });

    navigateToPanel(target, "pane-1");

    expect(useStore.getState().activeSpaceId).toBe(target);
    expect(peekPendingPanelFocus(target)).toBe("pane-1");
    expect(focus).not.toHaveBeenCalled();
  });

  it("focus dispatch가 실패하면 exact pending capability를 rollback한다", () => {
    const here = nextDesktopId();
    const { focus, panelApi } = register(here, ["pane-1"]);
    const failure = new Error("focus dispatch failed");
    focus.mockImplementation(() => {
      throw failure;
    });
    useStore.setState({ activeSpaceId: here });

    expect(() => navigateToPanel(here, "pane-1")).toThrow(failure);
    expect(currentPaneContentFocus(panelApi)).toBeUndefined();
  });

  it("pane activation이 실패하면 exact pending capability를 rollback한다", () => {
    const here = nextDesktopId();
    const { panelApi, setActive } = register(here, ["pane-1"]);
    const failure = new Error("pane activation failed");
    setActive.mockImplementation(() => {
      throw failure;
    });
    useStore.setState({ activeSpaceId: here });

    expect(() => navigateToPanel(here, "pane-1")).toThrow(failure);
    expect(currentPaneContentFocus(panelApi)).toBeUndefined();
  });

  it("대기표는 5초 뒤 만료된다 — 나중 전환에서 엉뚱하게 되살아나지 않게", () => {
    vi.useFakeTimers();
    const target = nextDesktopId();
    const { setActive } = register(target, ["pane-1"]);
    useStore.setState({ activeSpaceId: nextDesktopId() });

    navigateToPanel(target, "pane-1");
    vi.advanceTimersByTime(5000);

    expect(peekPendingPanelFocus(target)).toBeUndefined();
    expect(applyPendingPanelFocus(target)).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
  });
});

describe("applyPendingPanelFocus", () => {
  // 이 경로가 없으면: warm으로 남아 있던 데스크탑은 재전환에 onReady가 오지 않아
  // 대기표가 소비되지 않고, 직전에 활성이던 pane이 그대로 포커스를 갖는다.
  it("이미 mount된(warm) 데스크탑에도 대기 중인 pane을 적용한다", () => {
    const target = nextDesktopId();
    const { focus, setActive, setVisible } = register(target, ["pane-1"]);
    useStore.setState({ activeSpaceId: nextDesktopId() });
    navigateToPanel(target, "pane-1");

    expect(applyPendingPanelFocus(target)).toBe(true);
    expect(setVisible).toHaveBeenCalledWith(true);
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setVisible.mock.invocationCallOrder[0]).toBeLessThan(
      setActive.mock.invocationCallOrder[0],
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(setActive.mock.invocationCallOrder[0]).toBeLessThan(
      focus.mock.invocationCallOrder[0],
    );
  });

  it("대기표가 없으면 아무것도 건드리지 않는다 — 사용자가 고른 pane을 빼앗지 않게", () => {
    const quiet = nextDesktopId();
    const { setActive } = register(quiet, ["pane-1"]);

    expect(applyPendingPanelFocus(quiet)).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
  });

  it("대기 중인 pane이 그 데스크탑에 없으면 false — 엉뚱한 pane을 고르지 않는다", () => {
    const target = nextDesktopId();
    const { setActive } = register(target, ["pane-other"]);
    useStore.setState({ activeSpaceId: nextDesktopId() });
    navigateToPanel(target, "pane-1");

    expect(applyPendingPanelFocus(target)).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
  });

  it("멱등이다 — StrictMode 이중 마운트에서 두 번 적용돼도 같은 pane이다", () => {
    const target = nextDesktopId();
    const { setActive } = register(target, ["pane-1"]);
    useStore.setState({ activeSpaceId: nextDesktopId() });
    navigateToPanel(target, "pane-1");

    expect(applyPendingPanelFocus(target)).toBe(true);
    expect(applyPendingPanelFocus(target)).toBe(true);
    expect(setActive).toHaveBeenCalledTimes(2);
  });
});

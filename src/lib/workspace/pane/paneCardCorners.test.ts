// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginTerminalDocumentResize,
  finishTerminalDocumentResize,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import {
  applyPaneCardCorners,
  installPaneCardCorners,
  PANE_CARD_CORNER_ATTRIBUTE,
  paneCardCorners,
  syncPaneCardCorners,
  type PaneCardRect,
} from "@/lib/workspace/pane/paneCardCorners";

const CONTAINER: PaneCardRect = { left: 0, top: 0, right: 1000, bottom: 800 };

describe("paneCardCorners", () => {
  it("한 그룹이 전체를 차지하면 네 모서리 모두", () => {
    expect(paneCardCorners(CONTAINER, CONTAINER)).toEqual(["tl", "tr", "bl", "br"]);
  });

  it("왼쪽 세로 분할은 왼쪽 두 모서리만", () => {
    const left = { left: 0, top: 0, right: 499, bottom: 800 };
    expect(paneCardCorners(left, CONTAINER)).toEqual(["tl", "bl"]);
  });

  it("가운데 그룹은 어느 모서리에도 닿지 않는다", () => {
    const middle = { left: 300, top: 200, right: 700, bottom: 600 };
    expect(paneCardCorners(middle, CONTAINER)).toEqual([]);
  });

  it("2x2 격자는 각 사분면이 자기 모서리 하나씩", () => {
    expect(paneCardCorners({ left: 0, top: 0, right: 499, bottom: 399 }, CONTAINER)).toEqual(["tl"]);
    expect(paneCardCorners({ left: 501, top: 0, right: 1000, bottom: 399 }, CONTAINER)).toEqual(["tr"]);
    expect(paneCardCorners({ left: 0, top: 401, right: 499, bottom: 800 }, CONTAINER)).toEqual(["bl"]);
    expect(paneCardCorners({ left: 501, top: 401, right: 1000, bottom: 800 }, CONTAINER)).toEqual(["br"]);
  });

  it("1px 이내 소수 오차는 같은 변으로 본다", () => {
    // dockview는 분할 크기를 소수로 배치한다 — 0.5px 어긋났다고 모서리를
    // 놓치면 링이 다시 잘린다.
    const nearly = { left: 0.4, top: -0.3, right: 500, bottom: 800 };
    expect(paneCardCorners(nearly, CONTAINER)).toEqual(["tl", "bl"]);
  });

  it("허용 오차 밖이면 모서리로 치지 않는다", () => {
    const inset = { left: 3, top: 3, right: 500, bottom: 800 };
    expect(paneCardCorners(inset, CONTAINER)).toEqual([]);
  });
});

describe("applyPaneCardCorners", () => {
  it("바뀔 때만 쓴다", () => {
    const group = document.createElement("div");
    expect(applyPaneCardCorners(group, ["tl", "bl"])).toBe(true);
    expect(group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl bl");
    expect(applyPaneCardCorners(group, ["tl", "bl"])).toBe(false);
  });

  it("모서리가 없어지면 표시를 지운다", () => {
    const group = document.createElement("div");
    applyPaneCardCorners(group, ["tr"]);
    expect(applyPaneCardCorners(group, [])).toBe(true);
    expect(group.hasAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe(false);
  });
});

describe("syncPaneCardCorners", () => {
  function stubRect(element: HTMLElement, rect: PaneCardRect | null) {
    element.getBoundingClientRect = () =>
      ({
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        right: rect?.right ?? 0,
        bottom: rect?.bottom ?? 0,
        width: (rect?.right ?? 0) - (rect?.left ?? 0),
        height: (rect?.bottom ?? 0) - (rect?.top ?? 0),
        x: rect?.left ?? 0,
        y: rect?.top ?? 0,
        toJSON: () => ({}),
      }) as DOMRect;
    // 박스 모델도 같이 맞춘다 — 컨테이너 비교는 padding box를 쓴다. 숨은
    // 데스크탑처럼 rect가 0이면 client* 도 0이어야 측정 불가로 읽힌다.
    for (const [name, value] of [
      ["clientLeft", 0],
      ["clientTop", 0],
      ["clientWidth", (rect?.right ?? 0) - (rect?.left ?? 0)],
      ["clientHeight", (rect?.bottom ?? 0) - (rect?.top ?? 0)],
    ] as const) {
      Object.defineProperty(element, name, { value, configurable: true });
    }
  }

  /** 컨테이너는 카드 외곽선을 border(예전) 또는 padding + inset ring(지금)으로
   *  갖는다 — jsdom은 client* 를 항상 0으로 주므로 실제 박스 모델을 명시해야
   *  content box 비교가 의미를 갖는다. */
  function stubBox(
    container: HTMLElement,
    { border = 0, padding = 0 }: { border?: number; padding?: number },
  ) {
    for (const [name, value] of [
      ["clientLeft", border],
      ["clientTop", border],
      ["clientWidth", CONTAINER.right - CONTAINER.left - border * 2],
      ["clientHeight", CONTAINER.bottom - CONTAINER.top - border * 2],
    ] as const) {
      Object.defineProperty(container, name, { value, configurable: true });
    }
    if (padding) container.style.padding = `${padding}px`;
  }

  function scene(
    groups: readonly (PaneCardRect | null)[],
    box: { border?: number; padding?: number } = {},
  ) {
    const container = document.createElement("div");
    stubRect(container, CONTAINER);
    stubBox(container, box);
    const elements = groups.map((rect) => {
      const group = document.createElement("div");
      group.className = "dv-groupview";
      stubRect(group, rect);
      container.append(group);
      return group;
    });
    return { container, elements };
  }

  it("각 그룹에 자기 모서리를 표시한다", () => {
    const { container, elements } = scene([
      { left: 0, top: 0, right: 500, bottom: 800 },
      { left: 502, top: 0, right: 1000, bottom: 800 },
    ]);
    syncPaneCardCorners(container);
    expect(elements[0].getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl bl");
    expect(elements[1].getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tr br");
  });

  it("컨테이너 외곽선 두께가 허용 오차를 먹지 않는다", () => {
    // 컨테이너가 1px border(--glass-card-outline)를 가지면 그룹은 padding box에
    // 앉는다. border box와 비교하면 그 1px이 허용 오차를 통째로 먹어, dockview의
    // 소수 배치가 조금만 어긋나도 바깥 모서리를 놓치고 포커스 링이 다시 잘린다.
    const { container, elements } = scene(
      [{ left: 1.4, top: 1.4, right: 999, bottom: 799 }],
      { border: 1 },
    );
    syncPaneCardCorners(container);
    expect(elements[0].getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe(
      "tl tr bl br",
    );
  });

  it("컨테이너 padding만큼 안쪽에 앉은 그룹도 바깥 모서리로 친다", () => {
    // 지금 카드 외곽선은 padding + inset ring이라 그룹은 content box에 앉는다.
    // padding box와 비교하면 그 1px이 허용 오차를 통째로 먹어, 소수 배치가
    // 조금만 어긋나면 모서리를 놓친다 — 그 그룹만 안쪽용 2px 라운드로 남아
    // 12px로 깎는 클리핑 안에서 혼자 뾰족해 보였다(2026-08-11 사용자 보고).
    const { container, elements } = scene(
      [{ left: 1.4, top: 1.4, right: 999, bottom: 799 }],
      { padding: 1 },
    );
    syncPaneCardCorners(container);
    expect(elements[0].getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe(
      "tl tr bl br",
    );
  });

  it("숨은 데스크탑의 0 크기 측정으로 표시를 지우지 않는다", () => {
    const { container, elements } = scene([{ left: 0, top: 0, right: 1000, bottom: 800 }]);
    syncPaneCardCorners(container);
    expect(elements[0].getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl tr bl br");

    stubRect(elements[0], null);
    syncPaneCardCorners(container);
    // 다시 보일 때 모서리가 사라진 채로 남으면 안 된다.
    expect(elements[0].getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl tr bl br");
  });

  it("컨테이너 자체가 0 크기면 아무것도 건드리지 않는다", () => {
    const { container, elements } = scene([{ left: 0, top: 0, right: 1000, bottom: 800 }]);
    syncPaneCardCorners(container);
    stubRect(container, null);
    stubRect(elements[0], { left: 0, top: 0, right: 10, bottom: 10 });
    syncPaneCardCorners(container);
    expect(elements[0].getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl tr bl br");
  });
});

describe("installPaneCardCorners", () => {
  let frames: Array<() => void>;
  let observed: Element[];
  let observers: Array<{ callback: () => void; targets: Set<Element> }>;
  let disconnected: number;

  beforeEach(() => {
    frames = [];
    observed = [];
    disconnected = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames[handle - 1] = () => {};
    });
    observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly targets = new Set<Element>();
        constructor(readonly callback: () => void) {
          observers.push(this);
        }
        observe(target: Element) {
          observed.push(target);
          this.targets.add(target);
        }
        disconnect() {
          disconnected += 1;
          this.targets.clear();
        }
        unobserve(target: Element) {
          this.targets.delete(target);
        }
      },
    );
  });

  /** Deliver a resize notification for one element, the way the platform
   *  does: only observers that watch that element hear about it. */
  function resized(target: Element) {
    for (const observer of observers) {
      if (observer.targets.has(target)) observer.callback();
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flush() {
    const pending = frames.splice(0);
    for (const frame of pending) frame();
  }

  function harness() {
    const ownerDocument = document.implementation.createHTMLDocument();
    const container = ownerDocument.createElement("div");
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100 }) as DOMRect;
    // 컨테이너의 padding box — jsdom은 client* 를 0으로 준다.
    for (const [name, value] of [
      ["clientLeft", 0],
      ["clientTop", 0],
      ["clientWidth", 100],
      ["clientHeight", 100],
    ] as const) {
      Object.defineProperty(container, name, { value, configurable: true });
    }
    const group = ownerDocument.createElement("div");
    group.className = "dv-groupview";
    const measureGroup = vi.fn(
      () => ({ left: 0, top: 0, right: 100, bottom: 100 }) as DOMRect,
    );
    group.getBoundingClientRect = measureGroup;
    container.append(group);
    const listeners: Array<() => void> = [];
    let disposedLayout = 0;
    const handle = installPaneCardCorners({
      container,
      onLayoutChange: (listener) => {
        listeners.push(listener);
        return {
          dispose: () => {
            disposedLayout += 1;
          },
        };
      },
    });
    return {
      container,
      group,
      handle,
      emitLayout: () => {
        for (const listener of listeners) listener();
      },
      measureGroup,
      layoutDisposals: () => disposedLayout,
    };
  }

  it("watches the groups dockview lays out and measures once on install", () => {
    const { group } = harness();
    // The groups are what dockview resizes; the container is not — see the
    // frozen-desktop case below for why watching it is worse than useless.
    expect(observed).toEqual([group]);
    expect(group.hasAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe(false);
    flush();
    expect(group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl tr bl br");
  });

  it("re-measures when dockview relays out a group without a layout event", () => {
    // WebKit, 2026-09-03: a layout restored at another window's size is first
    // measured while the grid still has that size (the group overshoots the
    // card), then dockview-react's own ResizeObserver lays the grid out to the
    // container — and dockview fires no layout event for that. The marks were
    // stuck at the overshoot result until the next unrelated change.
    const { group, measureGroup } = harness();
    measureGroup.mockReturnValue(
      { left: 0, top: 0, right: 300, bottom: 260 } as DOMRect,
    );
    flush();
    expect(group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl");

    measureGroup.mockReturnValue(
      { left: 0, top: 0, right: 100, bottom: 100 } as DOMRect,
    );
    resized(group);
    flush();
    expect(group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl tr bl br");
  });

  it("starts watching a group that arrives after install", () => {
    const { container, emitLayout } = harness();
    flush();
    const added = container.ownerDocument.createElement("div");
    added.className = "dv-groupview";
    added.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100 }) as DOMRect;
    container.append(added);
    emitLayout();
    expect(observed).toContain(added);
  });

  it("ignores a container resize the grid has not followed", () => {
    // A frozen desktop (content-visibility: hidden) keeps its grid at the old
    // size while the container tracks the window. Measuring there compares
    // stale group boxes against the live container and writes wrong marks;
    // the group observer stays quiet until dockview really relays out.
    const { group, container, measureGroup } = harness();
    flush();
    expect(group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl tr bl br");
    measureGroup.mockReturnValue(
      { left: 0, top: 0, right: 120, bottom: 100 } as DOMRect,
    );
    resized(container);
    flush();
    expect(group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl tr bl br");
  });

  it("이벤트가 쏟아져도 프레임당 한 번만 예약한다", () => {
    const { emitLayout, handle } = harness();
    flush();
    handle.refresh();
    emitLayout();
    emitLayout();
    // 이벤트마다 예약하면 사시 드래그·연속 리사이즈에서 리플로우가 쌓인다.
    expect(frames.length).toBe(1);
    flush();
    emitLayout();
    expect(frames.length).toBe(1);
  });

  it("defers pane geometry reads until a sash drag settles", async () => {
    const { container, emitLayout, measureGroup } = harness();
    flush();
    measureGroup.mockClear();
    const generation = beginTerminalDocumentResize(container.ownerDocument);

    for (let move = 0; move < 20; move += 1) {
      emitLayout();
      flush();
    }

    expect(measureGroup).not.toHaveBeenCalled();
    finishTerminalDocumentResize(
      container.ownerDocument,
      "pointerup",
      generation,
    );
    await vi.waitFor(() => expect(frames.length).toBe(1));
    flush();
    expect(measureGroup).toHaveBeenCalledOnce();
  });

  it("dispose는 예약된 측정과 구독을 모두 걷어낸다", () => {
    const { handle, group, emitLayout, layoutDisposals } = harness();
    flush();
    group.setAttribute(PANE_CARD_CORNER_ATTRIBUTE, "stale");
    emitLayout();
    handle.dispose();
    flush();
    // 취소된 프레임이 뒤늦게 돌아 표시를 되살리면 안 된다.
    expect(group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("stale");
    expect(layoutDisposals()).toBe(1);
    expect(disconnected).toBe(1);
  });

  it("refresh는 레이아웃 이벤트 없이도 다시 잰다", () => {
    const { handle, group } = harness();
    flush();
    group.removeAttribute(PANE_CARD_CORNER_ATTRIBUTE);
    handle.refresh();
    flush();
    expect(group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE)).toBe("tl tr bl br");
  });
});

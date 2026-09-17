// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarScrollArea } from "@/components/ui/scroll-area";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SidebarScrollArea", () => {
  /** Radix sizes the thumb through ResizeObserver once the bar is mounted;
   *  jsdom has none, so the tests that mount a bar stub it. */
  function stubResizeObserver() {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }

  it("shows the lane once the list scrolls", () => {
    // The bar appears on the viewport's scroll event (Radix type "scroll"),
    // so a scroll with a changed position is what puts the lane in the tree.
    stubResizeObserver();
    const { container } = render(
      <SidebarScrollArea className="h-20">
        <div className="h-40">overflow</div>
      </SidebarScrollArea>,
    );
    const viewport = container.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    )!;
    act(() => {
      fireEvent.scroll(viewport, { target: { scrollTop: 40 } });
    });

    const scrollbar = container.querySelector<HTMLElement>(
      "[data-sidebar-scrollbar][data-orientation='vertical']",
    );
    expect(scrollbar).not.toBeNull();
  });

  it("honors explicit hover mode and releases the caller's viewport ref on unmount", () => {
    vi.useFakeTimers();
    try {
      const observers = new Set<() => void>();
      vi.stubGlobal("ResizeObserver", class {
        constructor(private callback: () => void) {}
        observe() { observers.add(this.callback); }
        unobserve() { observers.delete(this.callback); }
        disconnect() { observers.delete(this.callback); }
      });
      const viewportRef = createRef<HTMLDivElement>();
      const { container, unmount } = render(
        <SidebarScrollArea type="hover" scrollHideDelay={0} viewportRef={viewportRef}>
          <div>overflow</div>
        </SidebarScrollArea>,
      );
      const root = container.querySelector<HTMLElement>("[data-slot='scroll-area']")!;
      const viewport = container.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']")!;
      expect(viewportRef.current).toBe(viewport);
      Object.defineProperties(viewport, {
        offsetHeight: { value: 100 },
        scrollHeight: { value: 300 },
      });
      expect(container.querySelector("[data-sidebar-scrollbar]")).toBeNull();
      fireEvent.pointerEnter(root);
      act(() => {
        for (const notify of observers) notify();
        vi.advanceTimersByTime(50);
      });
      expect(container.querySelector("[data-sidebar-scrollbar]")).not.toBeNull();
      fireEvent.pointerLeave(root);
      act(() => { vi.advanceTimersByTime(1); });
      expect(container.querySelector("[data-sidebar-scrollbar]")).toBeNull();
      unmount();
      expect(viewportRef.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws no lane until the user scrolls", () => {
    stubResizeObserver();
    const { container } = render(
      <SidebarScrollArea className="h-20">
        <div className="h-40">overflow</div>
      </SidebarScrollArea>,
    );

    // Hovering the sidebar used to reveal the bar whenever the list
    // overflowed, and the pointer is on the sidebar whenever it is in use —
    // so in practice the bar was always there (owner report 2026-09-09). A
    // list that does not overflow never emits a scroll event, so this also
    // covers the short list.
    expect(container.querySelector("[data-sidebar-scrollbar]")).toBeNull();
  });

  it("hides the lane again once scrolling stops", () => {
    vi.useFakeTimers();
    try {
      stubResizeObserver();
      const { container } = render(
        <SidebarScrollArea className="h-20">
          <div className="h-40">overflow</div>
        </SidebarScrollArea>,
      );
      const viewport = container.querySelector<HTMLElement>(
        "[data-slot='scroll-area-viewport']",
      )!;
      act(() => {
        fireEvent.scroll(viewport, { target: { scrollTop: 40 } });
      });
      expect(container.querySelector("[data-sidebar-scrollbar]")).not.toBeNull();

      // Radix waits 100ms of quiet to call the scroll ended; only then does
      // it arm the sidebar's hide delay (800ms), so the two are advanced in
      // turn — the timer is set in an effect that runs when the first act
      // settles.
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(container.querySelector("[data-sidebar-scrollbar]")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(799);
      });
      expect(container.querySelector("[data-sidebar-scrollbar]")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(container.querySelector("[data-sidebar-scrollbar]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fades only clipped edges and clears the mask when resized content fits", () => {
    const observers = new Set<() => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe() { observers.add(this.callback); }
        unobserve() { observers.delete(this.callback); }
        disconnect() { observers.delete(this.callback); }
      },
    );
    const { container, unmount } = render(
      <SidebarScrollArea edgeFade>
        <div>scrollable content</div>
      </SidebarScrollArea>,
    );
    const viewport = container.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    )!;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
    });
    const expectMask = (mask: string) => {
      expect(viewport.style.maskImage).toBe(mask);
      expect(viewport.style.webkitMaskImage).toBe(mask);
    };
    act(() => {
      for (const notify of observers) notify();
    });
    expectMask(
      "linear-gradient(to bottom, var(--mask-opaque) 0, var(--mask-opaque) calc(100% - 8px), transparent 100%)",
    );
    fireEvent.scroll(viewport, { target: { scrollTop: 50 } });
    expectMask(
      "linear-gradient(to bottom, transparent 0, var(--mask-opaque) 8px, var(--mask-opaque) calc(100% - 8px), transparent 100%)",
    );
    fireEvent.scroll(viewport, { target: { scrollTop: 200 } });
    expectMask(
      "linear-gradient(to bottom, transparent 0, var(--mask-opaque) 8px, var(--mask-opaque) 100%)",
    );
    Object.defineProperty(viewport, "scrollHeight", { value: 100 });
    viewport.scrollTop = 0;
    act(() => {
      for (const notify of observers) notify();
    });
    expectMask("");
    unmount();
    expect(observers.size).toBe(0);
  });

  it("leaves overflow unmasked when edgeFade is not enabled", () => {
    const { container } = render(
      <SidebarScrollArea><div>content</div></SidebarScrollArea>,
    );
    const viewport = container.querySelector<HTMLElement>(
      "[data-slot='scroll-area-viewport']",
    )!;
    fireEvent.scroll(viewport, { target: { scrollTop: 20 } });
    expect(viewport.style.maskImage).toBe("");
  });
});

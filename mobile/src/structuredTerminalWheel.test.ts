import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferId, MouseTrackingMode, PointerKind } from "@/contracts/terminalStateProtocol";
import { TERMINAL_VIEWPORT_WHEEL_CAPABILITY } from "@/lib/terminal/protocol/terminalStateLimits";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { mountStructuredTerminal } from "./structuredTerminal";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));

describe("mobile full-screen terminal scrolling", () => {
  let surface: ReturnType<typeof mountStructuredTerminal>;
  let host: HTMLDivElement;
  let sent: Uint8Array[];

  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    host = document.createElement("div");
    document.body.append(host);
    Object.defineProperties(host, {
      clientWidth: { value: 360 }, clientHeight: { value: 400 }, scrollHeight: { value: 400 },
    });
    sent = [];
  });

  afterEach(() => {
    surface?.dispose();
    host.remove();
    vi.restoreAllMocks();
  });

  async function mount(options: Parameters<typeof mountStructuredTerminal>[3] = {}, mouse = true) {
    let first = true;
    const configured = { grantedCapabilities: [TERMINAL_VIEWPORT_WHEEL_CAPABILITY], ...options };
    surface = mountStructuredTerminal(host, {
      attachment_id: "mobile-wheel", terminal_epoch: "mobile-epoch", state_revision: "1",
      through_output_seq: "1", initial_delivery_record_count: 1,
    }, {
      next: async () => {
        if (!first) return new Promise<ArrayBuffer>(() => {});
        first = false;
        return viewportFrameRecord({
          terminalEpoch: "mobile-epoch", activeBuffer: mouse ? BufferId.ALTERNATE : BufferId.NORMAL,
          mouseTracking: mouse ? MouseTrackingMode.ANY : MouseTrackingMode.NONE,
          texts: Array.from({ length: 24 }, (_, index) => `full-screen conversation ${index}`),
        }).buffer as ArrayBuffer;
      },
      send: async record => { sent.push(record); },
    }, configured);
    await vi.waitFor(() => expect(host.textContent).toContain("full-screen conversation"));
  }

  function drag(from: number, to: number) {
    for (const [type, clientY] of [["touchstart", from], ["touchmove", to], ["touchend", to]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientX: 100, clientY }] });
      host.dispatchEvent(event);
    }
  }

  function viewportIntents() {
    return sent.flatMap(bytes => {
      const body = decodeTerminalStateRecord(bytes).record.body;
      return body.case === "viewportIntent" && body.value.intent.case !== "setViewportRows" ? [body.value.intent] : [];
    });
  }

  it("delivers a finger drag to the Host wheel route so a full-screen application can scroll", async () => {
    await mount();
    drag(100, 180);
    await vi.waitFor(() => expect(viewportIntents()).toEqual([
      { case: "wheel", value: expect.objectContaining({ kind: PointerKind.WHEEL, wheelDeltaY: expect.any(Number) }) },
    ]));
    const intent = viewportIntents()[0];
    if (intent.case !== "wheel") throw new Error("Expected Host wheel intent");
    expect(intent.value.wheelDeltaY).toBeLessThan(0);
    expect(intent.value.wheelDeltaX).toBe(0);
  });

  it("leaves normal-buffer wheel routing with the Host when mouse mode changes between frames", async () => {
    await mount({}, false);
    drag(100, 180);
    await vi.waitFor(() => expect(viewportIntents()[0]?.case).toBe("wheel"));
  });

  it.each([
    { writable: false, grantedCapabilities: [TERMINAL_VIEWPORT_WHEEL_CAPABILITY] },
    { writable: true, grantedCapabilities: [] },
  ])("keeps history navigation without sending application input for %j", async options => {
    const guard = vi.fn();
    await mount({ ...options, guardInput: guard });
    drag(100, 180);
    await vi.waitFor(() => expect(viewportIntents()).toEqual([
      { case: "scrollRows", value: expect.objectContaining({ rows: 4 }) },
    ]));
    expect(guard).not.toHaveBeenCalled();
  });

  it("uses the displayed touch cell despite fractional font metrics and grid offsets", async () => {
    await mount();
    const grid = host.querySelector<HTMLElement>(".structured-terminal__grid")!;
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({ left: 20, top: 30 } as DOMRect);
    drag(100, 180);
    await vi.waitFor(() => expect(viewportIntents()[0]?.case).toBe("wheel"));
    const intent = viewportIntents()[0];
    if (intent.case !== "wheel") throw new Error("Expected Host wheel intent");
    const cellWidth = Number.parseFloat(grid.style.width) / 80;
    const cellHeight = Number.parseFloat(grid.style.getPropertyValue("--terminal-row-height"));
    expect(intent.value.column).toBe(Math.floor(80 / cellWidth));
    expect(intent.value.row).toBe(Math.floor(150 / cellHeight));
    expect(intent.value.pressedButtons).toBe(0);
  });

  it.each([[100, 10_000, -64], [10_000, -100, 64]])("bounds long drags and their touch coordinates (%i -> %i)", async (from, to, delta) => {
    await mount();
    drag(from, to);
    await vi.waitFor(() => expect(viewportIntents()[0]?.case).toBe("wheel"));
    const intent = viewportIntents()[0];
    if (intent.case !== "wheel") throw new Error("Expected Host wheel intent");
    expect(intent.value.wheelDeltaY).toBe(delta);
    expect(intent.value.pixelY).toBeGreaterThanOrEqual(0);
    expect(intent.value.pixelY).toBeLessThan(intent.value.surfaceHeight);
    expect(intent.value.row).toBe(Math.floor(intent.value.pixelY / intent.value.cellHeight));
  });

  it("keeps a pending wheel behind the existing input approval without focusing the keyboard", async () => {
    const held: (() => void)[] = [];
    await mount({ guardInput: send => held.push(send) });
    drag(100, 180);
    await Promise.resolve();
    expect(held).toHaveLength(1);
    expect(viewportIntents()).toEqual([]);
    held[0]();
    await vi.waitFor(() => expect(viewportIntents()[0]?.case).toBe("wheel"));
    expect(document.activeElement).toBe(document.body);
  });

  it("drops an approval-held wheel after the attachment is disposed", async () => {
    const held: (() => void)[] = [];
    await mount({ guardInput: send => held.push(send) });
    drag(100, 180);
    expect(held).toHaveLength(1);
    surface.dispose();
    held[0]();
    drag(100, 180);
    await Promise.resolve();
    expect(viewportIntents()).toEqual([]);
    expect(held).toHaveLength(1);
  });
});

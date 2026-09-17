import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CursorShape, CursorStateSchema } from "@/contracts/terminalStateProtocol";
import { decodeTerminalStateRecord, encodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { mountStructuredTerminal } from "./structuredTerminal";
import { DRAWER_LIFT_PROPERTY, KEYBOARD_LIFT_PROPERTY } from "./transcriptLift";

/** The button fades rather than hides: away is a class the stylesheet reads. */
const away = (button: HTMLElement) => button.classList.contains("terminal__scroll-to-bottom--away");

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));

describe("mobile structured terminal scrolling", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  it.each([8, 80])("keeps a %spx finger scroll above the keyboard when output arrives before the native scroll event", async (distance) => {
    const host = document.createElement("div");
    host.style.setProperty(KEYBOARD_LIFT_PROPERTY, "300px");
    Object.defineProperties(host, {
      clientWidth: { value: 360 }, clientHeight: { value: 300 }, scrollHeight: { value: 672 },
    });
    document.body.append(host);
    let first = true;
    let nextFrame: ((record: ArrayBuffer) => void) | undefined;
    const frame = (revision: bigint) => viewportFrameRecord({
      terminalEpoch: "mobile-epoch", projectionRevision: revision,
      texts: Array.from({ length: 40 }, (_, index) => `output ${revision} row ${index}`),
    }).buffer as ArrayBuffer;
    const surface = mountStructuredTerminal(host, {
      attachment_id: "keyboard-scroll", terminal_epoch: "mobile-epoch", state_revision: "1",
      through_output_seq: "1", initial_delivery_record_count: 1,
    }, {
      next: async () => {
        if (!first) return new Promise(resolve => { nextFrame = resolve; });
        first = false;
        return frame(1n);
      },
      send: async () => {},
    });
    try {
      await vi.waitFor(() => expect(nextFrame).toBeTypeOf("function"));
      const initialTop = host.scrollTop;
      expect(initialTop).toBeGreaterThan(80);
      expect(away(surface.scrollToBottomButton)).toBe(true);
      for (const [type, clientY] of [["touchstart", 100], ["touchmove", 100 + distance]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientX: 100, clientY }] });
        host.dispatchEvent(event);
      }
      const readingTop = host.scrollTop;
      expect(readingTop).toBe(initialTop - distance);
      expect(away(surface.scrollToBottomButton)).toBe(false);
      nextFrame!(frame(2n));
      await vi.waitFor(() => expect(host.textContent).toContain("output 2"));
      expect(host.scrollTop).toBe(readingTop);
      surface.fit();
      expect(host.scrollTop).toBe(readingTop);
      host.dispatchEvent(new Event("scroll"));
      surface.fit();
      expect(host.scrollTop).toBe(readingTop);
      surface.scrollToBottomButton.click();
      expect(host.scrollTop).toBe(initialTop);
      expect(away(surface.scrollToBottomButton)).toBe(true);
    } finally {
      surface.dispose();
      host.remove();
    }
  });

  it.each([true, false])("returns Host history to live output and keeps keyboard focus (writable=%s)", async writable => {
    const stage = document.createElement("div");
    const host = document.createElement("div");
    const field = document.createElement("textarea");
    stage.append(host, field);
    document.body.append(stage);
    const frame = (revision: bigint, followTail: boolean) => {
      const record = decodeTerminalStateRecord(viewportFrameRecord({
        terminalEpoch: "mobile-epoch", projectionRevision: revision,
        followTail, hasMoreAfter: !followTail,
        texts: [followTail ? "live output" : "earlier output"],
      })).record;
      if (record.body.case !== "viewportFrame") throw new Error("Expected viewport");
      return encodeTerminalStateRecord(revision, record).buffer as ArrayBuffer;
    };
    let nextFrame: ((record: ArrayBuffer) => void) | undefined;
    let first = true;
    const sent: Uint8Array[] = [];
    const surface = mountStructuredTerminal(host, {
      attachment_id: "jump-latest", terminal_epoch: "mobile-epoch", state_revision: "1",
      through_output_seq: "1", initial_delivery_record_count: 1,
    }, {
      next: async () => {
        if (!first) return new Promise(resolve => { nextFrame = resolve; });
        first = false;
        return frame(1n, false);
      },
      send: async record => { sent.push(record); },
    }, { writable });
    const button = surface.scrollToBottomButton;
    stage.append(button);
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("earlier output"));
      expect(away(button)).toBe(false);
      field.focus();
      const down = new Event("pointerdown", { bubbles: true, cancelable: true });
      button.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      button.click();
      expect(document.activeElement).toBe(field);
      await vi.waitFor(() => expect(sent.some(bytes => {
        const body = decodeTerminalStateRecord(bytes).record.body;
        return body.case === "viewportIntent" && body.value.intent.case === "followTail";
      })).toBe(true));
      // Only the Host's acknowledged projection says we reached live output.
      expect(away(button)).toBe(false);
      nextFrame!(frame(2n, true));
      await vi.waitFor(() => expect(host.textContent).toContain("live output"));
      expect(away(button)).toBe(true);
    } finally {
      surface.dispose();
      expect(button.isConnected).toBe(false);
      stage.remove();
    }
  });

  it.each([true, false])("requests earlier Host rows from a finger drag even with no DOM overflow (writable=%s)", async (writable) => {
    const host = document.createElement("div");
    document.body.append(host);
    Object.defineProperties(host, {
      clientWidth: { value: 360 }, clientHeight: { value: 400 }, scrollHeight: { value: 400 },
    });
    const sent: Uint8Array[] = [];
    let first = true;
    const surface = mountStructuredTerminal(host, {
      attachment_id: "history-touch", terminal_epoch: "mobile-epoch", state_revision: "1",
      through_output_seq: "1", initial_delivery_record_count: 1,
    }, {
      next: async () => {
        if (!first) return new Promise<ArrayBuffer>(() => {});
        first = false;
        return viewportFrameRecord({ terminalEpoch: "mobile-epoch", texts: ["latest"] }).buffer as ArrayBuffer;
      },
      send: async record => { sent.push(record); },
    }, { writable });
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("latest"));
      const touch = (type: string, clientY: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientX: 100, clientY }] });
        host.dispatchEvent(event);
      };
      touch("touchstart", 100);
      touch("touchmove", 180);
      touch("touchend", 180);
      await vi.waitFor(() => expect(sent.some(bytes => {
        const body = decodeTerminalStateRecord(bytes).record.body;
        return body.case === "viewportIntent" && body.value.intent.case === "scrollRows" && body.value.intent.value.rows > 0;
      })).toBe(true));
    } finally {
      surface.dispose();
      host.remove();
    }
  });

  it("keeps the content tail above a keyboard without following trailing blank rows", async () => {
    const record = decodeTerminalStateRecord(viewportFrameRecord({
      terminalEpoch: "mobile-epoch",
      stateRevision: 3n,
      throughOutputSeq: 7n,
      texts: Array.from({ length: 40 }, (_, index) => index === 20 ? "안$" : ""),
    })).record;
    if (record.body.case !== "viewportFrame") throw new Error("Expected a viewport");
    record.body.value.cursor!.visible = false;
    const host = document.createElement("div");
    host.style.padding = "16px 16px 76px";
    let height = 724;
    let top = 0;
    Object.defineProperties(host, {
      clientWidth: { value: 360 },
      clientHeight: { get: () => height },
      scrollHeight: { get: () => 724 },
      scrollTop: {
        get: () => top,
        set: (value: number) => { top = Math.max(0, Math.min(724 - height, value)); },
      },
    });
    document.body.append(host);
    const sent: Uint8Array[] = [];
    let first = true;
    const surface = mountStructuredTerminal(host, {
      attachment_id: "mobile-keyboard-tail",
      terminal_epoch: "mobile-epoch",
      through_output_seq: "7",
      state_revision: "3",
      initial_delivery_record_count: 1,
    }, {
      next: async () => {
        if (!first) return new Promise<ArrayBuffer>(() => {});
        first = false;
        return encodeTerminalStateRecord(1n, record).buffer as ArrayBuffer;
      },
      send: async (bytes) => { sent.push(bytes); },
    });
    await vi.waitFor(() => expect(host.textContent).toContain("안$"));
    surface.fit();
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const before = sent.length;
    height = 352;
    host.style.setProperty("--session-keyboard-height", "372px");
    surface.fit();
    const rowHeight = Number.parseFloat(host.querySelector<HTMLElement>(".structured-terminal__grid")!.style.getPropertyValue("--terminal-row-height"));
    expect(host.scrollTop).toBe(16 + 21 * rowHeight + 76 - height);
    host.dispatchEvent(new Event("scroll"));
    surface.fit();
    expect(host.scrollTop).toBe(16 + 21 * rowHeight + 76 - height);
    await Promise.resolve();
    expect(sent).toHaveLength(before);
    host.scrollTop = 0;
    host.dispatchEvent(new Event("scroll"));
    surface.fit();
    expect(host.scrollTop).toBe(0);
    surface.dispose();
  });

  it.each(["drawer", "keyboard"])(
    "keeps short content visible when the %s covers trailing blank rows",
    async (cover) => {
      const host = document.createElement("div");
      host.style.padding = "16px 16px 80px";
      let covered = 0;
      let top = 0;
      const rowHeight = () => Number.parseFloat(
        host.querySelector<HTMLElement>(".terminal-viewport-row")?.style.height ?? "0",
      );
      Object.defineProperties(host, {
        clientWidth: { value: 390 },
        clientHeight: { get: () => 696 - (cover === "keyboard" ? covered : 0) },
        // The terminal keeps its 600px at-rest box; the CSS lift adds room
        // below it. jsdom has no layout, so model native scroll clamping here.
        scrollHeight: { get: () => 96 + (cover === "drawer" ? covered : 0) + Math.max(600, 40 * rowHeight()) },
        scrollTop: {
          get: () => top,
          set: (value: number) => { top = Math.max(0, Math.min(value, host.scrollHeight - host.clientHeight)); },
        },
      });
      document.body.append(host);
      let reads = 0;
      const sent: Uint8Array[] = [];
      let publish: ((record: ArrayBuffer) => void) | undefined;
      const frame = (revision: bigint, contentRows: number, cursorRow = contentRows - 1) =>
        viewportFrameRecord({
          terminalEpoch: "mobile-epoch",
          stateRevision: revision,
          projectionRevision: revision,
          texts: Array.from({ length: 40 }, (_, index) => index < contentRows ? `Trust prompt ${index}` : ""),
          cursorRow,
        }).buffer as ArrayBuffer;
      const surface = mountStructuredTerminal(host, {
        attachment_id: "short-prompt",
        terminal_epoch: "mobile-epoch",
        state_revision: "1",
        through_output_seq: "1",
        initial_delivery_record_count: 1,
      }, {
        next: async () => ++reads === 1 ? frame(1n, 10) : new Promise((resolve) => { publish = resolve; }),
        send: async (record) => { sent.push(record); },
      });
      const publishNext = async (record: ArrayBuffer) => {
        await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
        const next = publish!;
        publish = undefined;
        next(record);
      };
      await vi.waitFor(() => expect(host.textContent).toContain("Trust prompt 9"));
      covered = 330;
      host.style.setProperty(cover === "drawer" ? DRAWER_LIFT_PROPERTY : KEYBOARD_LIFT_PROPERTY, `${covered}px`);
      surface.fit();
      // The whole prompt fits above the tray: its blank tail is not content.
      expect(host.scrollTop).toBe(0);

      // Native scroll events after an automatic fit must not unpin the view.
      host.dispatchEvent(new Event("scroll"));
      await publishNext(frame(2n, 30));
      await vi.waitFor(() => expect(host.textContent).toContain("Trust prompt 29"));
      const visibleHeight = 600 - covered;
      expect(host.scrollTop).toBeCloseTo(30 * rowHeight() - visibleHeight);

      // A cursor on a blank input row is real content too.
      host.dispatchEvent(new Event("scroll"));
      await publishNext(frame(3n, 30, 34));
      await vi.waitFor(() => expect(host.querySelector<HTMLElement>(".structured-terminal__grid")?.dataset.projectionRevision).toBe("3"));
      expect(host.scrollTop).toBeCloseTo(35 * rowHeight() - visibleHeight);

      host.scrollTop = 0;
      host.dispatchEvent(new Event("scroll"));
      await publishNext(frame(4n, 40));
      await vi.waitFor(() => expect(host.textContent).toContain("Trust prompt 39"));
      expect(host.scrollTop).toBe(0);

      // A live cursor can sit above later notices. Preserve a manual scroll,
      // then follow it again only after the person returns to the live anchor.
      await publishNext(frame(5n, 40, 14));
      await vi.waitFor(() => expect(host.querySelector<HTMLElement>(".structured-terminal__grid")?.dataset.projectionRevision).toBe("5"));
      expect(host.scrollTop).toBe(0);
      covered = 0;
      host.style.removeProperty(cover === "drawer" ? DRAWER_LIFT_PROPERTY : KEYBOARD_LIFT_PROPERTY);
      surface.fit();
      host.scrollTop = host.scrollHeight - host.clientHeight;
      host.dispatchEvent(new Event("scroll"));
      const cursor = host.querySelector<HTMLElement>(".terminal-viewport-cursor");
      expect(cursor?.style.display).toBe("block");
      const cursorTop = Number.parseFloat(cursor?.style.top ?? "NaN");
      expect(host.scrollTop).toBeLessThanOrEqual(cursorTop);
      expect(cursorTop + rowHeight()).toBeLessThanOrEqual(host.scrollTop + 600);
      const sentAtRest = sent.length;

      covered = 330;
      host.style.setProperty(cover === "drawer" ? DRAWER_LIFT_PROPERTY : KEYBOARD_LIFT_PROPERTY, `${covered}px`);
      surface.fit();
      await Promise.resolve();
      expect(sent).toHaveLength(sentAtRest);
      expect(host.scrollTop).toBeLessThanOrEqual(cursorTop);
      expect(cursorTop + rowHeight()).toBeLessThanOrEqual(host.scrollTop + visibleHeight);

      for (const [index, mode] of ["hidden", "absent"].entries()) {
        const revision = BigInt(6 + index * 2);
        host.dispatchEvent(new Event("scroll"));
        await publishNext(frame(revision, 40, 14));
        await vi.waitFor(() => expect(host.querySelector<HTMLElement>(".structured-terminal__grid")?.dataset.projectionRevision).toBe(String(revision)));
        expect(host.scrollTop).toBeLessThanOrEqual(cursorTop);
        host.dispatchEvent(new Event("scroll"));

        const record = decodeTerminalStateRecord(new Uint8Array(frame(revision + 1n, 40, 14))).record;
        if (record.body.case !== "viewportFrame") throw new Error("no frame");
        record.body.value.cursor = mode === "hidden"
          ? create(CursorStateSchema, { row: 14, visible: false, shape: CursorShape.BLOCK }) : undefined;
        await publishNext(encodeTerminalStateRecord(revision + 1n, record).buffer as ArrayBuffer);
        await vi.waitFor(() => expect(host.querySelector<HTMLElement>(".structured-terminal__grid")?.dataset.projectionRevision).toBe(String(revision + 1n)));
        expect(cursor?.style.display).toBe("none");
        expect(host.scrollTop).toBeCloseTo(40 * rowHeight() - visibleHeight);
      }
      surface.dispose();
      host.remove();
    },
  );

});

import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CellStyleSchema,
  BufferId,
  CursorShape,
  CursorStateSchema,
  GraphemeSchema,
  HyperlinkSchema,
  InputModesSchema,
  MouseEncoding,
  MouseTrackingMode,
  RowTermination,
  TerminalRowSchema,
  TerminalStateRecordSchema,
  TerminalTablesSchema,
  TerminalColorOverridesSchema,
  UnicodeWidthProfileSchema,
  UnderlineKind,
  ViewportAnchorStatus,
  ViewportFrameSchema,
} from "@/contracts/terminalStateProtocol";
import {
  decodeTerminalStateRecord,
  encodeTerminalStateRecord,
} from "@/lib/terminal/protocol/terminalStateProtocol";
import type { AgentRuntimeState } from "./agentRuntimeState";
import { mountStructuredTerminal } from "./structuredTerminal";

/** URLs handed to the opener plugin, in order. */
const openedUrls: string[] = [];
/** When set, the opener rejects with it — the real plugin rejects with a plain string. */
let openFailure: string | undefined;
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => {
    openedUrls.push(url);
    return openFailure ? Promise.reject(openFailure) : Promise.resolve();
  },
}));

/** One row whose cells all carry `hyperlink`, when given. */
function viewportRecord(hyperlink?: string): Uint8Array {
  return encodeTerminalStateRecord(
    1n,
    create(TerminalStateRecordSchema, {
      schemaMinor: 4,
      terminalEpoch: "mobile-epoch",
      throughOutputSeq: 7n,
      stateRevision: 3n,
      body: {
        case: "viewportFrame",
        value: create(ViewportFrameSchema, {
          projectionRevision: 1n,
          damageBaseProjectionRevision: 0n,
          canonicalColumns: 20,
          viewportRows: 1,
          activeBuffer: BufferId.NORMAL,
          rows: [
            create(TerminalRowSchema, {
              rowId: 1n,
              logicalLineId: 1n,
              logicalCellSpan: 3,
              termination: RowTermination.HARD_BREAK,
              cells: [
                { graphemeIndex: 0, styleIndex: 0 },
                { graphemeIndex: 1, styleIndex: 0 },
              ],
            }),
          ],
          tables: create(TerminalTablesSchema, {
            graphemes: [
              create(GraphemeSchema, { text: "안", displayWidth: 2 }),
              create(GraphemeSchema, { text: "$", displayWidth: 1 }),
            ],
            styles: [
              create(CellStyleSchema, {
                underline: UnderlineKind.NONE,
                hyperlinkIndex: hyperlink ? 1 : 0,
              }),
            ],
            hyperlinks: hyperlink ? [create(HyperlinkSchema, { uri: hyperlink })] : [],
          }),
          cursor: create(CursorStateSchema, {
            visible: true,
            shape: CursorShape.BLOCK,
          }),
          inputModes: create(InputModesSchema, {
            mouseTracking: MouseTrackingMode.NONE,
            mouseEncoding: MouseEncoding.DEFAULT,
          }),
          colorOverrides: create(TerminalColorOverridesSchema),
          unicodeWidth: create(UnicodeWidthProfileSchema, {
            unicodeVersion: "15.1.0",
            ambiguousWidth: 1,
            emojiWidth: 2,
          }),
          followTail: true,
          anchorStatus: ViewportAnchorStatus.FOLLOW_TAIL,
          rowsFromTail: 0n,
        }),
      },
    }),
  );
}

/** One JSON control record, the way the relay writes them beside the frames. */
function controlRecord(body: Record<string, unknown>): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify({ kind: "control", body })).buffer as ArrayBuffer;
}

const APPROVAL_RUNTIME = {
  kind: "agent_runtime_state",
  payload: {
    terminal_epoch: "mobile-epoch",
    revision: "2",
    observed_through_output_seq: "7",
    lifecycle: "running",
    activity: "waiting",
    attention: "approval_required",
    attention_id: "appr-1",
    source: "provider_event",
  },
};

describe("mobile structured terminal", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    openedUrls.length = 0;
    openFailure = undefined;
  });

  /**
   * Mounts over a scripted pump: the first read is a frame, then the given
   * records in order, then a read that never answers.
   */
  function mountScripted(
    records: readonly ArrayBuffer[],
    options: Parameters<typeof mountStructuredTerminal>[3] = {},
    transport: Partial<Parameters<typeof mountStructuredTerminal>[2]> = {},
  ) {
    const host = document.createElement("div");
    Object.defineProperties(host, {
      clientWidth: { value: 320 },
      clientHeight: { value: 240 },
    });
    document.body.append(host);
    const sent: Uint8Array[] = [];
    let reads = 0;
    const surface = mountStructuredTerminal(
      host,
      {
        attachment_id: "mobile-attach-scripted",
        terminal_epoch: "mobile-epoch",
        through_output_seq: "7",
        state_revision: "3",
        initial_delivery_record_count: 1,
      },
      {
        next: async () => {
          reads += 1;
          if (reads === 1) return viewportRecord().buffer as ArrayBuffer;
          const record = records[reads - 2];
          if (record) return record;
          return new Promise<ArrayBuffer>(() => {});
        },
        send: async (record) => {
          sent.push(record);
        },
        ...transport,
      },
      options,
    );
    return { host, sent, surface, reads: () => reads };
  }

  const keyIntents = (sent: readonly Uint8Array[]): string[] =>
    sent.flatMap((record) => {
      const body = decodeTerminalStateRecord(record).record.body;
      if (body.case !== "inputIntent") return [];
      const intent = body.value.intent;
      if (intent.case === "key") return [intent.value.key];
      if (intent.case === "text") return [new TextDecoder().decode(intent.value.utf8)];
      return [];
    });

  it("sends phone paste through the approval guard as one fenced PasteInput", async () => {
    const held: (() => void)[] = [];
    const mounted = mountScripted([], { guardInput: send => held.push(send) });
    try {
      await vi.waitFor(() => expect(mounted.reads()).toBe(2));
      await mounted.surface.paste({ kind: "text", text: "한글\nsecond line" });
      expect(held).toHaveLength(1);
      expect(keyIntents(mounted.sent)).toEqual([]);
      held[0]();
      await vi.waitFor(() => expect(mounted.sent.map(bytes => decodeTerminalStateRecord(bytes).record.body)
        .some(body => body.case === "inputIntent" && body.value.intent.case === "paste")).toBe(true));
      const bodies = mounted.sent.map(bytes => decodeTerminalStateRecord(bytes).record.body)
        .filter(body => body.case === "inputIntent" && body.value.intent.case !== "resize");
      expect(bodies).toHaveLength(1);
      const body = bodies[0];
      if (body.case !== "inputIntent" || body.value.intent.case !== "paste") throw new Error("Expected paste");
      expect(new TextDecoder().decode(body.value.intent.value.utf8)).toBe("한글\nsecond line");
    } finally { mounted.surface.dispose(); mounted.host.remove(); }
  });

  it("retains complete text and cursor during a synchronized redraw while input advances", async () => {
    let deliver: ((record: ArrayBuffer) => void) | undefined;
    let reads = 0;
    const { host, surface, sent } = mountScripted([], {}, {
      next: () => {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve(viewportRecord().buffer as ArrayBuffer);
        }
        return new Promise<ArrayBuffer>((resolve) => { deliver = resolve; });
      },
    });
    await vi.waitFor(() => expect(reads).toBe(2));
    const cursor = host.querySelector<HTMLElement>("[data-terminal-cursor]");
    expect(cursor?.style.display).toBe("block");
    const redraw = (revision: bigint, synchronizedOutput: boolean) => {
      const record = decodeTerminalStateRecord(viewportRecord()).record;
      if (record.body.case !== "viewportFrame") throw new Error("Expected a viewport");
      const frame = record.body.value;
      record.stateRevision = revision;
      frame.projectionRevision = revision;
      if (!frame.inputModes || !frame.cursor) throw new Error("Expected modes and cursor");
      frame.inputModes.synchronizedOutput = synchronizedOutput;
      frame.cursor.visible = !synchronizedOutput;
      frame.cursor.column = 2;
      if (frame.tables?.graphemes[0]) frame.tables.graphemes[0].text = synchronizedOutput ? " " : "한";
      return encodeTerminalStateRecord(revision, record).buffer as ArrayBuffer;
    };
    deliver?.(redraw(4n, true));
    await vi.waitFor(() => expect(reads).toBe(3));
    expect(host.textContent).toContain("안$");
    expect(cursor?.style.display).toBe("block");

    surface.sendText("a");
    await vi.waitFor(() => expect(keyIntents(sent)).toEqual(["a"]));
    const input = sent.map((record) => decodeTerminalStateRecord(record).record)
      .find((record) => record.body.case === "inputIntent" && record.body.value.intent.case === "text");
    expect(input?.stateRevision).toBe(4n);

    deliver?.(redraw(5n, false));
    await vi.waitFor(() => expect(host.textContent).toContain("한$"));
    expect(cursor?.style.display).toBe("block");
    expect(host.querySelector("[data-terminal-cursor]")).toBe(cursor);
    surface.dispose();
    host.remove();
  });

  it("exposes the canonical row width without resizing the session to that overflow", async () => {
    const frame = (columns: number, revision: bigint): ArrayBuffer => {
      const record = decodeTerminalStateRecord(viewportRecord()).record;
      if (record.body.case !== "viewportFrame") throw new Error("Expected a viewport");
      record.body.value.canonicalColumns = columns;
      record.body.value.projectionRevision = revision;
      return encodeTerminalStateRecord(revision, record).buffer as ArrayBuffer;
    };
    let first = true;
    let deliver: ((record: ArrayBuffer) => void) | undefined;
    const { host, surface, sent } = mountScripted([], {}, {
      next: () => {
        if (first) {
          first = false;
          return Promise.resolve(frame(100, 1n));
        }
        return new Promise<ArrayBuffer>((resolve) => { deliver = resolve; });
      },
    });
    await vi.waitFor(() => expect(host.textContent).toContain("안$"));
    const grid = host.querySelector<HTMLElement>(".structured-terminal__grid")!;
    const rowWidth = () => host.querySelector<HTMLElement>(".terminal-viewport-row")!.style.width;
    expect(Number.parseFloat(rowWidth())).toBeGreaterThan(host.clientWidth);
    expect(grid.style.width).toBe(rowWidth());
    surface.fit();
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const resizes = sent.flatMap((bytes) => {
      const body = decodeTerminalStateRecord(bytes).record.body;
      return body.case === "inputIntent" && body.value.intent.case === "resize"
        ? [body.value.intent.value.columns] : [];
    });
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toBeLessThan(100);
    deliver?.(frame(10, 2n));
    await vi.waitFor(() => expect(Number.parseFloat(rowWidth())).toBeLessThan(host.clientWidth));
    expect(grid.style.width).toBe(rowWidth());
    surface.dispose();
  });

  it("shows a rejected input's command error without replaying uncertain input", async () => {
    const submitted: Uint8Array[] = [];
    const failure = { code: "terminal_attachment_changed", message: "The attachment changed" };
    const { host, surface } = mountScripted([], {}, {
      send: async (record) => {
        submitted.push(record);
        if (keyIntents(submitted).length === 2) throw failure;
      },
    });
    await vi.waitFor(() => expect(host.textContent).toContain("안$"));
    surface.sendText("Connectivity QA");
    surface.sendText(" only");
    surface.sendText(". Reply exactly QA606_OK");
    await vi.waitFor(() =>
      expect(host.querySelector(".structured-terminal__notice")?.textContent)
        .toBe("The attachment changed (terminal_attachment_changed)"),
    );
    expect(keyIntents(submitted)).toEqual(["Connectivity QA", " only"]);
    surface.sendText("never replay");
    await Promise.resolve();
    expect(keyIntents(submitted)).toEqual(["Connectivity QA", " only"]);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
    surface.dispose();
  });

  it.each(["resolve", "reject"])("keeps a closed record's code and frame while refusing queued and future input (%s)", async (completion) => {
    vi.useFakeTimers();
    let surface: ReturnType<typeof mountStructuredTerminal> | undefined;
    try {
      const submitted: Uint8Array[] = [];
      let close: ((record: ArrayBuffer) => void) | undefined;
      let releaseSend: (() => void) | undefined;
      let reads = 0;
      const mounted = mountScripted([], {}, {
        next: async () => ++reads === 1 ? viewportRecord().buffer as ArrayBuffer
          : new Promise((resolve) => { close = resolve; }),
        send: async (record) => {
          submitted.push(record);
          if (keyIntents([record]).length === 0) return;
          await new Promise<void>((resolve, reject) => {
            releaseSend = completion === "resolve" ? resolve
              : () => reject({ code: "late_send_error", message: "Late write failed" });
          });
        },
      });
      surface = mounted.surface;
      await vi.advanceTimersByTimeAsync(0);
      surface.sendText("in flight before closure");
      await vi.advanceTimersByTimeAsync(0);
      expect(keyIntents(submitted)).toEqual(["in flight before closure"]);
      expect(releaseSend).toBeTypeOf("function");
      surface.sendText("queued before closure");
      close?.(new TextEncoder().encode(JSON.stringify({
        kind: "closed", code: "hmux_transport_closed", message: "The transport closed",
      })).buffer as ArrayBuffer);
      await vi.advanceTimersByTimeAsync(0);
      releaseSend?.();
      surface.sendText("typed after closure");
      await vi.advanceTimersByTimeAsync(0);
      expect(keyIntents(submitted)).toEqual(["in flight before closure"]);
      expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
      expect(mounted.host.querySelector(".structured-terminal__grid")?.textContent).toContain("안$");
      const notice = mounted.host.querySelector<HTMLElement>(".structured-terminal__notice");
      expect(notice?.textContent).toBe("The transport closed (hmux_transport_closed)");
      surface.writeNotice("A later transient notice");
      notice?.click();
      await vi.advanceTimersByTimeAsync(6_001);
      expect(notice?.hidden).toBe(false);
      expect(notice?.textContent).toBe("The transport closed (hmux_transport_closed)");
    } finally {
      surface?.dispose();
      vi.useRealTimers();
    }
  });

  it("rejects approval-held input and new admission after the attachment fails", async () => {
    const held: (() => void)[] = [];
    const failures: string[] = [];
    let close: ((record: ArrayBuffer) => void) | undefined;
    let reads = 0;
    const { host, surface, sent } = mountScripted([], {
      guardInput: (send) => held.push(send),
      onUnavailable: (detail) => failures.push(detail),
    }, {
      next: async () => ++reads === 1 ? viewportRecord().buffer as ArrayBuffer
        : new Promise((resolve) => { close = resolve; }),
    });
    await vi.waitFor(() => expect(close).toBeDefined());
    surface.sendText("held for approval");
    expect(held).toHaveLength(1);
    close?.(controlRecord({ kind: "exit", payload: { reason: "The session ended" } }));
    await vi.waitFor(() => expect(failures).toEqual(["The session ended"]));
    held[0]();
    surface.sendText("must not request approval");
    surface.fit();
    await Promise.resolve();
    expect(held).toHaveLength(1);
    expect(keyIntents(sent)).toEqual([]);
    expect(host.querySelector<HTMLElement>(".structured-terminal__notice")?.hidden).toBe(true);
    surface.dispose();
  });

  it.each(["read", "send"])("ignores a disposed attachment's late %s rejection", async (failure) => {
    const failures: string[] = [];
    let rejectRead: ((error: unknown) => void) | undefined;
    let rejectSend: ((error: unknown) => void) | undefined;
    let reads = 0;
    const { surface } = mountScripted([], { onUnavailable: (detail) => failures.push(detail) }, {
      next: async () => ++reads === 1 ? viewportRecord().buffer as ArrayBuffer
        : new Promise((_resolve, reject) => { rejectRead = reject; }),
      send: async () => new Promise((_resolve, reject) => { rejectSend = reject; }),
    });
    await vi.waitFor(() => expect(rejectRead && rejectSend).toBeDefined());
    surface.dispose();
    (failure === "read" ? rejectRead : rejectSend)?.({ code: "old_failure", message: "Old failure" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toEqual([]);
  });

  it("shows the command error when terminal reading fails", async () => {
    const { host, surface } = mountScripted([], {}, {
      next: async () => { throw { code: "terminal_not_attached", message: "No terminal attached" }; },
    });
    await vi.waitFor(() =>
      expect(host.querySelector(".structured-terminal__notice")?.textContent)
        .toBe("No terminal attached (terminal_not_attached)"),
    );
    surface.dispose();
  });

  /**
   * The relay writes the agent's runtime state beside the frames. It is a
   * fact for the caller, not a notice for the transcript, and the pump goes
   * on reading after it.
   */
  it("hands an agent_runtime_state record to the caller and keeps pumping", async () => {
    const seen: AgentRuntimeState[] = [];
    const { host, surface, reads } = mountScripted(
      [controlRecord(APPROVAL_RUNTIME), controlRecord(APPROVAL_RUNTIME)],
      { onAgentRuntimeState: (state) => seen.push(state) },
    );

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]).toMatchObject({ attention: "approval_required", attentionId: "appr-1" });
    // Still pumping: the read after the two records was issued.
    await vi.waitFor(() => expect(reads()).toBe(4));
    expect(host.querySelector<HTMLElement>(".structured-terminal__notice")?.hidden).not.toBe(false);
    surface.dispose();
  });

  it("still notices an exit record and stops", async () => {
    const seen: AgentRuntimeState[] = [];
    const { host, surface, reads } = mountScripted(
      [controlRecord({ kind: "exit", payload: { reason: "agent exited" } })],
      { onAgentRuntimeState: (state) => seen.push(state) },
    );

    await vi.waitFor(() =>
      expect(host.querySelector(".structured-terminal__notice")?.textContent).toBe("agent exited"),
    );
    await Promise.resolve();
    expect(reads()).toBe(2);
    expect(seen).toEqual([]);
    surface.dispose();
  });

  /**
   * The surface is the one place every input passes, so a caller-supplied
   * guard sees all of it: nothing reaches the transport until the guard lets
   * the send through, and then it goes in the guard's order.
   */
  it("hands every send to guardInput and sends only when the guard says so", async () => {
    const held: (() => void)[] = [];
    const { host, sent, surface } = mountScripted([], {
      guardInput: (send) => {
        held.push(send);
      },
    });
    await vi.waitFor(() => expect(host.textContent).toContain("안$"));
    const before = sent.length;

    surface.sendKey({
      key: "Escape",
      code: "Escape",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      repeat: false,
      getModifierState: () => false,
    });
    surface.sendText("ls");
    const input = host.querySelector<HTMLTextAreaElement>("textarea");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", bubbles: true }));
    await Promise.resolve();
    expect(held).toHaveLength(3);
    expect(sent).toHaveLength(before);

    for (const send of held) send();
    await vi.waitFor(() => expect(sent.length).toBe(before + 3));
    expect(keyIntents(sent.slice(before))).toEqual(["Escape", "ls", "ArrowUp"]);
    surface.dispose();
  });

  /**
   * A watcher's input is discarded, so the guard has nothing to decide: a
   * read-only attach never raises the Face ID sheet for a tap that would go
   * nowhere. The writable check is the first thing a send meets.
   */
  it("never consults guardInput on a read-only surface", async () => {
    const guard = vi.fn((send: () => void) => send());
    const { host, sent, surface } = mountScripted([], { writable: false, guardInput: guard });
    await vi.waitFor(() => expect(host.textContent).toContain("안$"));
    const before = sent.length;

    surface.sendKey({
      key: "ArrowDown",
      code: "ArrowDown",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      repeat: false,
      getModifierState: () => false,
    });
    surface.sendText("ls");
    await Promise.resolve();
    expect(guard).not.toHaveBeenCalled();
    expect(sent).toHaveLength(before);
    surface.dispose();
  });

  /**
   * A printed link opens in the system browser, not through `window.open`:
   * wry implements the new-window hook only on macOS, so on a phone that call
   * is a silent no-op (2026-09-05). The opener plugin is the one path out.
   */
  async function mountWithLink(): Promise<{ host: HTMLElement; link: HTMLAnchorElement }> {
    const host = document.createElement("div");
    Object.defineProperties(host, {
      clientWidth: { value: 320 },
      clientHeight: { value: 240 },
    });
    document.body.append(host);
    let reads = 0;
    mountStructuredTerminal(
      host,
      {
        attachment_id: "mobile-attach-link",
        terminal_epoch: "mobile-epoch",
        through_output_seq: "7",
        state_revision: "3",
        initial_delivery_record_count: 1,
      },
      {
        next: async () => {
          reads += 1;
          if (reads === 1) return viewportRecord("https://example.com/docs").buffer as ArrayBuffer;
          return new Promise<ArrayBuffer>(() => {});
        },
        send: async () => {},
      },
    );
    await vi.waitFor(() => expect(host.querySelector("a[data-terminal-hyperlink]")).not.toBeNull());
    const link = host.querySelector<HTMLAnchorElement>("a[data-terminal-hyperlink]");
    if (!link) throw new Error("hyperlink expected");
    return { host, link };
  }

  it("printed hyperlinks open through the opener plugin, never window.open", async () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const { link } = await mountWithLink();

    link.click();
    await vi.waitFor(() => expect(openedUrls).toEqual(["https://example.com/docs"]));
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("a link the opener refuses is written as a notice", async () => {
    openFailure = "Not allowed to open url https://example.com/docs";
    const { host, link } = await mountWithLink();

    link.click();
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLElement>(".structured-terminal__notice")?.hidden).toBe(false),
    );
    expect(host.querySelector(".structured-terminal__notice")?.textContent).toBe(openFailure);
  });

  it("paints Host viewport rows and sends semantic key input", async () => {
    const host = document.createElement("div");
    Object.defineProperties(host, {
      clientWidth: { value: 320 },
      clientHeight: { value: 240 },
    });
    document.body.append(host);
    const sent: Uint8Array[] = [];
    const pending = new Promise<ArrayBuffer>(() => {});
    let reads = 0;

    const surface = mountStructuredTerminal(
      host,
      {
        attachment_id: "mobile-attach-1",
        terminal_epoch: "mobile-epoch",
        through_output_seq: "7",
        state_revision: "3",
        initial_delivery_record_count: 1,
      },
      {
        next: async () => {
          reads += 1;
          if (reads === 1) return viewportRecord().buffer as ArrayBuffer;
          return pending;
        },
        send: async (record) => {
          sent.push(record);
        },
      },
    );

    await vi.waitFor(() => expect(host.textContent).toContain("안$"));
    const input = host.querySelector<HTMLTextAreaElement>("textarea");
    expect(input).not.toBeNull();
    input?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        code: "ArrowUp",
        bubbles: true,
      }),
    );

    await vi.waitFor(() =>
      expect(
        sent.some((record) => {
          const body = decodeTerminalStateRecord(record).record.body;
          return body.case === "inputIntent" && body.value.intent.case === "key";
        }),
      ).toBe(true),
    );
    const decoded = sent
      .map((record) => decodeTerminalStateRecord(record))
      .find(
        (record) =>
          record.record.body.case === "inputIntent" &&
          record.record.body.value.intent.case === "key",
      );
    if (decoded?.record.body.case !== "inputIntent") throw new Error("input intent expected");
    const intent = decoded.record.body.value.intent;
    expect(intent.case).toBe("key");
    if (intent.case !== "key") throw new Error("key intent expected");
    expect(intent.value.key).toBe("ArrowUp");
    surface.dispose();
  });

  it("sends rapid semantic intents to Hmux in record order", async () => {
    const host = document.createElement("div");
    Object.defineProperties(host, {
      clientWidth: { value: 320 },
      clientHeight: { value: 240 },
    });
    document.body.append(host);
    const sent: Uint8Array[] = [];
    const pendingRead = new Promise<ArrayBuffer>(() => {});
    let finishFirstSend: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => {
      finishFirstSend = resolve;
    });
    let reads = 0;

    const surface = mountStructuredTerminal(
      host,
      {
        attachment_id: "mobile-attach-ordered",
        terminal_epoch: "mobile-epoch",
        through_output_seq: "7",
        state_revision: "3",
        initial_delivery_record_count: 1,
      },
      {
        next: async () => {
          reads += 1;
          if (reads === 1) return viewportRecord().buffer as ArrayBuffer;
          return pendingRead;
        },
        send: async (record) => {
          sent.push(record);
          if (sent.length === 1) await firstSend;
        },
      },
    );

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const input = host.querySelector<HTMLTextAreaElement>("textarea");
    input?.dispatchEvent(new FocusEvent("focus"));
    input?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        code: "ArrowUp",
        bubbles: true,
      }),
    );
    await Promise.resolve();
    expect(sent).toHaveLength(1);

    finishFirstSend?.();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((record) => decodeTerminalStateRecord(record).metadata.recordId)).toEqual([
      1n,
      2n,
      3n,
    ]);
    surface.dispose();
  });

  it("stops accepting input when the ordered send queue is full", async () => {
    const host = document.createElement("div");
    Object.defineProperties(host, {
      clientWidth: { value: 320 },
      clientHeight: { value: 240 },
    });
    document.body.append(host);
    const pending = new Promise<void>(() => {});
    let reads = 0;

    const surface = mountStructuredTerminal(
      host,
      {
        attachment_id: "mobile-attach-backpressure",
        terminal_epoch: "mobile-epoch",
        through_output_seq: "7",
        state_revision: "3",
        initial_delivery_record_count: 1,
      },
      {
        next: async () => {
          reads += 1;
          if (reads === 1) return viewportRecord().buffer as ArrayBuffer;
          return new Promise<ArrayBuffer>(() => {});
        },
        send: async () => pending,
      },
    );

    await vi.waitFor(() => expect(host.textContent).toContain("안$"));
    const input = host.querySelector<HTMLTextAreaElement>("textarea");
    for (let index = 0; index < 512; index += 1) {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          code: "ArrowUp",
          bubbles: true,
        }),
      );
    }

    expect(host.textContent).toContain("hmux_structured_upstream_backpressure");
    surface.dispose();
  });

  it("gives up the rows the box loses when the tray takes them", async () => {
    // The tray stands on the transcript through the host's bottom padding, and
    // the keyboard changes what that comes to. Measured from the grid, a box
    // getting smaller was invisible — the grid is as tall as the frame already
    // painted, so the reported rows could only ever go up, and the tray sat on
    // rows the session still believed it could paint.
    const host = document.createElement("div");
    host.style.padding = "16px 16px 72px";
    Object.defineProperties(host, {
      clientWidth: { value: 320 },
      clientHeight: { value: 480 },
    });
    document.body.append(host);
    const sent: Uint8Array[] = [];
    let reads = 0;

    const surface = mountStructuredTerminal(
      host,
      {
        attachment_id: "mobile-attach-shrink",
        terminal_epoch: "mobile-epoch",
        through_output_seq: "7",
        state_revision: "3",
        initial_delivery_record_count: 1,
      },
      {
        next: async () => {
          reads += 1;
          if (reads === 1) return viewportRecord().buffer as ArrayBuffer;
          return new Promise<ArrayBuffer>(() => {});
        },
        send: async (record) => {
          sent.push(record);
        },
      },
    );

    await vi.waitFor(() => expect(host.textContent).toContain("안$"));

    const lastResizeRows = (): number | undefined => {
      for (let index = sent.length - 1; index >= 0; index -= 1) {
        const body = decodeTerminalStateRecord(sent[index]).record.body;
        if (body.case !== "inputIntent") continue;
        const intent = body.value.intent;
        if (intent.case === "resize") return intent.value.rows;
      }
      return undefined;
    };

    surface.fit();
    await vi.waitFor(() => expect(lastResizeRows()).toBeGreaterThan(0));
    const pillOnly = lastResizeRows();

    // 100px more of tray, the way the keyboard's own inset moves it.
    host.style.paddingBottom = "172px";
    surface.fit();
    await vi.waitFor(() => expect(lastResizeRows()).not.toBe(pillOnly));
    expect(lastResizeRows()).toBeLessThan(pillOnly as number);

    surface.dispose();
  });
});

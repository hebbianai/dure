import { createTerminalCanvasRenderer } from "@/components/terminal/structured/TerminalCanvasRenderer";
import { createTerminalViewportDomRenderer } from "@/components/terminal/structured/TerminalViewportDomRenderer";
import { terminalPointerWheelRows } from "@/components/terminal/structured/structuredTerminalPointerWheel";
import { PointerKind } from "@/contracts/terminalStateProtocol";
import {
  DEFAULT_TERMINAL_LINE_HEIGHT,
  terminalFontStack,
} from "@/lib/terminal/renderer/terminalFont";
import {
  encodeTerminalFocusIntent,
  type TerminalKeyEvent,
  encodeTerminalKeyIntent,
  encodeTerminalPasteIntent,
  encodeTerminalResizeIntent,
  encodeTerminalTextIntent,
  encodeTerminalViewportWheelIntent,
} from "@/lib/terminal/state/terminalInputIntent";
import { TERMINAL_STATE_MAX_VIEWPORT_FRAME_PARTS, TERMINAL_VIEWPORT_WHEEL_CAPABILITY } from "@/lib/terminal/protocol/terminalStateLimits";
import { hasTerminalStateEnvelopeMagic } from "@/lib/terminal/protocol/terminalStateProtocol";
import {
  primeStructuredTerminalViewport,
  reduceStructuredTerminalViewportRecord,
  terminalViewportInputFence,
} from "@/lib/terminal/state/structuredTerminalViewport";
import {
  encodeTerminalViewportFollowTailIntent,
  encodeTerminalViewportRowsIntent,
  encodeTerminalViewportScrollRowsIntent,
} from "@/lib/terminal/state/terminalViewportIntent";
import { issueTerminalViewportIntent } from "@/lib/terminal/state/terminalViewportFrameReplica";
import { showTerminalScrollToBottom } from "@/lib/terminal/presentation/terminalScrollToBottom";
import { createTerminalViewportMultipartAssembler } from "@/lib/terminal/protocol/terminalViewportMultipartAssembler";
import { DARK_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import type { AttachedSession } from "./ipc";
import { describeError } from "./commandError";
import { element, glyph, paintedBackground } from "./dom";
import iconChevronDown from "./assets/icon-chevron-down.svg";
import { t } from "./i18n";
import { openExternal } from "./openExternal";
import { type AgentRuntimeState, parseAgentRuntimeRecord } from "./agentRuntimeState";
import type { TrackpadDirection } from "./spaceTrackpad";
import { attachTerminalKeyboard } from "./terminalKeyboard";
import { terminalFontSize } from "./terminalAppearance";
import { attachTerminalScroll } from "./terminalScroll";
import { terminalContentBox } from "./terminalBox";
import { DRAWER_LIFT_PROPERTY } from "./transcriptLift";
import { createTerminalPaste, type TerminalPasteContent } from "./terminalPaste";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { terminalViewportSelectionText } from "@/lib/terminal/presentation/terminalViewportSelection";
import { hasTerminalTextSelection } from "./terminalTextSelection";

type TerminalReceipt = AttachedSession["terminal"];

export interface StructuredTerminalTransport {
  next: () => Promise<ArrayBuffer>;
  send: (record: Uint8Array) => Promise<unknown>;
}

export interface StructuredTerminalSurface {
  /** Kept beside the scroller by the screen, for this attachment's lifetime. */
  readonly scrollToBottomButton: HTMLButtonElement;
  writeNotice(text: string): void;
  fit(): void;
  /**
   * A key pressed somewhere other than this terminal's own field — the key
   * tray, the arrow pad, the message row's Enter.
   *
   * This transport carries semantic intents, never terminal byte sequences.
   * The surface owns the record transport, so it is the authority that knows
   * how to represent "Escape" here.
   */
  sendKey(event: TerminalKeyEvent): void;
  /** Characters typed outside the terminal's own field. */
  sendText(text: string): void;
  paste(content?: TerminalPasteContent): Promise<void>;
  dispose(): void;
}

/** How long a notice stays before taking itself down. */
const NOTICE_LINGER_MS = 6_000;
/** Allow browser scroll-coordinate rounding, without swallowing a finger move. */
const BOTTOM_SLACK_PX = 1;
const MAX_INITIAL_RECORDS = TERMINAL_STATE_MAX_VIEWPORT_FRAME_PARTS + 2;
const MAX_QUEUED_SENDS = 512;
const MAX_QUEUED_SEND_BYTES = 2 * 1024 * 1024;
/**
 * The palette, with its background taken from the node it draws into.
 *
 * The host already paints the pane and carries the mockup's 16px inset; a
 * second colour inside it turns that inset into a frame around the transcript.
 */
function themeFor(grid: HTMLElement): typeof THEME {
  const painted = paintedBackground(grid) ?? paintedBackground(grid.parentElement ?? grid);
  return painted ? { ...THEME, background: painted } : THEME;
}

const THEME = {
  background: DARK_TERMINAL_PALETTE.background,
  foreground: DARK_TERMINAL_PALETTE.foreground,
  cursor: DARK_TERMINAL_PALETTE.cursor,
  selectionBackground: DARK_TERMINAL_PALETTE.selectionBackground,
  indexed: [
    DARK_TERMINAL_PALETTE.black,
    DARK_TERMINAL_PALETTE.red,
    DARK_TERMINAL_PALETTE.green,
    DARK_TERMINAL_PALETTE.yellow,
    DARK_TERMINAL_PALETTE.blue,
    DARK_TERMINAL_PALETTE.magenta,
    DARK_TERMINAL_PALETTE.cyan,
    DARK_TERMINAL_PALETTE.white,
    DARK_TERMINAL_PALETTE.brightBlack,
    DARK_TERMINAL_PALETTE.brightRed,
    DARK_TERMINAL_PALETTE.brightGreen,
    DARK_TERMINAL_PALETTE.brightYellow,
    DARK_TERMINAL_PALETTE.brightBlue,
    DARK_TERMINAL_PALETTE.brightMagenta,
    DARK_TERMINAL_PALETTE.brightCyan,
    DARK_TERMINAL_PALETTE.brightWhite,
  ],
};

export function mountStructuredTerminal(
  host: HTMLElement,
  receipt: TerminalReceipt,
  transport: StructuredTerminalTransport,
  options: {
    writable?: boolean;
    grantedCapabilities?: readonly string[];
    /**
     * Which arrow a space-bar drag on this surface's field is pressing, or
     * none. The transcript does not own the pill that shows it.
     */
    trackpadDirection?: (direction: TrackpadDirection | undefined, fast: boolean) => void;
    /**
     * Raises the phone's own keyboard field, and says whether it did.
     *
     * A tap on the transcript is how somebody starts typing, and it used to
     * focus this surface's field — a second place a line can be typed, which
     * the tray then knows nothing about. So the prompt never reached the
     * command history and the send button never appeared (2026-09-04 user
     * report). One field types into a session; this hands the tap to it.
     */
    focusField?: () => boolean;
    /**
     * The agent's runtime state, each time the relay writes it beside the
     * frames. A fact for the caller — the transcript draws nothing for it.
     */
    onAgentRuntimeState?: (state: AgentRuntimeState) => void;
    /** Projects this attachment's terminal failure without changing session runtime facts. */
    onUnavailable?: (detail: string) => void;
    /**
     * Sits on the one funnel every input leaves through — keys, typed text,
     * paste, the trackpad's arrows, the tray — and decides when `send` runs.
     * Absent, input goes straight out.
     */
    guardInput?: (send: () => void) => void;
    pasteActive?: () => boolean;
    stageClipboardImage?: (file: DroppedFilePayload) => Promise<unknown>;
    onPasteText?: (text: string) => void;
  } = {},
): StructuredTerminalSurface {
  if (
    !Number.isSafeInteger(receipt.initial_delivery_record_count) ||
    receipt.initial_delivery_record_count < 1 ||
    receipt.initial_delivery_record_count > MAX_INITIAL_RECORDS
  ) {
    throw new Error("structured_terminal_initial_delivery_count_invalid");
  }
  const writable = options.writable ?? true;
  const fontSize = terminalFontSize();
  const grid = document.createElement("div");
  grid.className = "structured-terminal__grid";
  const input = document.createElement("textarea");
  input.className = "structured-terminal__input";
  input.setAttribute("aria-label", t("terminal.input"));
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  input.disabled = !writable;
  const notice = document.createElement("div");
  notice.className = "structured-terminal__notice";
  notice.hidden = true;
  host.replaceChildren(grid, input, notice);
  const scrollToBottomButton = element("button", "terminal__scroll-to-bottom");
  scrollToBottomButton.type = "button";
  scrollToBottomButton.setAttribute("aria-label", t("terminal.chrome.scrollToBottom"));
  scrollToBottomButton.append(glyph(iconChevronDown, 22));
  // Away rather than `hidden`: the class lets the stylesheet fade it, where
  // `display: none` is a cut both ways (#851).
  const showScrollControl = (shown: boolean) =>
    scrollToBottomButton.classList.toggle("terminal__scroll-to-bottom--away", !shown);
  showScrollControl(false);
  scrollToBottomButton.addEventListener("pointerdown", event => event.preventDefault());

  const metrics = createTerminalCanvasRenderer();
  const renderer = createTerminalViewportDomRenderer();
  const onCopy = (event: ClipboardEvent) => {
    const text = terminalViewportSelectionText(grid, host.ownerDocument.getSelection());
    if (!text || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };
  host.addEventListener("copy", onCopy);
  const multipart = createTerminalViewportMultipartAssembler();
  const fontFamily = terminalFontStack("");
  let replica = primeStructuredTerminalViewport(receipt.attachment_id, {
    terminalEpoch: receipt.terminal_epoch,
    throughOutputSeq: receipt.through_output_seq,
    stateRevision: receipt.state_revision,
  });
  let nextRecordId = 1n;
  let sending = Promise.resolve();
  let queuedSends = 0;
  let queuedSendBytes = 0;
  let unavailable: string | undefined;
  let disposed = false;
  let focused = false;
  let lastGeometry = "";

  /** Transient notices expire; a retired attachment needs an explicit new attach. */
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearNotice = () => {
    if (unavailable !== undefined) return;
    notice.hidden = true;
    notice.textContent = "";
  };
  const writeNotice = (text: string) => {
    if (disposed || unavailable !== undefined) return;
    notice.textContent = text;
    notice.hidden = false;
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(clearNotice, NOTICE_LINGER_MS);
  };
  notice.addEventListener("click", clearNotice);
  const fail = (detail: string) => {
    if (disposed || unavailable !== undefined) return;
    unavailable = detail;
    showScrollControl(false);
    input.disabled = true;
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    // The caller owns the persistent banner when it projects this failure.
    notice.textContent = options.onUnavailable ? "" : detail;
    notice.hidden = options.onUnavailable !== undefined;
    options.onUnavailable?.(detail);
  };

  /**
   * Follow painted content, not the empty rows below a short prompt. Drawers
   * lift the grid's floor without resizing the terminal, so its physical
   * bottom can scroll the entire prompt out of view. Manual scrolling still
   * owns the position until the person returns to this content anchor.
   * Later notices may extend below the active cursor; following them must not
   * scroll the cursor row above the visible area.
   */
  let pinnedToBottom = true;
  let contentHeight = 0;
  let cursorTop = Number.POSITIVE_INFINITY;
  const tailScrollTop = () => {
    const style = host.ownerDocument.defaultView?.getComputedStyle(host);
    // The keyboard already shrinks clientHeight; only the overlay drawer
    // needs subtracting here (unlike the at-rest terminalContentBox).
    const covered = [
      style?.paddingTop,
      style?.paddingBottom,
      style?.getPropertyValue(DRAWER_LIFT_PROPERTY),
    ].reduce<number>((total, value) => total + (Number.parseFloat(value ?? "") || 0), 0);
    const visibleHeight = Math.max(0, host.clientHeight - covered);
    return Math.max(0, Math.min(host.scrollHeight - host.clientHeight, contentHeight - visibleHeight, cursorTop));
  };
  const updateScrollControl = () => {
    const frame = replica.frame;
    showScrollControl(
      unavailable === undefined && !!frame &&
        !(pinnedToBottom && !showTerminalScrollToBottom(frame.frame)),
    );
  };
  const readScrollPosition = () => {
    if (!host.isConnected) return;
    pinnedToBottom = Math.abs(tailScrollTop() - host.scrollTop) < BOTTOM_SLACK_PX;
    updateScrollControl();
  };
  host.addEventListener("scroll", readScrollPosition);
  const stickToBottom = () => {
    if (pinnedToBottom) host.scrollTop = tailScrollTop();
    updateScrollControl();
  };
  // Measured from the room the host leaves, not from the grid standing in it:
  // `terminalBox.ts` carries why the grid can only ever report growth.
  const measure = () => {
    const box = terminalContentBox(host);
    return metrics.measure(
      box.width,
      box.height,
      fontFamily,
      fontSize,
      DEFAULT_TERMINAL_LINE_HEIGHT,
    );
  };
  const send = (build: (recordId: bigint) => Uint8Array) => {
    if (disposed || unavailable !== undefined) return;
    const recordId = nextRecordId;
    nextRecordId += 1n;
    const record = build(recordId);
    if (
      queuedSends >= MAX_QUEUED_SENDS ||
      queuedSendBytes + record.byteLength > MAX_QUEUED_SEND_BYTES
    ) {
      fail("hmux_structured_upstream_backpressure");
      return;
    }
    queuedSends += 1;
    queuedSendBytes += record.byteLength;
    sending = sending
      .then(async () => {
        if (!disposed && unavailable === undefined) await transport.send(record);
      })
      .catch((error) => {
        fail(describeError(error));
      })
      .finally(() => {
        queuedSends -= 1;
        queuedSendBytes -= record.byteLength;
      });
  };
  const sendInput = (
    build: (
      recordId: bigint,
      fence: NonNullable<ReturnType<typeof terminalViewportInputFence>>,
    ) => Uint8Array,
  ) => {
    if (!writable || disposed || unavailable !== undefined) return;
    const fence = terminalViewportInputFence(replica);
    if (!fence) return;
    send((recordId) => build(recordId, fence));
  };
  const sendViewport = (
    build: (
      recordId: bigint,
      fence: NonNullable<ReturnType<typeof terminalViewportInputFence>>,
      viewport: ReturnType<typeof issueTerminalViewportIntent>["fence"],
    ) => Uint8Array,
  ) => {
    const fence = terminalViewportInputFence(replica);
    if (!fence || disposed || unavailable !== undefined) return;
    const issued = issueTerminalViewportIntent(replica);
    replica = issued.replica;
    send((recordId) => build(recordId, fence, issued.fence));
  };
  const stopTouchScroll = attachTerminalScroll(host, {
    rowHeight: () => measure().rowHeight,
    onScroll: readScrollPosition,
    scrollRows: (rows, touch) => {
      if (!writable || !options.grantedCapabilities?.includes(TERMINAL_VIEWPORT_WHEEL_CAPABILITY)) {
        sendViewport((recordId, fence, viewport) =>
          encodeTerminalViewportScrollRowsIntent(recordId, fence, viewport, rows),
        );
        return;
      }
      if (!terminalViewportInputFence(replica) || disposed || unavailable !== undefined) return;
      // The Host decides whether the gesture scrolls history or reaches the application.
      // A wheel can write to the PTY, so it uses the same approval boundary as keys.
      admit(() => {
        const frame = replica.frame?.frame;
        if (!frame || disposed || unavailable !== undefined) return;
        const geometry = measure();
        const bounds = grid.getBoundingClientRect();
        const cellWidth = Math.max(1, Math.round(geometry.cellWidth));
        const cellHeight = Math.max(1, Math.round(geometry.rowHeight));
        const surfaceWidth = frame.canonicalColumns * cellWidth;
        const surfaceHeight = frame.viewportRows * cellHeight;
        const pixelX = Math.max(0, Math.min(surfaceWidth - 1,
          Math.floor((touch.clientX - bounds.left) * cellWidth / geometry.cellWidth)));
        const pixelY = Math.max(0, Math.min(surfaceHeight - 1,
          Math.floor((touch.clientY - bounds.top) * cellHeight / geometry.rowHeight)));
        sendViewport((recordId, fence, viewport) =>
          encodeTerminalViewportWheelIntent(recordId, fence, viewport, {
            kind: PointerKind.WHEEL,
            column: Math.floor(pixelX / cellWidth), row: Math.floor(pixelY / cellHeight),
            button: 0, buttons: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
            wheelDeltaX: 0, wheelDeltaY: terminalPointerWheelRows(-rows),
            pixelX, pixelY, surfaceWidth, surfaceHeight, cellWidth, cellHeight,
            paddingTop: 0, paddingBottom: 0, paddingRight: 0, paddingLeft: 0,
          }),
        );
      });
    },
  });
  scrollToBottomButton.addEventListener("click", () => {
    if (disposed || unavailable !== undefined) return;
    pinnedToBottom = true;
    stickToBottom();
    sendViewport(encodeTerminalViewportFollowTailIntent);
  });
  /**
   * `sendInput`, through the caller's guard. A watcher's input is discarded,
   * so the guard is never asked about it: the writable check runs before the
   * guard, and a read-only attach never raises the Face ID sheet. The fence
   * is read when the send actually runs, so a held input is measured against
   * the frame it lands on.
   */
  const admit = options.guardInput ?? ((send: () => void) => send());
  const sendGuarded = (build: Parameters<typeof sendInput>[0]) => {
    if (!writable || disposed || unavailable !== undefined) return;
    admit(() => sendInput(build));
  };
  const paint = () => {
    // Keep complete pixels during DEC synchronized redraws; the replica still
    // advances for input fences, just as in the desktop transport.
    if (!replica.frame || replica.frame.frame.inputModes?.synchronizedOutput) return;
    const painted = renderer.render(grid, replica.frame, {
      attachmentId: receipt.attachment_id,
      terminalEpoch: replica.terminalEpoch,
      focused,
      fontFamily,
      fontSize,
      lineHeight: DEFAULT_TERMINAL_LINE_HEIGHT,
      metrics: measure(),
      theme: themeFor(grid),
      // Not `window.open`: wry's new-window hook exists only on macOS, so on a
      // phone that call is a silent no-op. The system browser is the one way out.
      openHyperlink: (uri) =>
        void openExternal(uri).then((failure) => {
          if (failure && !disposed) writeNotice(failure);
        }),
    });
    // The renderer clips within its grid; expose the full row to the outer scroller.
    grid.style.width = `${replica.frame.frame.canonicalColumns * painted.metrics.cellWidth}px`;
    let contentRows = painted.visibleText.length;
    while (contentRows > 0 && painted.visibleText[contentRows - 1].trim().length === 0) {
      contentRows -= 1;
    }
    const cursor = replica.frame.frame.cursor;
    cursorTop = Number.POSITIVE_INFINITY;
    if (cursor?.visible && cursor.row < painted.rows.length && cursor.column < painted.metrics.columns) {
      cursorTop = cursor.row * painted.metrics.rowHeight;
      contentRows = Math.max(contentRows, cursor.row + 1);
    }
    contentHeight = contentRows * painted.metrics.rowHeight;
    input.disabled = !writable || unavailable !== undefined;
    stickToBottom();
  };

  const consume = (record: ArrayBuffer): boolean => {
    if (disposed || unavailable !== undefined) return false;
    const bytes = new Uint8Array(record);
    if (!hasTerminalStateEnvelopeMagic(bytes)) {
      if (options.onAgentRuntimeState) {
        const runtime = parseAgentRuntimeRecord(bytes);
        if (runtime) {
          options.onAgentRuntimeState(runtime);
          return true;
        }
      }
      const control = parseControlRecord(bytes);
      if (control !== null) fail(control);
      return control === null;
    }
    const assembled = multipart.push(bytes);
    if (assembled.status === "pending") return true;
    if (assembled.status === "resync_required") {
      fail(assembled.reason);
      return false;
    }
    const reduced = reduceStructuredTerminalViewportRecord(
      replica,
      receipt.attachment_id,
      assembled.decoded,
    );
    if (reduced.status === "applied") {
      replica = reduced.replica;
      paint();
    } else if (reduced.status === "reattach_required" || reduced.status === "invalid") {
      fail(reduced.reason ?? "structured_terminal_reattach_required");
      return false;
    }
    return true;
  };

  const pull = async () => {
    try {
      for (let index = 0; index < receipt.initial_delivery_record_count; index += 1) {
        if (disposed || !consume(await transport.next())) return;
      }
      syncGeometry();
      while (!disposed && unavailable === undefined && consume(await transport.next())) {}
    } catch (error) {
      fail(describeError(error));
    }
  };

  const syncGeometry = () => {
    const fence = terminalViewportInputFence(replica);
    // A covering screen keeps this reader alive but has no terminal geometry.
    if (!fence || disposed || unavailable !== undefined || !host.isConnected) return;
    const geometry = measure();
    const identity = `${geometry.columns}x${geometry.rows}`;
    if (identity === lastGeometry) return;
    lastGeometry = identity;
    if (writable) {
      send((recordId) =>
        encodeTerminalResizeIntent(recordId, fence, geometry.columns, geometry.rows),
      );
      return;
    }
    sendViewport((recordId, inputFence, viewport) =>
      encodeTerminalViewportRowsIntent(recordId, inputFence, viewport, geometry.rows),
    );
  };

  const focus = () => {
    if (!writable || disposed || input.disabled || hasTerminalTextSelection(grid)) return;
    if (options.focusField?.() === true) return;
    input.focus();
  };
  host.addEventListener("click", focus);
  const paste = createTerminalPaste({
    active: () => writable && !disposed && unavailable === undefined && (options.pasteActive?.() ?? true),
    send: text => {
      options.onPasteText?.(text);
      sendGuarded((recordId, fence) => encodeTerminalPasteIntent(recordId, fence, text));
    },
    stageImage: options.stageClipboardImage ?? (async () => { throw new Error(t("terminal.paste.desktopRequired")); }),
    notice: text => { if (text) writeNotice(text); else clearNotice(); },
  });
  const keyboard = attachTerminalKeyboard(input, {
    text: text => sendGuarded((recordId, fence) => encodeTerminalTextIntent(recordId, fence, text)),
    key: event => sendGuarded((recordId, fence) => encodeTerminalKeyIntent(recordId, fence, event)),
    paste: text => { void paste({ kind: "text", text }); },
    pasteImage: image => { void paste({ kind: "image", image }); },
    trackpad: {
      press: direction => {
        const key = {left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown"}[direction];
        sendGuarded((recordId, fence) => encodeTerminalKeyIntent(recordId, fence, {
          key, code: key, ctrlKey: false, altKey: false, shiftKey: false,
          metaKey: false, repeat: false, getModifierState: () => false,
        }));
      },
      direction: (direction, fast) => options.trackpadDirection?.(direction, fast),
    },
  });
  input.addEventListener("focus", () => {
    focused = true;
    renderer.setFocused(grid, true);
    sendInput((recordId, fence) => encodeTerminalFocusIntent(recordId, fence, true));
  });
  input.addEventListener("blur", () => {
    focused = false;
    renderer.setFocused(grid, false);
    sendInput((recordId, fence) => encodeTerminalFocusIntent(recordId, fence, false));
  });

  void pull();
  return {
    scrollToBottomButton,
    writeNotice,
    paste,
    fit: () => {
      syncGeometry();
      // The box just changed — the tray took room or gave it back. A drawer
      // does not resize the terminal at all; it raises the grid's floor, and
      // the only thing that puts the newest line back in view is this. Whoever
      // had scrolled away keeps their place, as everywhere else.
      stickToBottom();
    },
    sendKey: (event) => {
      sendGuarded((recordId, fence) => encodeTerminalKeyIntent(recordId, fence, event));
    },
    sendText: (text) => {
      if (!text) return;
      sendGuarded((recordId, fence) => encodeTerminalTextIntent(recordId, fence, text));
    },
    dispose: () => {
      disposed = true;
      keyboard.dispose();
      host.removeEventListener("copy", onCopy);
      stopTouchScroll();
      host.removeEventListener("scroll", readScrollPosition);
      scrollToBottomButton.remove();
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      host.removeEventListener("click", focus);
      renderer.clear(grid);
      host.replaceChildren();
    },
  };
}

function parseControlRecord(bytes: Uint8Array): string | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object") return "structured_terminal_control_invalid";
    const record = value as Record<string, unknown>;
    if (record.kind === "closed") {
      return describeError({
        code: typeof record.code === "string" ? record.code : "structured_terminal_closed",
        message: typeof record.message === "string" ? record.message : "structured_terminal_closed",
      });
    }
    if (record.kind !== "control") return null;
    const body = record.body;
    if (!body || typeof body !== "object") return "structured_terminal_control_invalid";
    const control = body as Record<string, unknown>;
    if (control.kind !== "exit" && control.kind !== "error") return null;
    const payload = control.payload;
    if (payload && typeof payload === "object") {
      const details = payload as Record<string, unknown>;
      const message = control.kind === "exit" ? details.reason : details.message;
      if (typeof message === "string") return message;
    }
    return `hmux_${String(control.kind)}`;
  } catch {
    return "structured_terminal_control_invalid";
  }
}

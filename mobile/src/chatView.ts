/**
 * The Chat tab of a session (#361): the agent's conversation as messages, and
 * a composer that is always enabled.
 *
 * # Why a controller rather than a render function
 *
 * The app redraws a screen by replacing its whole tree. A chat drawn that way
 * would lose the person's draft, their place in the history and the queued
 * prompt's in-flight state on every census or toast. So, like the terminal's
 * transcript node, one chat node lives as long as the attachment and is
 * re-mounted into each new tree; what changes is painted onto it in place.
 *
 * # What it asks and when
 *
 * The transcript is asked for when the chat is shown, when the attached
 * session's runtime reports a turn starting or ending, on pull-to-refresh and
 * on a slow interval while the chat is visible. Each ask echoes the previous
 * cursor, so the computer answers `unchanged` cheaply when nothing moved.
 *
 * A queued prompt (see `chatQueue.ts`) is delivered whenever the runtime
 * reports the agent idle with no attention — whichever tab is showing.
 *
 * # Who settles a delivery
 *
 * Leaving a session and coming back makes a new controller while the old one
 * may still be waiting for the computer's answer. A delivery in flight is
 * therefore held per session in [`flights`], outside any controller: a new
 * controller for that session adopts it, shows it as sending and settles it,
 * and the old one leaves storage alone. A `sending` mark in storage with no
 * flight here can only be a delivery a closed app never heard back from.
 */

import "./chatView.css";
import type { AgentRuntimeState } from "./agentRuntimeState";
import iconArrowRight from "./assets/icon-arrow-right.svg";
import {
  agentReadiness,
  applyTranscriptAnswer,
  CHAT_POLL_INTERVAL_MS,
  type ChatFallback,
  type ChatTranscript,
  type ChatWait,
  chatRows,
  completedTurns,
  refreshMark,
  type SentPrompt,
  sendsNow,
  sentPrompt,
  sentPromptSettled,
  type TranscriptStep,
  transcriptFailure,
} from "./chat";
import { type ChatBlock, type ChatInline, chatBlocks } from "./chatMarkdown";
import {
  afterDelivery,
  type DeliveryResult,
  deliveryDue,
  editQueuedPrompt,
  enqueuePrompt,
  loadChatEntry,
  type PromptProblem,
  type PromptTarget,
  type QueuedPrompt,
  type ReturnReason,
  returnToComposer,
  saveQueuedPrompt,
  saveReturnedDraft,
  settleDelivery,
} from "./chatQueue";
import { element, glyph, loader } from "./dom";
import { t } from "./i18n";
import type { AgentPromptAnswer, ConversationCursor, ConversationTranscriptAnswer } from "./ipc";
import { attachPullToRefresh } from "./pullToRefresh";

export interface ChatViewOptions {
  /** `chatQueue.queueKey` of this session. */
  readonly queueKey: string;
  /** The provider process the catalog named, until a transcript names one. */
  readonly terminalEpoch: string;
  readonly fetch: (after?: ConversationCursor) => Promise<ConversationTranscriptAnswer>;
  readonly send: (text: string, target: PromptTarget) => Promise<AgentPromptAnswer>;
  /** The one-tap way to the Terminal tab. */
  readonly openTerminal: () => void;
  /** The chat cannot serve this session; the caller switches to Terminal and says why. */
  readonly fallBack: (fallback: ChatFallback) => void;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
}

export interface ChatController {
  /** Put the chat into `container`. Its draft, messages and place are kept. */
  mount(container: HTMLElement): void;
  /** The attached session's runtime state, each time it changes. */
  observe(runtime: AgentRuntimeState | undefined): void;
  /** Shown or hidden by the Chat / Terminal switch. Polls only while shown. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

type ComposerNote =
  | { readonly kind: "problem"; readonly problem: PromptProblem }
  | { readonly kind: "returned"; readonly reason: ReturnReason };

const WAIT_TEXT: Record<ChatWait, string> = {
  conversation_unknown: "chat.wait.conversationUnknown",
  transcript_unavailable: "chat.wait.transcriptUnavailable",
  probe_timeout: "chat.wait.unreachable",
  unavailable: "chat.wait.unreachable",
  unreachable: "chat.wait.unreachable",
  no_answer: "chat.wait.noAnswer",
  session_not_found: "chat.wait.sessionNotFound",
  unknown: "chat.wait.unknown",
};

/** The fallback's one line, also shown by the caller as it switches to Terminal. */
export const FALLBACK_TEXT: Record<ChatFallback, string> = {
  update_phone: "chat.fallback.updatePhone",
  not_available: "chat.fallback.notAvailable",
};

function returnedText(reason: ReturnReason): string {
  switch (reason) {
    case "identity_changed":
      return t("chat.returned.identityChanged");
    case "input_draft_pending":
      return t("chat.returned.inputDraftPending");
    case "uncertain":
      return t("chat.returned.uncertain");
    case "unsupported_runtime":
    case "remote_unsupported":
      return t("chat.fallback.notAvailable");
    case "unavailable":
    case "session_not_found":
      return t("chat.returned.unavailable");
    case "conversation_unknown":
      return t("chat.returned.conversationUnknown");
    case "invalid_request":
      return t("chat.returned.invalid");
    default:
      return t("chat.returned.notSent");
  }
}

function problemText(problem: PromptProblem): string {
  switch (problem.kind) {
    case "empty":
      return "";
    case "control":
      return t("chat.problem.control");
    case "too_long":
      return t("chat.problem.tooLong", { bytes: problem.bytes, limit: problem.limit });
  }
}

function inline(spans: readonly ChatInline[]): Node[] {
  return spans.map((span) => {
    if (span.kind === "code") return element("code", "chat__inline-code", span.text);
    if (span.kind === "strong") return element("strong", undefined, span.text);
    return document.createTextNode(span.text);
  });
}

function block(item: ChatBlock): HTMLElement {
  switch (item.kind) {
    case "paragraph": {
      const paragraph = element("p", "chat__p");
      paragraph.append(...inline(item.inline));
      return paragraph;
    }
    case "code": {
      const pre = element("pre", "chat__code");
      pre.append(element("code", undefined, item.text));
      return pre;
    }
    case "list": {
      const list = element(item.ordered ? "ol" : "ul", "chat__list-block");
      if (item.ordered && item.start !== 1) list.setAttribute("start", String(item.start));
      for (const entry of item.items) {
        const li = element("li");
        li.append(...inline(entry));
        list.append(li);
      }
      return list;
    }
  }
}

function messageRow(role: "user" | "agent", text: string, truncated: boolean): HTMLElement {
  const row = element("div", `chat__row chat__row--${role}`);
  const bubble = element("div", "chat__bubble");
  if (role === "agent") bubble.append(...chatBlocks(text).map(block));
  else bubble.append(element("p", "chat__p", text));
  if (truncated) bubble.append(element("p", "chat__truncated", t("chat.truncated")));
  row.append(bubble);
  return row;
}

/** Close enough to the end that new messages should keep it in view. */
const BOTTOM_SLACK_PX = 32;

/** One delivery on its way to the computer. */
interface Flight {
  readonly prompt: QueuedPrompt;
  /** What the bubble waits for once the computer has written it. */
  readonly sent: SentPrompt;
  readonly result: Promise<DeliveryResult>;
  /** The controller that settles it: the one that started it, or one that adopted it. */
  owner: object;
}

/**
 * Deliveries in flight, by `queueKey`, for as long as this app runs.
 *
 * Module state on purpose: it is the one fact that must outlive the
 * controller that started it. See "Who settles a delivery" above.
 */
const flights = new Map<string, Flight>();

export function createChatView(options: ChatViewOptions): ChatController {
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollIntervalMs ?? CHAT_POLL_INTERVAL_MS;
  const key = options.queueKey;
  const self = {};

  let transcript: ChatTranscript | undefined;
  let wait: ChatWait | undefined;
  let silentCloses = 0;
  let fallback: ChatFallback | undefined;
  let queued: QueuedPrompt | undefined;
  let sent: SentPrompt | undefined;
  let note: ComposerNote | undefined;
  /** Text given back to the composer stays stored, with why, until sent or cleared. */
  let returned: ReturnReason | undefined;
  let runtime: AgentRuntimeState | undefined;
  let lastMark: string | undefined;
  let delivering = false;
  let fetching = false;
  let again: { force: boolean } | undefined;
  let visible = false;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pinned = true;
  let savedScrollTop = 0;
  /** The person was typing here; a re-render moving the field must not end that. */
  let wantsFocus = false;

  const root = element("section", "chat");
  const scroll = element("div", "chat__scroll");
  const pull = element("div", "home__pull chat__pull");
  pull.append(element("span", "home__pull-mark"));
  const older = element("p", "chat__older", t("chat.older"));
  const list = element("div", "chat__messages");
  list.setAttribute("role", "log");
  list.setAttribute("aria-label", t("chat.messages"));
  const outgoing = element("div", "chat__outgoing");
  const status = element("p", "chat__status");
  scroll.append(pull, older, list, outgoing, status);

  const attention = element("div", "chat__attention");
  const attentionText = element("span", "chat__attention-text");
  const openTerminal = element("button", "chat__attention-action", t("chat.openTerminal"));
  openTerminal.type = "button";
  openTerminal.addEventListener("click", () => options.openTerminal());
  attention.append(attentionText, openTerminal);

  const composerNote = element("p", "chat__note");
  composerNote.setAttribute("role", "status");
  const composer = element("div", "chat__composer");
  const input = element("textarea", "chat__input");
  input.rows = 1;
  input.setAttribute("aria-label", t("chat.composer.label"));
  const send = element("button", "chat__send");
  send.type = "button";
  send.append(glyph(iconArrowRight, 18));
  composer.append(input, send);
  root.append(scroll, attention, composerNote, composer);

  const readiness = () => agentReadiness(runtime);

  const target = (): PromptTarget => {
    const conversationId = transcript?.conversationId ?? transcript?.cursor?.conversation_id;
    return {
      terminalEpoch: transcript?.cursor?.terminal_epoch ?? options.terminalEpoch,
      ...(conversationId ? { conversationId } : {}),
    };
  };

  const persist = () => saveQueuedPrompt(options.storage, key, queued, delivering);

  /** Put text back in the composer, in front of the draft, and keep it stored. */
  const giveBack = (text: string, reason: ReturnReason) => {
    input.value = returnToComposer(text, input.value);
    returned = reason;
    note = { kind: "returned", reason };
    saveReturnedDraft(options.storage, key, input.value, reason);
  };

  const followEnd = () => {
    if (pinned && scroll.isConnected) scroll.scrollTop = scroll.scrollHeight;
  };

  scroll.addEventListener("scroll", () => {
    if (!scroll.isConnected) return;
    savedScrollTop = scroll.scrollTop;
    pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < BOTTOM_SLACK_PX;
  });

  input.addEventListener("focus", () => {
    wantsFocus = true;
  });
  input.addEventListener("blur", () => {
    // Moving the field into the next render's tree can blur it; the restore in
    // `mount` runs before this looks. A field still in the tree and still not
    // focused is one the person left.
    setTimeout(() => {
      if (input.isConnected && document.activeElement !== input) wantsFocus = false;
    }, 0);
  });

  const paintRows = () => {
    older.hidden = !transcript || transcript.historyComplete;
    list.replaceChildren(
      ...chatRows(transcript?.entries ?? []).map((row) =>
        messageRow(row.role, row.text, row.truncated),
      ),
    );
  };

  // Runtime records arrive often while an agent works; repainting a bubble
  // nobody changed would take the Edit or Cancel being pressed out from under
  // the finger.
  let outgoingDrawn: string | undefined;
  let statusDrawn: string | undefined;

  const paintOutgoing = () => {
    const drawn = JSON.stringify([queued?.text, queued?.wait, delivering, sent?.text]);
    if (drawn === outgoingDrawn) return;
    outgoingDrawn = drawn;
    outgoing.replaceChildren();
    if (queued) {
      const row = messageRow("user", queued.text, false);
      row.classList.add("chat__row--queued");
      const meta = element("div", "chat__meta");
      if (delivering) {
        meta.append(loader(12), element("span", undefined, t("chat.queue.sending")));
      } else {
        const lines = element("div", "chat__meta-text");
        lines.append(element("span", undefined, t("chat.queue.queued")));
        lines.append(element("span", "chat__meta-hint", t("chat.queue.keepOpen")));
        if (queued.wait === "unreachable" || queued.wait === "probe_timeout") {
          lines.append(element("span", "chat__meta-hint", t("chat.queue.retrying")));
        }
        const edit = element("button", "chat__meta-action", t("chat.queue.edit"));
        edit.type = "button";
        edit.addEventListener("click", () => {
          if (!queued || delivering) return;
          input.value = editQueuedPrompt(queued, input.value);
          queued = undefined;
          persist();
          paint();
          input.focus();
        });
        const cancel = element("button", "chat__meta-action", t("chat.queue.cancel"));
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          if (!queued || delivering) return;
          queued = undefined;
          persist();
          paint();
        });
        meta.append(lines, edit, cancel);
      }
      row.append(meta);
      outgoing.append(row);
    } else if (sent) {
      const row = messageRow("user", sent.text, false);
      row.classList.add("chat__row--sent");
      row.append(element("div", "chat__meta", t("chat.sent")));
      outgoing.append(row);
    }
  };

  const paintStatus = () => {
    const state = readiness();
    const empty = list.childElementCount === 0 && !queued && !sent;
    const drawn = JSON.stringify([fallback, wait, transcript === undefined, state, empty]);
    if (drawn === statusDrawn) return;
    statusDrawn = drawn;
    const parts: Node[] = [];
    const say = (text: string) => parts.push(element("span", undefined, t(text)));
    if (fallback) {
      say(FALLBACK_TEXT[fallback]);
      const retry = element("button", "chat__meta-action", t("chat.retry"));
      retry.type = "button";
      retry.addEventListener("click", () => {
        fallback = undefined;
        paint();
        void refresh(true);
        if (visible) startPolling();
      });
      parts.push(retry);
    } else if (wait) {
      say(WAIT_TEXT[wait]);
    } else if (!transcript) {
      parts.push(loader(12));
      say("chat.loading");
    } else if (state === "working") {
      parts.push(loader(12));
      say("chat.status.working");
    } else if (state === "exited") {
      say("chat.status.exited");
    } else if (empty) {
      say("chat.empty");
    }
    status.replaceChildren(...parts);
    status.hidden = parts.length === 0;
  };

  const paintAttention = () => {
    const showing = readiness() === "attention";
    attention.hidden = !showing;
    attentionText.textContent = runtime?.attention === "error"
      ? t("chat.attention.error") : t("chat.attention.asking");
  };

  /** Grow with the text up to the stylesheet's cap. */
  const fitInput = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };

  const paintComposer = () => {
    fitInput();
    const now = sendsNow(readiness(), queued !== undefined);
    input.placeholder = now ? t("chat.composer.placeholder") : t("chat.composer.placeholderQueued");
    send.setAttribute("aria-label", now ? t("chat.composer.send") : t("chat.composer.queue"));
    send.disabled = input.value.trim() === "";
    if (!note) {
      composerNote.hidden = true;
      composerNote.textContent = "";
      return;
    }
    const text = note.kind === "problem" ? problemText(note.problem) : returnedText(note.reason);
    composerNote.hidden = text === "";
    composerNote.textContent = text;
  };

  function paint(rows = false): void {
    if (rows) paintRows();
    paintOutgoing();
    paintStatus();
    paintAttention();
    paintComposer();
    followEnd();
  }

  const applyStep = (step: TranscriptStep) => {
    if (step.kind === "fallback") {
      wait = undefined;
      if (fallback !== step.fallback) {
        fallback = step.fallback;
        stopPolling();
        options.fallBack(step.fallback);
      }
      paint();
      return;
    }
    if (step.kind === "wait") {
      wait = step.wait;
      paint();
      return;
    }
    wait = undefined;
    transcript = step.transcript;
    if (sent && sentPromptSettled(sent, step.transcript)) sent = undefined;
    paint(step.changed);
  };

  /** One transcript ask at a time; asks that arrive meanwhile run once after it. */
  async function refresh(force = false): Promise<void> {
    if (disposed || fallback) return;
    if (fetching) {
      again = { force: force || (again?.force ?? false) };
      return;
    }
    fetching = true;
    try {
      const answer = await options.fetch(force ? undefined : transcript?.cursor);
      silentCloses = 0;
      if (!disposed) applyStep(applyTranscriptAnswer(force ? undefined : transcript, answer));
    } catch (error) {
      const failed = transcriptFailure(error, silentCloses);
      silentCloses = failed.silentCloses;
      if (!disposed) applyStep(failed.step);
    } finally {
      fetching = false;
      const next = again;
      again = undefined;
      if (next && !disposed) void refresh(next.force);
    }
  }

  /** Settle a delivery this controller owns, into its state and storage. */
  function settle(flight: Flight, result: DeliveryResult): void {
    delivering = false;
    const delivery = settleDelivery(flight.prompt, result);
    // A send made meanwhile added to the prompt in flight; this splits it again.
    const after = afterDelivery(flight.prompt, queued, delivery);
    queued = after.queued;
    if (after.returned) {
      if (disposed) {
        // Nowhere on screen to put it: stored as given back, for the next open.
        saveReturnedDraft(options.storage, key, after.returned.text, after.returned.reason);
        return;
      }
      giveBack(after.returned.text, after.returned.reason);
    } else {
      persist();
    }
    if (disposed) return;
    if (delivery.kind === "kept" && retryTimer === undefined) {
      // "Not now" waits for the next idle report; this is the floor under it,
      // for a refusal that raced a report already seen.
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void deliver();
      }, pollMs);
    }
    if (after.sent !== undefined) {
      sent = flight.sent;
      if (note?.kind === "problem") note = undefined;
    }
    paint();
    if (after.sent !== undefined || after.returned) void refresh();
    // What was added during the delivery goes next, if the agent is still idle.
    if (after.sent !== undefined && queued) void deliver();
  }

  /** Wait for a flight, and settle it if it is still this controller's. */
  async function follow(flight: Flight): Promise<void> {
    const result = await flight.result;
    if (flights.get(key) === flight) flights.delete(key);
    if (flight.owner === self) settle(flight, result);
  }

  /** Deliver the queued prompt if the agent is idle. */
  function deliver(): void {
    if (disposed || !deliveryDue(queued, readiness(), delivering) || !queued) return;
    const prompt = queued;
    delivering = true;
    // Marked before it leaves: an app that dies now finds it interrupted, not due.
    persist();
    paint();
    const flight: Flight = {
      prompt,
      // From the session's own turn count at this moment, not the last read.
      sent: sentPrompt(prompt.text, transcript, completedTurns(runtime)),
      owner: self,
      result: options.send(prompt.text, prompt.target).then(
        (answer): DeliveryResult => ({ kind: "answer", answer }),
        (error): DeliveryResult => ({ kind: "error", error }),
      ),
    };
    flights.set(key, flight);
    void follow(flight);
  }

  // What this session left behind: a delivery still in flight in this app, a
  // queued prompt, or text that was given back to the composer.
  const entry = loadChatEntry(options.storage, key);
  const inFlight = flights.get(key);
  if (inFlight) {
    inFlight.owner = self;
    delivering = true;
    queued = entry?.kind === "queued"
      ? { text: entry.prompt.text, target: entry.prompt.target, queuedAtMs: entry.prompt.queuedAtMs }
      : inFlight.prompt;
    void follow(inFlight);
  } else if (entry?.kind === "queued" && entry.prompt.interrupted) {
    // A closed app never heard back, so the computer may have written it.
    giveBack(entry.prompt.text, "uncertain");
  } else if (entry?.kind === "queued") {
    queued = entry.prompt;
  } else if (entry?.kind === "returned") {
    input.value = entry.text;
    returned = entry.reason;
    note = { kind: "returned", reason: entry.reason };
  }

  const submit = () => {
    const result = enqueuePrompt(queued, input.value, target(), now());
    if (result.kind === "invalid") {
      note = { kind: "problem", problem: result.problem };
      paint();
      return;
    }
    queued = result.prompt;
    // Replaces any given-back text in storage: it is in this prompt now.
    returned = undefined;
    persist();
    input.value = "";
    note = undefined;
    pinned = true;
    paint();
    deliver();
  };
  send.addEventListener("click", submit);
  // The send circle must not take the keyboard down with the field's focus.
  send.addEventListener("pointerdown", (event) => event.preventDefault());
  input.addEventListener("input", () => {
    send.disabled = input.value.trim() === "";
    fitInput();
    if (returned !== undefined) {
      // Edited given-back text is still given back; cleared, it is discarded.
      saveReturnedDraft(options.storage, key, input.value, returned);
      if (input.value.trim() === "") {
        returned = undefined;
        note = undefined;
        paintComposer();
      }
    }
  });

  attachPullToRefresh(scroll, pull, () => void refresh(true), () => scroll.scrollTop);

  function startPolling(): void {
    if (timer !== undefined || disposed || fallback) return;
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, pollMs);
  }

  function stopPolling(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  paint(true);

  return {
    mount(container) {
      if (root.parentElement === container) return;
      // Read before the move: the app replaced the old tree already, and the
      // field may have lost focus with it, but its selection is still its own.
      const restore = wantsFocus;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const direction = input.selectionDirection;
      container.append(root);
      // After the caller's tree is in the document: a detached node has no
      // scroll position to restore and cannot take focus.
      queueMicrotask(() => {
        if (!scroll.isConnected) return;
        if (pinned) scroll.scrollTop = scroll.scrollHeight;
        else scroll.scrollTop = savedScrollTop;
        // Same task as the render that moved it, so the OS keyboard stays up.
        if (restore && document.activeElement !== input) {
          input.focus({ preventScroll: true });
          input.setSelectionRange(start, end, direction ?? undefined);
        }
      });
    },
    observe(next) {
      runtime = next;
      const mark = refreshMark(next);
      if (mark !== lastMark) {
        const first = lastMark === undefined;
        lastMark = mark;
        if (visible && !first) void refresh();
      }
      paint();
      deliver();
    },
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      if (visible) {
        void refresh();
        startPolling();
      } else {
        // Hidden by a tab switch or a covering screen: the person left the field.
        wantsFocus = false;
        stopPolling();
      }
    },
    dispose() {
      disposed = true;
      stopPolling();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
}

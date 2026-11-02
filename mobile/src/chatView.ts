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
  loadQueuedPrompt,
  type PromptProblem,
  type PromptTarget,
  type QueuedPrompt,
  type ReturnReason,
  returnToComposer,
  saveQueuedPrompt,
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
  session_not_found: "chat.wait.sessionNotFound",
  unknown: "chat.wait.unknown",
};

/** The fallback's one line, also shown by the caller as it switches to Terminal. */
export const FALLBACK_TEXT: Record<ChatFallback, string> = {
  update_computer: "chat.fallback.updateComputer",
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
    case "unsupported":
      return t("chat.fallback.updateComputer");
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

export function createChatView(options: ChatViewOptions): ChatController {
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollIntervalMs ?? CHAT_POLL_INTERVAL_MS;

  let transcript: ChatTranscript | undefined;
  let wait: ChatWait | undefined;
  let fallback: ChatFallback | undefined;
  let queued: QueuedPrompt | undefined = loadQueuedPrompt(options.storage, options.queueKey);
  let sent: SentPrompt | undefined;
  let note: ComposerNote | undefined;
  // The app went away while this was being delivered, so it may have been
  // written. It goes back to the composer, said as such, and nowhere else.
  const interrupted = queued?.interrupted ? queued.text : undefined;
  if (interrupted !== undefined) {
    queued = undefined;
    note = { kind: "returned", reason: "uncertain" };
  }
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
  if (interrupted !== undefined) {
    input.value = interrupted;
    saveQueuedPrompt(options.storage, options.queueKey, undefined);
  }
  root.append(scroll, attention, composerNote, composer);

  const readiness = () => agentReadiness(runtime);

  const target = (): PromptTarget => {
    const conversationId = transcript?.conversationId ?? transcript?.cursor?.conversation_id;
    return {
      terminalEpoch: transcript?.cursor?.terminal_epoch ?? options.terminalEpoch,
      ...(conversationId ? { conversationId } : {}),
    };
  };

  const persist = () => saveQueuedPrompt(options.storage, options.queueKey, queued, delivering);

  const followEnd = () => {
    if (pinned && scroll.isConnected) scroll.scrollTop = scroll.scrollHeight;
  };

  scroll.addEventListener("scroll", () => {
    if (!scroll.isConnected) return;
    savedScrollTop = scroll.scrollTop;
    pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < BOTTOM_SLACK_PX;
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
    const say = (key: string) => parts.push(element("span", undefined, t(key)));
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
      if (!disposed) applyStep(applyTranscriptAnswer(force ? undefined : transcript, answer));
    } catch (error) {
      if (!disposed) applyStep(transcriptFailure(error));
    } finally {
      fetching = false;
      const next = again;
      again = undefined;
      if (next && !disposed) void refresh(next.force);
    }
  }

  /** Deliver the queued prompt if the agent is idle. */
  async function deliver(): Promise<void> {
    if (disposed || !deliveryDue(queued, readiness(), delivering) || !queued) return;
    const prompt = queued;
    delivering = true;
    // Marked before it leaves: an app that dies now finds it interrupted, not due.
    persist();
    paint();
    let result: DeliveryResult;
    try {
      result = { kind: "answer", answer: await options.send(prompt.text, prompt.target) };
    } catch (error) {
      result = { kind: "error", error };
    }
    delivering = false;
    const delivery = settleDelivery(prompt, result);
    // A send made meanwhile added to the prompt in flight; this splits it again.
    const after = afterDelivery(prompt, queued, delivery);
    queued = after.queued;
    // Settled into storage even after the screen went away, so a prompt the
    // computer wrote is never delivered a second time from the queue.
    if (disposed && after.returned) {
      // Nowhere to give the text back to: it waits for the next open, which
      // hands it to the composer (as unconfirmed, when it may have been written)
      // or tries it again.
      saveQueuedPrompt(
        options.storage,
        options.queueKey,
        { ...prompt, text: after.returned.text },
        after.returned.reason === "uncertain",
      );
      return;
    }
    persist();
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
      sent = sentPrompt(after.sent, transcript);
      note = undefined;
    }
    if (after.returned) {
      input.value = returnToComposer(after.returned.text, input.value);
      note = { kind: "returned", reason: after.returned.reason };
    }
    paint();
    if (after.sent !== undefined || after.returned) void refresh();
    // What was added during the delivery goes next, if the agent is still idle.
    if (after.sent !== undefined && queued) void deliver();
  }

  const submit = () => {
    const result = enqueuePrompt(queued, input.value, target(), now());
    if (result.kind === "invalid") {
      note = { kind: "problem", problem: result.problem };
      paint();
      return;
    }
    queued = result.prompt;
    persist();
    input.value = "";
    note = undefined;
    pinned = true;
    paint();
    void deliver();
  };
  send.addEventListener("click", submit);
  // The send circle must not take the keyboard down with the field's focus.
  send.addEventListener("pointerdown", (event) => event.preventDefault());
  input.addEventListener("input", () => {
    send.disabled = input.value.trim() === "";
    fitInput();
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
      container.append(root);
      // After the caller's tree is in the document: a detached node has no
      // scroll position to restore.
      queueMicrotask(() => {
        if (!scroll.isConnected) return;
        if (pinned) scroll.scrollTop = scroll.scrollHeight;
        else scroll.scrollTop = savedScrollTop;
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
      void deliver();
    },
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      if (visible) {
        void refresh();
        startPolling();
      } else {
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

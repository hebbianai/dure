/**
 * The chat of a chat-owned agent (#562): its timeline, the requests waiting
 * for the person, and a composer. There is no terminal behind it.
 *
 * # Why a controller
 *
 * As in `chatView.ts`: the app redraws a screen by replacing its tree, and a
 * chat drawn that way would lose the draft and the place in the history on
 * every redraw. One node lives as long as the screen and is mounted into each
 * new tree; what changes is painted onto it in place.
 *
 * # What it asks and when
 *
 * The timeline is asked for when the chat is shown, after each action, on
 * pull-to-refresh, and on an interval while it is shown — faster while a turn
 * runs or a request waits (`agentChatActive`). The computer decides where a
 * message goes; the chat says what it decided.
 */

import "./chatView.css";
import "./agentChatView.css";
import {
  AGENT_CHAT_ACTIVE_POLL_MS,
  AGENT_CHAT_IDLE_POLL_MS,
  type AgentChatFallback,
  type AgentChatNotice,
  type AgentChatStep,
  type AgentChatWait,
  actionError,
  actionNotice,
  agentChatActive,
  applyTimelineAnswer,
  choose,
  mergeOlder,
  newActionId,
  questionAnswers,
  statusKey,
  timelineFailure,
  toolStateKey,
} from "./agentChat";
import iconArrowRight from "./assets/icon-arrow-right.svg";
import iconChevronLeft from "./assets/icon-chevron-left.svg";
import { messageRow } from "./chatView";
import { element, glyph, loader } from "./dom";
import { t } from "./i18n";
import type {
  AgentChatAction,
  AgentChatActionAnswer,
  AgentChatItem,
  AgentChatPending,
  AgentChatTimeline,
  AgentChatTimelineAnswer,
} from "./ipc";
import { attachPullToRefresh } from "./pullToRefresh";

export interface AgentChatViewOptions {
  /** Read the newest rows, or those before `before`. */
  readonly fetch: (before?: number) => Promise<AgentChatTimelineAnswer>;
  readonly act: (action: AgentChatAction) => Promise<AgentChatActionAnswer>;
  readonly activePollMs?: number;
  readonly idlePollMs?: number;
  readonly actionId?: (kind: string) => string;
}

export interface AgentChatController {
  mount(container: HTMLElement): void;
  /** Polls only while shown. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

const WAIT_TEXT: Record<AgentChatWait, string> = {
  unreachable: "agentChat.wait.unreachable",
  unavailable: "agentChat.wait.unavailable",
  agent_not_found: "agentChat.wait.agentNotFound",
  unknown: "agentChat.wait.unknown",
};

export const AGENT_CHAT_FALLBACK_TEXT: Record<AgentChatFallback, string> = {
  update_desktop: "agentChat.fallback.updateDesktop",
  update_phone: "agentChat.fallback.updatePhone",
};

/** Close enough to the end that new rows should keep it in view. */
const BOTTOM_SLACK_PX = 32;

function itemRow(item: AgentChatItem): HTMLElement | undefined {
  switch (item.kind) {
    case "message":
      return item.text.trim() === "" ? undefined : messageRow(item.role, item.text, item.truncated === true);
    case "tool": {
      // By name and state only: the input stays on the computer.
      const row = element("div", `agent-chat__tool agent-chat__tool--${item.state}`);
      row.append(
        element("span", "agent-chat__tool-name", item.name),
        element("span", "agent-chat__tool-state", t(toolStateKey(item.state))),
      );
      return row;
    }
    case "status":
      return element("p", "agent-chat__status-row", t(statusKey(item.state)));
    case "error":
      return element("p", "agent-chat__error-row", item.message);
    default:
      return undefined;
  }
}

function noticeText(notice: AgentChatNotice): string {
  return t(notice.key, notice.values);
}

export function createAgentChatView(options: AgentChatViewOptions): AgentChatController {
  const activeMs = options.activePollMs ?? AGENT_CHAT_ACTIVE_POLL_MS;
  const idleMs = options.idlePollMs ?? AGENT_CHAT_IDLE_POLL_MS;
  const actionId = options.actionId ?? ((kind: string) => newActionId(kind));

  let timeline: AgentChatTimeline | undefined;
  let wait: AgentChatWait | undefined;
  let fallback: AgentChatFallback | undefined;
  let silentCloses = 0;
  let notice: AgentChatNotice | undefined;
  /** The message on its way, drawn until the timeline carries it. */
  let sending: string | undefined;
  let interrupting = false;
  let answering: string | undefined;
  let loadingOlder = false;
  let fetching = false;
  let again = false;
  let visible = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pinned = true;
  let savedScrollTop = 0;
  let wantsFocus = false;
  /** Per pending question card: chosen options and own words, by question. */
  const drafts = new Map<string, { selections: ReadonlySet<number>[]; others: string[] }>();

  const root = element("section", "chat agent-chat");
  const scroll = element("div", "chat__scroll");
  const pull = element("div", "home__pull chat__pull");
  pull.append(element("span", "home__pull-mark"));
  const older = element("button", "agent-chat__older", t("agentChat.older"));
  older.type = "button";
  const list = element("div", "chat__messages");
  list.setAttribute("role", "log");
  list.setAttribute("aria-label", t("chat.messages"));
  const outgoing = element("div", "chat__outgoing");
  const status = element("p", "chat__status");
  scroll.append(pull, older, list, outgoing, status);
  const cards = element("div", "agent-chat__cards");
  const composerNote = element("p", "chat__note");
  composerNote.setAttribute("role", "status");
  const composer = element("div", "chat__composer");
  const input = element("textarea", "chat__input");
  input.rows = 1;
  input.setAttribute("aria-label", t("chat.composer.label"));
  input.placeholder = t("chat.composer.placeholder");
  const stop = element("button", "agent-chat__stop", t("agentChat.stop"));
  stop.type = "button";
  const send = element("button", "chat__send");
  send.type = "button";
  send.setAttribute("aria-label", t("chat.composer.send"));
  send.append(glyph(iconArrowRight, 18));
  composer.append(input, stop, send);
  root.append(scroll, cards, composerNote, composer);

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
    setTimeout(() => {
      if (input.isConnected && document.activeElement !== input) wantsFocus = false;
    }, 0);
  });

  let rowsDrawn = "";
  const paintRows = () => {
    older.hidden = timeline?.older == null;
    older.disabled = loadingOlder;
    const drawn = JSON.stringify([timeline?.items, timeline?.live_text, timeline?.turn, timeline?.queued, sending]);
    if (drawn === rowsDrawn) return;
    rowsDrawn = drawn;
    list.replaceChildren(
      ...(timeline?.items ?? []).flatMap((item) => {
        const row = itemRow(item);
        return row ? [row] : [];
      }),
    );
    outgoing.replaceChildren();
    const live = timeline?.turn ? timeline.live_text?.trim() : undefined;
    if (live) {
      const row = messageRow("agent", live, false);
      row.classList.add("agent-chat__live");
      outgoing.append(row);
    }
    for (const queued of timeline?.queued ?? []) {
      const row = messageRow("user", queued.preview, false);
      row.classList.add("chat__row--queued");
      row.append(element("div", "chat__meta", t("agentChat.queued")));
      outgoing.append(row);
    }
    if (sending !== undefined) {
      const row = messageRow("user", sending, false);
      row.classList.add("chat__row--queued");
      const meta = element("div", "chat__meta");
      meta.append(loader(12), element("span", undefined, t("chat.queue.sending")));
      row.append(meta);
      outgoing.append(row);
    }
  };

  const paintStatus = () => {
    const parts: Node[] = [];
    if (fallback) {
      parts.push(element("span", undefined, t(AGENT_CHAT_FALLBACK_TEXT[fallback])));
      const retry = element("button", "chat__meta-action", t("chat.retry"));
      retry.type = "button";
      retry.addEventListener("click", () => {
        fallback = undefined;
        silentCloses = 0;
        paint();
        void refresh();
      });
      parts.push(retry);
    } else if (wait) {
      parts.push(element("span", undefined, t(WAIT_TEXT[wait])));
    } else if (!timeline) {
      parts.push(loader(12), element("span", undefined, t("chat.loading")));
    } else if (timeline.turn) {
      parts.push(loader(12), element("span", undefined, t("chat.status.working")));
    } else if (timeline.items.length === 0 && sending === undefined) {
      parts.push(element("span", undefined, t("chat.empty")));
    }
    status.replaceChildren(...parts);
    status.hidden = parts.length === 0;
  };

  const answer = async (pending: AgentChatPending, value: AgentChatAction & { kind: "answer" }) => {
    if (answering) return;
    answering = pending.request_id;
    paint();
    try {
      const result = await options.act(value);
      if (disposed) return;
      notice = actionNotice("answer", result);
      if (result.state === "done") drafts.delete(pending.request_id);
    } catch {
      if (disposed) return;
      notice = actionError("answer");
    } finally {
      answering = undefined;
    }
    paint();
    void refresh();
  };

  const permissionCard = (pending: AgentChatPending & { kind: "permission" }) => {
    const card = element("div", "agent-chat__card");
    const name = pending.display_name?.trim() || pending.tool_name?.trim();
    card.append(
      element(
        "p",
        "agent-chat__card-title",
        name ? t("agentChat.permission.named", { tool: name }) : t("agentChat.permission.unnamed"),
      ),
      element("p", "agent-chat__card-hint", t("agentChat.permission.hint")),
    );
    const actions = element("div", "agent-chat__card-actions");
    const decide = (allow: boolean) => {
      void answer(pending, {
        kind: "answer",
        actionId: actionId("answer"),
        requestId: pending.request_id,
        answer: { kind: "permission", allow },
      });
    };
    const deny = element("button", "pair-button pair-button--outline", t("agentChat.permission.deny"));
    deny.type = "button";
    deny.disabled = answering !== undefined;
    deny.addEventListener("click", () => decide(false));
    const allow = element("button", "pair-button pair-button--solid", t("agentChat.permission.allow"));
    allow.type = "button";
    allow.disabled = answering !== undefined;
    allow.addEventListener("click", () => decide(true));
    actions.append(deny, allow);
    card.append(actions);
    return card;
  };

  const questionCard = (pending: AgentChatPending & { kind: "question" }) => {
    const draft = drafts.get(pending.request_id) ?? {
      selections: pending.questions.map(() => new Set<number>()),
      others: pending.questions.map(() => ""),
    };
    drafts.set(pending.request_id, draft);
    const card = element("div", "agent-chat__card");
    const submit = element("button", "pair-button pair-button--solid", t("agentChat.question.submit"));
    submit.type = "button";
    const ready = () => questionAnswers(pending.questions, draft.selections, draft.others);
    const refreshSubmit = () => {
      submit.disabled = answering !== undefined || ready() === undefined;
    };
    pending.questions.forEach((question, index) => {
      if (question.header) card.append(element("p", "agent-chat__card-hint", question.header));
      card.append(element("p", "agent-chat__card-title", question.question));
      const options = element("div", "agent-chat__options");
      question.options.forEach((option, optionIndex) => {
        const button = element("button", "agent-chat__option", option.label);
        button.type = "button";
        const selected = draft.selections[index]?.has(optionIndex) === true;
        button.setAttribute("aria-pressed", String(selected));
        if (option.description) button.title = option.description;
        button.addEventListener("click", () => {
          draft.selections[index] = choose(draft.selections[index], optionIndex, question.multi_select);
          for (const [other, node] of [...options.children].entries()) {
            node.setAttribute("aria-pressed", String(draft.selections[index]?.has(other) === true));
          }
          refreshSubmit();
        });
        options.append(button);
      });
      card.append(options);
      if (question.allow_other) {
        const other = element("input", "agent-chat__other");
        other.type = question.is_secret ? "password" : "text";
        other.placeholder = t("agentChat.question.other");
        other.value = draft.others[index] ?? "";
        other.addEventListener("input", () => {
          draft.others[index] = other.value;
          refreshSubmit();
        });
        card.append(other);
      }
    });
    submit.addEventListener("click", () => {
      const answers = ready();
      if (!answers) return;
      void answer(pending, {
        kind: "answer",
        actionId: actionId("answer"),
        requestId: pending.request_id,
        answer: { kind: "question", answers },
      });
    });
    refreshSubmit();
    const actions = element("div", "agent-chat__card-actions");
    actions.append(submit);
    card.append(actions);
    return card;
  };

  let cardsDrawn = "";
  const paintCards = () => {
    const pending = fallback ? [] : (timeline?.pending ?? []);
    const drawn = JSON.stringify([pending, answering]);
    if (drawn === cardsDrawn) return;
    cardsDrawn = drawn;
    cards.replaceChildren(
      ...pending.map((request) => {
        if (request.kind === "permission") return permissionCard(request);
        if (request.kind === "question") return questionCard(request);
        const card = element("div", "agent-chat__card");
        card.append(element("p", "agent-chat__card-title", t("agentChat.pending.elsewhere")));
        return card;
      }),
    );
    cards.hidden = pending.length === 0;
    for (const id of drafts.keys()) {
      if (!pending.some((request) => request.request_id === id)) drafts.delete(id);
    }
  };

  const fitInput = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };

  const paintComposer = () => {
    fitInput();
    send.disabled = sending !== undefined || input.value.trim() === "" || fallback !== undefined;
    stop.hidden = !timeline?.turn || fallback !== undefined;
    stop.disabled = interrupting;
    composerNote.hidden = notice === undefined;
    composerNote.textContent = notice ? noticeText(notice) : "";
  };

  function paint(): void {
    paintRows();
    paintStatus();
    paintCards();
    paintComposer();
    followEnd();
  }

  const applyStep = (step: AgentChatStep) => {
    if (step.kind === "fallback") {
      wait = undefined;
      fallback = step.fallback;
    } else if (step.kind === "wait") {
      wait = step.wait;
    } else {
      wait = undefined;
      timeline = step.timeline;
    }
    paint();
  };

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!visible || disposed || fallback) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return;
      }
      void refresh();
    }, agentChatActive(timeline) ? activeMs : idleMs);
  }

  /** One read at a time; one asked meanwhile runs after it. */
  async function refresh(): Promise<void> {
    if (disposed || fallback) return;
    if (fetching) {
      again = true;
      return;
    }
    fetching = true;
    try {
      const answer = await options.fetch();
      silentCloses = 0;
      if (!disposed) applyStep(applyTimelineAnswer(timeline, answer));
    } catch (error) {
      const failed = timelineFailure(error, silentCloses);
      silentCloses = failed.silentCloses;
      if (!disposed) applyStep(failed.step);
    } finally {
      fetching = false;
      if (again && !disposed) {
        again = false;
        void refresh();
      } else {
        schedule();
      }
    }
  }

  older.addEventListener("click", async () => {
    const before = timeline?.older;
    if (before == null || loadingOlder) return;
    loadingOlder = true;
    paintRows();
    try {
      const answer = await options.fetch(before);
      if (!disposed && timeline && answer.outcome === "timeline" && answer.timeline) {
        pinned = false;
        timeline = mergeOlder(timeline, answer.timeline);
      }
    } catch {
      // The button stays; the next press asks again.
    } finally {
      loadingOlder = false;
      rowsDrawn = "";
      if (!disposed) paint();
    }
  });

  const giveBack = (text: string) => {
    input.value = input.value.trim() === "" ? text : `${text}\n${input.value}`;
  };

  const submit = async () => {
    const text = input.value;
    if (sending !== undefined || text.trim() === "" || fallback) return;
    sending = text;
    input.value = "";
    notice = undefined;
    pinned = true;
    paint();
    try {
      const result = await options.act({ kind: "send", actionId: actionId("send"), text });
      if (disposed) return;
      notice = actionNotice("send", result);
    } catch {
      if (disposed) return;
      notice = actionError("send");
    } finally {
      sending = undefined;
    }
    if (notice?.giveBack) giveBack(text);
    paint();
    void refresh();
  };
  send.addEventListener("click", () => void submit());
  send.addEventListener("pointerdown", (event) => event.preventDefault());
  input.addEventListener("input", () => {
    send.disabled = sending !== undefined || input.value.trim() === "" || fallback !== undefined;
    fitInput();
  });

  stop.addEventListener("click", async () => {
    const turn = timeline?.turn;
    if (!turn || interrupting) return;
    interrupting = true;
    paintComposer();
    try {
      const result = await options.act({ kind: "interrupt", actionId: actionId("stop"), turnId: turn.turn_id });
      if (disposed) return;
      // A turn that already ended is what the person wanted.
      notice = result.state === "refused" && result.code === "not_running"
        ? undefined
        : actionNotice("interrupt", result);
    } catch {
      if (disposed) return;
      notice = actionError("interrupt");
    } finally {
      interrupting = false;
    }
    paint();
    void refresh();
  });

  attachPullToRefresh(scroll, pull, () => void refresh(), () => scroll.scrollTop);

  paint();

  return {
    mount(container) {
      if (root.parentElement === container) return;
      const restore = wantsFocus;
      container.append(root);
      queueMicrotask(() => {
        if (!scroll.isConnected) return;
        scroll.scrollTop = pinned ? scroll.scrollHeight : savedScrollTop;
        if (restore && document.activeElement !== input) input.focus({ preventScroll: true });
      });
    },
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      if (visible) void refresh();
      else {
        wantsFocus = false;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      }
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * The screen of a chat-owned agent: a header and its chat, nothing else.
 * There is no terminal tab — the agent has no terminal.
 */
export function renderAgentChatScreen(
  model: { readonly title: string; readonly machine: string },
  actions: { readonly back: () => void; readonly chat: (container: HTMLElement) => void },
): HTMLElement {
  const screen = element("div", "session agent-chat-screen");
  const bar = element("header", "session__header session__header--center");
  const back = element("button", "icon-tap");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.append(glyph(iconChevronLeft, 20));
  back.addEventListener("click", actions.back);
  const heading = element("div", "session__heading");
  heading.append(element("h1", "session__title", model.title));
  if (model.machine) heading.append(element("p", "agent-chat-screen__machine", model.machine));
  bar.append(back, heading, element("div", "session__icons"));
  const body = element("div", "session__chat");
  actions.chat(body);
  screen.append(bar, body);
  return screen;
}

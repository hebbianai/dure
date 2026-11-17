/**
 * The chat of a chat-owned agent, as pure logic (#562).
 *
 * A chat-owned agent has no terminal: the computer's backend runs it, and the
 * phone reads its timeline and acts on it through the paired computer
 * (`AgentChatTimelineV1` and the three actions). Which way a message goes —
 * starting a turn, steering the running one, or waiting behind it — is the
 * computer's decision, the one its own composer makes, so the phone only says
 * what happened.
 *
 * Everything here is a function of its input so it can be tested without a
 * DOM or a computer; `agentChatView.ts` draws it.
 */

import { isCommandError } from "./commandError";
import type {
  AgentChatActionAnswer,
  AgentChatItem,
  AgentChatQuestion,
  AgentChatTimeline,
  AgentChatTimelineAnswer,
} from "./ipc";

/** How often an open chat asks again while the agent works or waits for an answer. */
export const AGENT_CHAT_ACTIVE_POLL_MS = 4_000;

/** How often an open chat asks again while the agent is idle. */
export const AGENT_CHAT_IDLE_POLL_MS = 12_000;

/** How many rows one read asks for. */
export const AGENT_CHAT_PAGE = 60;

/** Why the chat is not showing a fresh timeline, while it keeps asking. */
export type AgentChatWait = "unreachable" | "unavailable" | "agent_not_found" | "unknown";

/** Why the chat cannot be used with this computer until one side is updated. */
export type AgentChatFallback = "update_desktop" | "update_phone";

export type AgentChatStep =
  | { readonly kind: "show"; readonly timeline: AgentChatTimeline; readonly changed: boolean }
  | { readonly kind: "wait"; readonly wait: AgentChatWait }
  | { readonly kind: "fallback"; readonly fallback: AgentChatFallback };

function sequenceOf(item: AgentChatItem): number | undefined {
  return item.kind === "unknown" ? undefined : item.sequence;
}

function oldestSequence(items: readonly AgentChatItem[]): number | undefined {
  for (const item of items) {
    const sequence = sequenceOf(item);
    if (sequence !== undefined) return sequence;
  }
  return undefined;
}

/**
 * The newest page, with the older rows this chat already paged back to kept
 * in front of it, so a poll does not take away what the person scrolled up
 * to read.
 */
export function mergeNewest(
  previous: AgentChatTimeline | undefined,
  next: AgentChatTimeline,
): AgentChatTimeline {
  const start = oldestSequence(next.items);
  if (!previous || start === undefined || next.older == null) return next;
  const kept = previous.items.filter((item) => {
    const sequence = sequenceOf(item);
    return sequence !== undefined && sequence < start;
  });
  if (kept.length === 0) return next;
  return {
    ...next,
    items: [...kept, ...next.items],
    older: previous.older ?? null,
    history_complete: previous.history_complete && previous.older == null,
  };
}

/** An older page put in front of what the chat shows. */
export function mergeOlder(current: AgentChatTimeline, page: AgentChatTimeline): AgentChatTimeline {
  const start = oldestSequence(current.items) ?? Number.POSITIVE_INFINITY;
  const older = page.items.filter((item) => {
    const sequence = sequenceOf(item);
    return sequence !== undefined && sequence < start;
  });
  return {
    ...current,
    items: [...older, ...current.items],
    older: page.older ?? null,
    history_complete: page.history_complete && page.older == null,
  };
}

const WAIT_REFUSALS: ReadonlySet<string> = new Set(["agent_not_found", "unavailable"]);

/** Fold one timeline answer into what the chat shows. */
export function applyTimelineAnswer(
  previous: AgentChatTimeline | undefined,
  answer: AgentChatTimelineAnswer,
): AgentChatStep {
  if (answer.outcome === "timeline" && answer.timeline) {
    const timeline = mergeNewest(previous, answer.timeline);
    const changed = !previous || JSON.stringify(previous) !== JSON.stringify(timeline);
    return { kind: "show", timeline, changed };
  }
  const code = answer.code ?? "unknown";
  return { kind: "wait", wait: WAIT_REFUSALS.has(code) ? (code as AgentChatWait) : "unknown" };
}

/**
 * Silent closes in a row before the chat says the computer needs an update.
 * One is as likely a dropped relay or a restarting desktop.
 */
export const AGENT_CHAT_SILENT_CLOSES_BEFORE_UPDATE = 3;

/** A timeline request that failed before the computer answered. */
export function timelineFailure(
  error: unknown,
  silentCloses: number,
): { readonly step: AgentChatStep; readonly silentCloses: number } {
  const code = isCommandError(error) ? error.code : "";
  if (code === "conversation_no_answer") {
    const run = silentCloses + 1;
    return {
      silentCloses: run,
      step: run >= AGENT_CHAT_SILENT_CLOSES_BEFORE_UPDATE
        ? { kind: "fallback", fallback: "update_desktop" }
        : { kind: "wait", wait: "unreachable" },
    };
  }
  if (code === "agent_chat_desktop_outdated") {
    return { silentCloses: 0, step: { kind: "fallback", fallback: "update_desktop" } };
  }
  if (code === "conversation_version_unsupported") {
    return { silentCloses: 0, step: { kind: "fallback", fallback: "update_phone" } };
  }
  return { silentCloses: 0, step: { kind: "wait", wait: "unreachable" } };
}

/** The agent is busy or waiting for the person: ask more often. */
export function agentChatActive(timeline: AgentChatTimeline | undefined): boolean {
  return !!timeline && (!!timeline.turn || timeline.pending.length > 0 || timeline.queued.length > 0);
}

/** A name for one press. The computer names its message, turn or answer after it. */
export function newActionId(kind: string, random: () => string = defaultRandom): string {
  return `${kind}-${random()}`.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64);
}

function defaultRandom(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** What the composer and the cards say after an action, as an i18n key and its values. */
export interface AgentChatNotice {
  readonly key: string;
  readonly values?: Record<string, string>;
  /** A sent message's text goes back to the composer. */
  readonly giveBack: boolean;
}

const REFUSAL_TEXT: Record<string, string> = {
  agent_not_found: "agentChat.refused.agentNotFound",
  invalid_request: "agentChat.refused.invalid",
  turn_changed: "agentChat.refused.turnChanged",
  not_running: "agentChat.refused.notRunning",
  request_not_found: "agentChat.refused.requestNotFound",
  runtime_unavailable: "agentChat.refused.runtimeUnavailable",
};

/** What the screen says about one action's answer. `undefined`: nothing to say. */
export function actionNotice(
  kind: "send" | "interrupt" | "answer",
  answer: AgentChatActionAnswer,
): AgentChatNotice | undefined {
  if (answer.state === "done") {
    if (kind !== "send") return undefined;
    if (answer.delivery === "queued") return { key: "agentChat.sent.queued", giveBack: false };
    if (answer.delivery === "steered") return { key: "agentChat.sent.steered", giveBack: false };
    return undefined;
  }
  if (answer.state === "refused") {
    const code = answer.code ?? "unknown";
    if (code === "rejected") {
      const detail = answer.detail?.trim();
      return detail
        ? { key: "agentChat.refused.rejected", values: { detail }, giveBack: kind === "send" }
        : { key: "agentChat.refused.rejectedPlain", giveBack: kind === "send" };
    }
    return { key: REFUSAL_TEXT[code] ?? "agentChat.refused.unavailable", giveBack: kind === "send" };
  }
  // It may have happened. A sent message goes back so it is not lost, with a
  // warning not to send it twice.
  return { key: "agentChat.uncertain", giveBack: kind === "send" };
}

/** A request that never reached the computer. */
export function actionError(kind: "send" | "interrupt" | "answer"): AgentChatNotice {
  return { key: "agentChat.notReached", giveBack: kind === "send" };
}

/** The label of a tool row's state. */
export function toolStateKey(state: string): string {
  switch (state) {
    case "running":
      return "agentChat.tool.running";
    case "completed":
      return "agentChat.tool.completed";
    case "failed":
      return "agentChat.tool.failed";
    case "canceled":
      return "agentChat.tool.canceled";
    default:
      return "agentChat.tool.unknown";
  }
}

/** The sentence of a status row. */
export function statusKey(state: string): string {
  switch (state) {
    case "turn_failed":
      return "agentChat.status.turnFailed";
    case "turn_canceled":
      return "agentChat.status.turnCanceled";
    case "session_failed":
      return "agentChat.status.sessionFailed";
    case "session_exited":
      return "agentChat.status.sessionExited";
    default:
      return "agentChat.status.unknown";
  }
}

/**
 * The answers to a question card, the way the desktop's card builds them: per
 * question, the person's own words if given, else the chosen labels in option
 * order joined with ", ". `undefined` while a question is unanswered.
 */
export function questionAnswers(
  questions: readonly AgentChatQuestion[],
  selections: readonly ReadonlySet<number>[],
  others: readonly string[],
): Record<string, string> | undefined {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const other = others[index]?.trim();
    if (other) {
      answers[question.id] = other;
      continue;
    }
    const chosen = [...(selections[index] ?? [])]
      .sort((left, right) => left - right)
      .flatMap((option) => (question.options[option] ? [question.options[option].label] : []));
    if (chosen.length === 0) return undefined;
    answers[question.id] = chosen.join(", ");
  }
  return answers;
}

/** Choose an option: a single-choice question keeps one, a multiple-choice one toggles. */
export function choose(
  selection: ReadonlySet<number> | undefined,
  option: number,
  multiSelect: boolean,
): ReadonlySet<number> {
  if (!multiSelect) return new Set([option]);
  const next = new Set(selection ?? []);
  if (next.has(option)) next.delete(option);
  else next.add(option);
  return next;
}

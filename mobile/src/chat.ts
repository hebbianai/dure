/**
 * The chat view of one agent session, as pure logic (#361).
 *
 * The phone reads the agent's provider conversation through the paired
 * computer (`ConversationTranscriptV1`) and types into it through the Host's
 * idle-prompt admission (`AgentPromptV1`). It observes the running agent; it
 * never takes it over, and the terminal stays one tap away.
 *
 * Everything here is a function of its input so it can be tested without a
 * DOM or a computer; `chatView.ts` draws it.
 */

import type { AgentRuntimeState } from "./agentRuntimeState";
import type { AgentReadiness } from "./chatQueue";
import type {
  CommandError,
  ConversationCursor,
  ConversationEntry,
  ConversationRefusal,
  ConversationTranscriptAnswer,
} from "./ipc";

export type SessionView = "chat" | "terminal";

/**
 * The view a session that reports a conversation opens on.
 *
 * Founder decision on #361: always Chat, whatever the agent is doing. One
 * constant, so changing the default is a one-line change.
 */
export const CONVERSATION_DEFAULT_VIEW: SessionView = "chat";

/** Sessions without a conversation (shells, remote hosts) have nothing to show in Chat. */
export function defaultSessionView(conversation: boolean): SessionView {
  return conversation ? CONVERSATION_DEFAULT_VIEW : "terminal";
}

/** How often an open chat asks again while nothing else has told it to. */
export const CHAT_POLL_INTERVAL_MS = 15_000;

/** How many of the newest messages the chat asks for. */
export const CHAT_TRANSCRIPT_LIMIT = 100;

/** What the agent is doing, for the composer and for delivering a queued prompt. */
export function agentReadiness(runtime: AgentRuntimeState | undefined): AgentReadiness {
  if (!runtime) return "unknown";
  if (runtime.lifecycle === "exited") return "exited";
  if (runtime.lifecycle === "starting") return "starting";
  // The Host admits a prompt only with no attention raised, whatever its kind.
  if (runtime.attention !== "none") return "attention";
  return runtime.activity === "working" ? "working" : "idle";
}

/**
 * The part of a runtime observation that should make the chat ask again.
 *
 * A completed turn is the issue's trigger; a turn starting is added because it
 * is when the prompt that started it shows. Both are cheap: the computer
 * answers `unchanged` from its cursor when nothing it reads moved. Progress
 * inside a turn does not count.
 */
export function refreshMark(runtime: AgentRuntimeState | undefined): string | undefined {
  return runtime ? `${runtime.turnCompletedCount}|${runtime.activity}` : undefined;
}

/** What the chat currently shows. */
export interface ChatTranscript {
  readonly entries: readonly ConversationEntry[];
  readonly cursor?: ConversationCursor;
  /** The entries start at the beginning of the conversation. */
  readonly historyComplete: boolean;
  readonly provider?: string;
  readonly conversationId?: string;
}

/** Why the chat is not showing a fresh transcript, while it keeps asking. */
export type ChatWait =
  | "conversation_unknown"
  | "transcript_unavailable"
  | "probe_timeout"
  | "unavailable"
  | "session_not_found"
  | "unreachable"
  | "unknown";

/** Why the chat gives way to the terminal for this session. */
export type ChatFallback =
  /** The computer predates the chat: update Dure there. */
  | "update_computer"
  /** This phone cannot read the computer's answer: update the app. */
  | "update_phone"
  /** The session has no conversation the computer can serve. */
  | "not_available";

export type TranscriptStep =
  | { readonly kind: "show"; readonly transcript: ChatTranscript; readonly changed: boolean }
  | { readonly kind: "wait"; readonly wait: ChatWait }
  | { readonly kind: "fallback"; readonly fallback: ChatFallback };

function sameEntries(
  left: readonly ConversationEntry[],
  right: readonly ConversationEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) =>
      entry.role === right[index].role &&
      entry.text === right[index].text &&
      Boolean(entry.truncated) === Boolean(right[index].truncated),
  );
}

const WAIT_REFUSALS: ReadonlySet<ConversationRefusal> = new Set([
  "conversation_unknown",
  "transcript_unavailable",
  "probe_timeout",
  "unavailable",
  "session_not_found",
]);

/**
 * Fold one transcript answer into what the chat shows.
 *
 * `changed` is false when the messages are the ones already drawn — an
 * `unchanged` answer always, and a re-read that found nothing new — so the
 * view repaints nothing.
 */
export function applyTranscriptAnswer(
  previous: ChatTranscript | undefined,
  answer: ConversationTranscriptAnswer,
): TranscriptStep {
  switch (answer.outcome) {
    case "transcript": {
      const transcript: ChatTranscript = {
        entries: answer.entries,
        historyComplete: answer.history_complete,
        ...(answer.cursor ? { cursor: answer.cursor } : {}),
        ...(answer.provider ? { provider: answer.provider } : {}),
        ...(answer.conversation_id ? { conversationId: answer.conversation_id } : {}),
      };
      const changed =
        !previous ||
        previous.conversationId !== transcript.conversationId ||
        previous.historyComplete !== transcript.historyComplete ||
        !sameEntries(previous.entries, transcript.entries);
      return { kind: "show", transcript, changed };
    }
    case "unchanged":
      return {
        kind: "show",
        transcript: {
          ...(previous ?? { entries: [], historyComplete: false }),
          ...(answer.cursor ? { cursor: answer.cursor } : {}),
        },
        changed: previous === undefined,
      };
    case "refused": {
      const code: ConversationRefusal = answer.code ?? "unknown";
      if (code === "remote_unsupported" || code === "unsupported_runtime") {
        return { kind: "fallback", fallback: "not_available" };
      }
      return { kind: "wait", wait: WAIT_REFUSALS.has(code) ? (code as ChatWait) : "unknown" };
    }
    default:
      return { kind: "wait", wait: "unknown" };
  }
}

/** A transcript request that failed before the computer answered. */
export function transcriptFailure(error: unknown): TranscriptStep {
  const code =
    typeof error === "object" && error !== null && typeof (error as CommandError).code === "string"
      ? (error as CommandError).code
      : "";
  if (code === "conversation_unsupported") return { kind: "fallback", fallback: "update_computer" };
  if (code === "conversation_version_unsupported") {
    return { kind: "fallback", fallback: "update_phone" };
  }
  return { kind: "wait", wait: "unreachable" };
}

/** A prompt the computer wrote, shown until the transcript carries it. */
export interface SentPrompt {
  readonly text: string;
  /** Matching user messages in the transcript when it was sent. */
  readonly matchesAtSend: number;
  /** Completed turns at the time, when a cursor had said. */
  readonly turnsAtSend?: number;
  readonly conversationId?: string;
}

/** Whitespace is not what tells two prompts apart. */
function sameText(left: string, right: string): boolean {
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  return squash(left) === squash(right);
}

function userMatches(transcript: ChatTranscript | undefined, text: string): number {
  return (transcript?.entries ?? []).filter(
    (entry) => entry.role === "user" && sameText(entry.text, text),
  ).length;
}

export function sentPrompt(text: string, transcript: ChatTranscript | undefined): SentPrompt {
  return {
    text,
    matchesAtSend: userMatches(transcript, text),
    ...(transcript?.cursor ? { turnsAtSend: transcript.cursor.turn_completed_count } : {}),
    ...(transcript?.conversationId ? { conversationId: transcript.conversationId } : {}),
  };
}

/**
 * The transcript now carries the sent prompt, or no longer could: one more
 * user message with its text, a turn completed since, or another conversation.
 */
export function sentPromptSettled(sent: SentPrompt, transcript: ChatTranscript): boolean {
  if (sent.conversationId && transcript.conversationId &&
    transcript.conversationId !== sent.conversationId) {
    return true;
  }
  if (userMatches(transcript, sent.text) > sent.matchesAtSend) return true;
  const turns = transcript.cursor?.turn_completed_count;
  return sent.turnsAtSend !== undefined && turns !== undefined && turns > sent.turnsAtSend;
}

/** One message as the chat lists it. */
export interface ChatRow {
  readonly role: "user" | "agent";
  readonly text: string;
  readonly truncated: boolean;
}

/** Entries become rows one for one; empty messages are left out. */
export function chatRows(entries: readonly ConversationEntry[]): ChatRow[] {
  return entries
    .filter((entry) => entry.text.trim() !== "")
    .map((entry) => ({
      role: entry.role === "user" ? "user" : "agent",
      text: entry.text,
      truncated: entry.truncated === true,
    }));
}

/** A send now goes straight to the agent rather than into the queue. */
export function sendsNow(readiness: AgentReadiness, queued: boolean): boolean {
  return readiness === "idle" && !queued;
}

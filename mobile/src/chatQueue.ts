/**
 * The one prompt a phone holds for an agent until it can take it (#361).
 *
 * # Why a queue on the phone
 *
 * The composer is always enabled (founder decision on #361). The computer
 * only writes a prompt while the agent is idle with no attention raised, so a
 * prompt sent while it works is held here — one per session, persisted so it
 * survives the app closing — and delivered with `AgentPromptV1` when the
 * attached session reports idle. It is delivered only while the app is open on
 * that session; a queue the computer holds is milestone 2.
 *
 * # Which refusals keep it
 *
 * `not_idle`, `attention_pending` and `probe_timeout` say "not now": the
 * prompt stays queued and goes again at the next idle report. Every other
 * refusal stops it and gives the text back to the composer with the reason —
 * above all `identity_changed`, because a prompt is never delivered into a
 * conversation other than the one it was written for.
 *
 * # Never twice by itself
 *
 * A failed delivery keeps the prompt only when the failure proves nothing was
 * written: the computer could not be reached before the prompt went out
 * ([`NOT_SENT_CODES`]). Anything else — an answer lost after the prompt went
 * out (`unknown`), a command error this build does not know to be harmless —
 * gives the text back with a note to check the conversation first. Text given
 * back stays stored until the person sends or clears it, so closing the app
 * does not lose it either.
 */

import { isCommandError } from "./commandError";
import type { AgentPromptAnswer, ConversationRefusal } from "./ipc";

/** The protocol's `MAX_AGENT_PROMPT_BYTES`: one prompt rides in the greeting. */
export const MAX_AGENT_PROMPT_BYTES = 3 * 1024;

/** How two prompts are joined when a second send adds to the queued one. */
export const QUEUE_JOINER = "\n\n";

export type PromptProblem =
  | { readonly kind: "empty" }
  | { readonly kind: "control" }
  | { readonly kind: "too_long"; readonly bytes: number; readonly limit: number };

export type NormalizedPrompt =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problem: PromptProblem };

/** Unicode `Cc` other than line feed and tab: what Rust's `char::is_control` refuses. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it matches.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * The protocol's `normalize_agent_prompt`, applied before a prompt is queued so
 * the person learns at once what the computer would refuse later.
 */
export function normalizePrompt(text: string): NormalizedPrompt {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.trim() === "") return { ok: false, problem: { kind: "empty" } };
  if (CONTROL.test(normalized)) return { ok: false, problem: { kind: "control" } };
  const bytes = new TextEncoder().encode(normalized).length;
  if (bytes > MAX_AGENT_PROMPT_BYTES) {
    return { ok: false, problem: { kind: "too_long", bytes, limit: MAX_AGENT_PROMPT_BYTES } };
  }
  return { ok: true, text: normalized };
}

/** The process and conversation a prompt was written for. */
export interface PromptTarget {
  readonly terminalEpoch: string;
  /** Absent when no transcript had named the conversation yet. */
  readonly conversationId?: string;
}

/** Why the last attempt left the prompt queued. */
export type QueueWait = "not_idle" | "attention_pending" | "probe_timeout" | "unreachable";

export interface QueuedPrompt {
  readonly text: string;
  readonly target: PromptTarget;
  readonly queuedAtMs: number;
  /** Not persisted: it describes the attempt this app made. */
  readonly wait?: QueueWait;
  /**
   * Loaded from storage while it was marked as being delivered: the app went
   * away mid-delivery, so the computer may have written it. Never delivered
   * again by itself.
   */
  readonly interrupted?: boolean;
}

export type Enqueued =
  | { readonly kind: "queued"; readonly prompt: QueuedPrompt; readonly added: boolean }
  | { readonly kind: "invalid"; readonly problem: PromptProblem };

/**
 * Queue `draft`. With a prompt already queued, the draft is added to it — one
 * queued prompt per session, and nothing dropped. When the two together are
 * too long, nothing changes and the draft stays where it was.
 *
 * The queued prompt keeps the target it was written for.
 */
export function enqueuePrompt(
  existing: QueuedPrompt | undefined,
  draft: string,
  target: PromptTarget,
  nowMs: number,
): Enqueued {
  const own = normalizePrompt(draft);
  if (!own.ok) return { kind: "invalid", problem: own.problem };
  if (!existing) {
    return { kind: "queued", added: false, prompt: { text: own.text, target, queuedAtMs: nowMs } };
  }
  const combined = normalizePrompt(`${existing.text}${QUEUE_JOINER}${own.text}`);
  if (!combined.ok) return { kind: "invalid", problem: combined.problem };
  return {
    kind: "queued",
    added: true,
    prompt: { text: combined.text, target: existing.target, queuedAtMs: existing.queuedAtMs },
  };
}

/** Put the queued prompt back into the composer, in front of what is typed there. */
export function editQueuedPrompt(queued: QueuedPrompt, draft: string): string {
  return returnToComposer(queued.text, draft);
}

/** Text given back to the composer never replaces a draft; it goes in front of it. */
export function returnToComposer(text: string, draft: string): string {
  return draft.trim() === "" ? text : `${text}${QUEUE_JOINER}${draft}`;
}

/** What the attached agent is doing, as far as sending a prompt goes. */
export type AgentReadiness = "idle" | "working" | "attention" | "starting" | "exited" | "unknown";

/** Deliver now: something is queued, nothing is in flight, the agent is idle. */
export function deliveryDue(
  queued: QueuedPrompt | undefined,
  readiness: AgentReadiness,
  inFlight: boolean,
): boolean {
  return queued !== undefined && !inFlight && readiness === "idle";
}

/** The refusals that mean "not now" (founder decision on #361). */
export const RETRYABLE_REFUSALS: ReadonlySet<ConversationRefusal> = new Set([
  "not_idle",
  "attention_pending",
  "probe_timeout",
]);

/** Why a prompt came back to the composer. */
export type ReturnReason =
  | ConversationRefusal
  /** It may have been written: check the conversation before sending again. */
  | "uncertain";

export type Delivery =
  | { readonly kind: "sent"; readonly text: string }
  | { readonly kind: "kept"; readonly prompt: QueuedPrompt }
  | { readonly kind: "returned"; readonly text: string; readonly reason: ReturnReason };

export type DeliveryResult =
  | { readonly kind: "answer"; readonly answer: AgentPromptAnswer }
  | { readonly kind: "error"; readonly error: unknown };

/**
 * The command errors that prove a prompt was not written and may be tried
 * again: `hub_agent_prompt` returns them only from dialing the computer or
 * from writing the greeting, before the computer could act on it, and
 * `ssh_agent_prompt` returns `server_unreachable` only when the SSH
 * connection to the server failed.
 */
export const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "hub_unreachable",
  "hub_computer_offline",
  "server_unreachable",
]);

/** What one delivery attempt did with the queued prompt. */
export function settleDelivery(prompt: QueuedPrompt, result: DeliveryResult): Delivery {
  if (result.kind === "error") {
    if (isCommandError(result.error) && NOT_SENT_CODES.has(result.error.code)) {
      return { kind: "kept", prompt: { ...prompt, wait: "unreachable" } };
    }
    // Anything else might have happened after the prompt went out.
    return { kind: "returned", text: prompt.text, reason: "uncertain" };
  }
  const { answer } = result;
  switch (answer.state) {
    case "written_to_pty":
      return { kind: "sent", text: prompt.text };
    case "unknown":
      return { kind: "returned", text: prompt.text, reason: "uncertain" };
    case "refused": {
      const code: ConversationRefusal = answer.code ?? "unknown";
      if (RETRYABLE_REFUSALS.has(code)) {
        return { kind: "kept", prompt: { ...prompt, wait: code as QueueWait } };
      }
      return { kind: "returned", text: prompt.text, reason: code };
    }
    default:
      return { kind: "returned", text: prompt.text, reason: "unknown" };
  }
}

/** The queue after a delivery, given what it holds now. */
export interface QueueAfterDelivery {
  readonly queued?: QueuedPrompt;
  readonly sent?: string;
  readonly returned?: { readonly text: string; readonly reason: ReturnReason };
}

/**
 * Apply a settled delivery to the queue as it stands now.
 *
 * A send during the delivery added to the prompt in flight (`enqueuePrompt`),
 * so `current` may be longer than `delivered`. What was added stays queued
 * when the delivered part was sent, and goes back with it when it was not.
 */
export function afterDelivery(
  delivered: QueuedPrompt,
  current: QueuedPrompt | undefined,
  delivery: Delivery,
): QueueAfterDelivery {
  const now = current ?? delivered;
  const prefix = `${delivered.text}${QUEUE_JOINER}`;
  const added = now !== delivered && now.text.startsWith(prefix)
    ? now.text.slice(prefix.length)
    : undefined;
  switch (delivery.kind) {
    case "kept":
      return { queued: { ...now, wait: delivery.prompt.wait } };
    case "sent": {
      const rest: QueuedPrompt | undefined = added === undefined
        ? undefined
        : { text: added, target: now.target, queuedAtMs: now.queuedAtMs };
      return { sent: delivery.text, ...(rest ? { queued: rest } : {}) };
    }
    case "returned":
      return { returned: { text: now.text, reason: delivery.reason } };
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** Where queued prompts are kept on this phone, one per session. */
export const CHAT_QUEUE_STORAGE_KEY = "dure.chat.queue.v1";

/** The session a queued prompt belongs to: computer, box, workspace, session. */
export function queueKey(
  hubId: string,
  boxId: string,
  workspaceId: string,
  sessionId: string,
): string {
  return JSON.stringify([hubId, boxId, workspaceId, sessionId]);
}

/**
 * The same for a session on a server this phone reaches over SSH. Its own
 * shape, so it can never name a computer's session.
 */
export function serverQueueKey(serverId: string, workspaceId: string, sessionId: string): string {
  return JSON.stringify(["ssh", serverId, workspaceId, sessionId]);
}

/** What one session has stored: a queued prompt, or text given back to the composer. */
export type ChatEntry =
  | { readonly kind: "queued"; readonly prompt: QueuedPrompt }
  | { readonly kind: "returned"; readonly text: string; readonly reason: ReturnReason };

type StoredEntry =
  | {
      kind: "queued";
      text: string;
      target: PromptTarget;
      queuedAtMs: number;
      /** Written just before a delivery starts and cleared when it settles. */
      sending?: true;
    }
  | { kind: "returned"; text: string; reason: string };

interface StoredQueue {
  readonly version: 1;
  readonly prompts: Record<string, StoredEntry>;
}

type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function readStored(storage: QueueStorage): StoredQueue {
  try {
    const raw = storage.getItem(CHAT_QUEUE_STORAGE_KEY);
    if (!raw) return { version: 1, prompts: {} };
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      (value as StoredQueue).version === 1 &&
      typeof (value as StoredQueue).prompts === "object" &&
      (value as StoredQueue).prompts !== null
    ) {
      return value as StoredQueue;
    }
  } catch {
    // Unreadable storage holds nothing queued; the next save writes it afresh.
  }
  return { version: 1, prompts: {} };
}

function storedEntry(value: unknown): ChatEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, text, target, queuedAtMs, sending, reason } = value as Record<string, unknown>;
  if (typeof text !== "string") return undefined;
  if (kind === "returned") {
    // A reason this build does not know still reads as "check first".
    return {
      kind: "returned",
      text,
      reason: typeof reason === "string" ? (reason as ReturnReason) : "uncertain",
    };
  }
  if (kind !== "queued" || typeof queuedAtMs !== "number") return undefined;
  if (typeof target !== "object" || target === null) return undefined;
  const { terminalEpoch, conversationId } = target as Record<string, unknown>;
  if (typeof terminalEpoch !== "string") return undefined;
  if (conversationId !== undefined && typeof conversationId !== "string") return undefined;
  return {
    kind: "queued",
    prompt: {
      text,
      queuedAtMs,
      target: conversationId === undefined ? { terminalEpoch } : { terminalEpoch, conversationId },
      ...(sending === true ? { interrupted: true } : {}),
    },
  };
}

/** What one session has stored, if anything. Never throws. */
export function loadChatEntry(storage: QueueStorage | undefined, key: string): ChatEntry | undefined {
  if (!storage) return undefined;
  return storedEntry(readStored(storage).prompts[key]);
}

function writeEntry(storage: QueueStorage | undefined, key: string, entry: StoredEntry | undefined): void {
  if (!storage) return;
  const prompts = { ...readStored(storage).prompts };
  if (entry) prompts[key] = entry;
  else delete prompts[key];
  try {
    if (Object.keys(prompts).length === 0) storage.removeItem(CHAT_QUEUE_STORAGE_KEY);
    else storage.setItem(CHAT_QUEUE_STORAGE_KEY, JSON.stringify({ version: 1, prompts }));
  } catch {
    // A full or blocked store keeps the prompt for this run only.
  }
}

/**
 * Keep (or with `undefined`, forget) one session's queued prompt. Never throws.
 *
 * `sending` marks a delivery about to start, so an app that dies before it
 * settles finds the prompt `interrupted` rather than due.
 */
export function saveQueuedPrompt(
  storage: QueueStorage | undefined,
  key: string,
  prompt: QueuedPrompt | undefined,
  sending = false,
): void {
  writeEntry(
    storage,
    key,
    prompt && {
      kind: "queued",
      text: prompt.text,
      target: prompt.target,
      queuedAtMs: prompt.queuedAtMs,
      ...(sending ? { sending: true as const } : {}),
    },
  );
}

/**
 * Keep text given back to the composer, with why, until the person sends it
 * or clears it. Empty text forgets it. Never throws.
 */
export function saveReturnedDraft(
  storage: QueueStorage | undefined,
  key: string,
  text: string,
  reason: ReturnReason,
): void {
  writeEntry(storage, key, text.trim() === "" ? undefined : { kind: "returned", text, reason });
}

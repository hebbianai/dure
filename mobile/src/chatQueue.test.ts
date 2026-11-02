import { beforeEach, describe, expect, it } from "vitest";
import {
  afterDelivery,
  CHAT_QUEUE_STORAGE_KEY,
  type DeliveryResult,
  deliveryDue,
  editQueuedPrompt,
  enqueuePrompt,
  loadChatEntry,
  MAX_AGENT_PROMPT_BYTES,
  NOT_SENT_CODES,
  normalizePrompt,
  type QueuedPrompt,
  queueKey,
  returnToComposer,
  saveQueuedPrompt,
  saveReturnedDraft,
  settleDelivery,
} from "./chatQueue";
import type { AgentPromptAnswer, ConversationRefusal } from "./ipc";

const TARGET = { terminalEpoch: "terminal-1", conversationId: "conversation-1" };

function queued(text = "run the tests"): QueuedPrompt {
  return { text, target: TARGET, queuedAtMs: 1_000 };
}

function answer(value: AgentPromptAnswer): DeliveryResult {
  return { kind: "answer", answer: value };
}

function refused(code: ConversationRefusal): DeliveryResult {
  return answer({ state: "refused", code, detail: "why" });
}

describe("normalizePrompt", () => {
  it("turns carriage returns into line feeds, as the computer does", () => {
    expect(normalizePrompt("one\r\ntwo\rthree")).toEqual({ ok: true, text: "one\ntwo\nthree" });
  });

  it("refuses an empty prompt, a control character and a prompt over the limit", () => {
    expect(normalizePrompt("  \n\t ")).toEqual({ ok: false, problem: { kind: "empty" } });
    expect(normalizePrompt("ring\u0007")).toEqual({ ok: false, problem: { kind: "control" } });
    expect(normalizePrompt("tab\tand\nline").ok).toBe(true);
    const long = "가".repeat(MAX_AGENT_PROMPT_BYTES / 3 + 1);
    expect(normalizePrompt(long)).toEqual({
      ok: false,
      problem: { kind: "too_long", bytes: MAX_AGENT_PROMPT_BYTES + 3, limit: MAX_AGENT_PROMPT_BYTES },
    });
    expect(normalizePrompt("x".repeat(MAX_AGENT_PROMPT_BYTES)).ok).toBe(true);
  });
});

describe("enqueuePrompt", () => {
  it("queues a prompt for the process and conversation it was written for", () => {
    expect(enqueuePrompt(undefined, "run the tests", TARGET, 5)).toEqual({
      kind: "queued",
      added: false,
      prompt: { text: "run the tests", target: TARGET, queuedAtMs: 5 },
    });
  });

  it("adds a second send to the queued prompt instead of dropping either", () => {
    const result = enqueuePrompt(queued(), "and lint", { terminalEpoch: "terminal-2" }, 9);
    expect(result).toEqual({
      kind: "queued",
      added: true,
      // The first prompt's target and time stand: it was written for that conversation.
      prompt: { text: "run the tests\n\nand lint", target: TARGET, queuedAtMs: 1_000 },
    });
  });

  it("changes nothing when the two together would be too long", () => {
    const full = queued("x".repeat(MAX_AGENT_PROMPT_BYTES - 2));
    const result = enqueuePrompt(full, "more", TARGET, 9);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.problem.kind).toBe("too_long");
  });

  it("refuses an empty draft without touching the queue", () => {
    expect(enqueuePrompt(queued(), "   ", TARGET, 9)).toEqual({
      kind: "invalid",
      problem: { kind: "empty" },
    });
  });
});

describe("editing and giving text back", () => {
  it("puts the queued prompt in front of what is already typed", () => {
    expect(editQueuedPrompt(queued(), "")).toBe("run the tests");
    expect(editQueuedPrompt(queued(), "half a thought")).toBe("run the tests\n\nhalf a thought");
    expect(returnToComposer("returned", "  ")).toBe("returned");
  });
});

describe("deliveryDue", () => {
  it("delivers only a queued prompt, one at a time, to an idle agent", () => {
    expect(deliveryDue(queued(), "idle", false)).toBe(true);
    expect(deliveryDue(undefined, "idle", false)).toBe(false);
    expect(deliveryDue(queued(), "idle", true)).toBe(false);
    for (const readiness of ["working", "attention", "starting", "exited", "unknown"] as const) {
      expect(deliveryDue(queued(), readiness, false)).toBe(false);
    }
  });
});

describe("settleDelivery", () => {
  it("is sent once the computer wrote it", () => {
    expect(
      settleDelivery(queued(), answer({ state: "written_to_pty", record_id: "record-1" })),
    ).toEqual({ kind: "sent", text: "run the tests" });
  });

  it.each(["not_idle", "attention_pending", "probe_timeout"] as const)(
    "keeps it queued after %s and says why",
    (code) => {
      expect(settleDelivery(queued(), refused(code))).toEqual({
        kind: "kept",
        prompt: { ...queued(), wait: code },
      });
    },
  );

  it.each([
    "identity_changed",
    "unsupported_runtime",
    "unavailable",
    "session_not_found",
    "input_draft_pending",
    "conversation_unknown",
    "invalid_request",
    "remote_unsupported",
    "unknown",
  ] as const)("stops after %s and gives the text back", (code) => {
    expect(settleDelivery(queued(), refused(code))).toEqual({
      kind: "returned",
      text: "run the tests",
      reason: code,
    });
  });

  it("gives the text back unsent-or-not when the answer was lost after writing", () => {
    expect(settleDelivery(queued(), answer({ state: "unknown", detail: "lost" }))).toEqual({
      kind: "returned",
      text: "run the tests",
      reason: "uncertain",
    });
  });

  it.each(["hub_unreachable", "hub_computer_offline"])(
    "keeps it queued after %s, which proves nothing was written",
    (code) => {
      expect(NOT_SENT_CODES.has(code)).toBe(true);
      expect(settleDelivery(queued(), { kind: "error", error: { code, message: "offline" } })).toEqual({
        kind: "kept",
        prompt: { ...queued(), wait: "unreachable" },
      });
    },
  );

  /** Never sent again by itself: none of these proves the prompt was not written. */
  it.each([
    { code: "hub_join", message: "the task panicked" },
    { code: "hub_protocol", message: "broken frame" },
    { code: "hub_unknown", message: "pairing removed" },
    { code: "hub_refused", message: "device revoked" },
    { code: "conversation_no_answer", message: "closed" },
    { code: "something_new", message: "" },
    new Error("not a command error"),
    "a string",
  ])("gives the text back to check first after %o", (error) => {
    expect(settleDelivery(queued(), { kind: "error", error })).toEqual({
      kind: "returned",
      text: "run the tests",
      reason: "uncertain",
    });
  });

  it("reads a refusal without a code as one that stops", () => {
    expect(settleDelivery(queued(), answer({ state: "refused" }))).toEqual({
      kind: "returned",
      text: "run the tests",
      reason: "unknown",
    });
  });
});

describe("afterDelivery", () => {
  const delivered = queued("first");
  const grown: QueuedPrompt = { ...delivered, text: "first\n\nsecond" };

  it("empties the queue once the prompt was sent", () => {
    expect(afterDelivery(delivered, delivered, { kind: "sent", text: "first" })).toEqual({
      sent: "first",
    });
  });

  it("keeps what was added during the delivery queued after the rest was sent", () => {
    expect(afterDelivery(delivered, grown, { kind: "sent", text: "first" })).toEqual({
      sent: "first",
      queued: { text: "second", target: TARGET, queuedAtMs: 1_000 },
    });
  });

  it("keeps the whole prompt, additions included, when not now", () => {
    const kept = { kind: "kept", prompt: { ...delivered, wait: "not_idle" } } as const;
    expect(afterDelivery(delivered, grown, kept)).toEqual({ queued: { ...grown, wait: "not_idle" } });
  });

  it("gives everything back, additions included, when it stops", () => {
    const returned = { kind: "returned", text: "first", reason: "identity_changed" } as const;
    expect(afterDelivery(delivered, grown, returned)).toEqual({
      returned: { text: "first\n\nsecond", reason: "identity_changed" },
    });
  });
});

describe("the persisted queue", () => {
  beforeEach(() => localStorage.clear());

  const first = queueKey("hub-1", "box-1", "workspace-1", "session-1");
  const second = queueKey("hub-1", "box-1", "workspace-1", "session-2");

  it("keeps one prompt per session across loads", () => {
    saveQueuedPrompt(localStorage, first, queued("first"));
    saveQueuedPrompt(localStorage, second, { ...queued("second"), wait: "not_idle" });
    expect(loadChatEntry(localStorage, first)).toEqual({ kind: "queued", prompt: queued("first") });
    // Why the last attempt waited belongs to that run, not to the stored prompt.
    expect(loadChatEntry(localStorage, second)).toEqual({ kind: "queued", prompt: queued("second") });
  });

  it("forgets a session's prompt and clears the store when none are left", () => {
    saveQueuedPrompt(localStorage, first, queued());
    saveQueuedPrompt(localStorage, first, undefined);
    expect(loadChatEntry(localStorage, first)).toBeUndefined();
    expect(localStorage.getItem(CHAT_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it("reads a prompt left mid-delivery as interrupted, never as due", () => {
    saveQueuedPrompt(localStorage, first, queued(), true);
    expect(loadChatEntry(localStorage, first)).toEqual({
      kind: "queued",
      prompt: { ...queued(), interrupted: true },
    });
    saveQueuedPrompt(localStorage, first, queued());
    expect(loadChatEntry(localStorage, first)).toEqual({ kind: "queued", prompt: queued() });
  });

  it("keeps text given back to the composer, with why, until it is cleared", () => {
    saveReturnedDraft(localStorage, first, "check this", "uncertain");
    expect(loadChatEntry(localStorage, first)).toEqual({
      kind: "returned",
      text: "check this",
      reason: "uncertain",
    });
    // Sending it queues it in its place.
    saveQueuedPrompt(localStorage, first, queued("check this"));
    expect(loadChatEntry(localStorage, first)?.kind).toBe("queued");
    saveReturnedDraft(localStorage, first, "again", "identity_changed");
    saveReturnedDraft(localStorage, first, "  ", "identity_changed");
    expect(loadChatEntry(localStorage, first)).toBeUndefined();
  });

  it("keeps a prompt written before any conversation was known", () => {
    const early = { text: "hi", target: { terminalEpoch: "terminal-1" }, queuedAtMs: 3 };
    saveQueuedPrompt(localStorage, first, early);
    expect(loadChatEntry(localStorage, first)).toEqual({ kind: "queued", prompt: early });
  });

  it("reads broken or foreign storage as nothing stored, and never throws", () => {
    localStorage.setItem(CHAT_QUEUE_STORAGE_KEY, "{not json");
    expect(loadChatEntry(localStorage, first)).toBeUndefined();
    localStorage.setItem(
      CHAT_QUEUE_STORAGE_KEY,
      JSON.stringify({ version: 1, prompts: { [first]: { kind: "queued", text: 4, target: {} } } }),
    );
    expect(loadChatEntry(localStorage, first)).toBeUndefined();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadChatEntry(throwing, first)).toBeUndefined();
    expect(() => saveQueuedPrompt(throwing, first, queued())).not.toThrow();
    expect(() => saveReturnedDraft(throwing, first, "x", "uncertain")).not.toThrow();
    expect(loadChatEntry(undefined, first)).toBeUndefined();
  });
});

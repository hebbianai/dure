import { describe, expect, it } from "vitest";
import {
  actionError,
  actionNotice,
  agentChatActive,
  applyTimelineAnswer,
  choose,
  mergeNewest,
  mergeOlder,
  newActionId,
  questionAnswers,
  timelineFailure,
} from "./agentChat";
import type { AgentChatItem, AgentChatQuestion, AgentChatTimeline } from "./ipc";

function message(sequence: number, text = `message ${sequence}`): AgentChatItem {
  return { kind: "message", sequence, role: "agent", text };
}

function timeline(items: AgentChatItem[], older: number | null = null): AgentChatTimeline {
  return {
    provider_id: "claude",
    items,
    older,
    history_complete: older === null,
    latest: 99,
    turn: null,
    live_text: null,
    pending: [],
    queued: [],
  };
}

const commandError = (code: string) => ({ code, message: code });

describe("agent chat timeline", () => {
  it("shows a timeline and says when it changed", () => {
    const first = applyTimelineAnswer(undefined, { outcome: "timeline", timeline: timeline([message(1)]) });
    expect(first).toMatchObject({ kind: "show", changed: true });
    if (first.kind !== "show") throw new Error("shown");
    const same = applyTimelineAnswer(first.timeline, { outcome: "timeline", timeline: timeline([message(1)]) });
    expect(same).toMatchObject({ kind: "show", changed: false });
  });

  it("keeps the older rows the person paged back to when a poll reads the newest page", () => {
    const paged = mergeOlder(timeline([message(5), message(6)], 5), timeline([message(3), message(4)], 3));
    expect(paged.items.map((item) => (item.kind === "message" ? item.sequence : 0))).toEqual([3, 4, 5, 6]);
    expect(paged.older).toBe(3);
    const polled = mergeNewest(paged, timeline([message(5), message(6), message(7)], 5));
    expect(polled.items.map((item) => (item.kind === "message" ? item.sequence : 0))).toEqual([3, 4, 5, 6, 7]);
    expect(polled.older).toBe(3);
  });

  it("takes the newest page as is when it holds the whole conversation", () => {
    const paged = timeline([message(1), message(2)], 1);
    const whole = timeline([message(1), message(2), message(3)]);
    expect(mergeNewest(paged, whole)).toEqual(whole);
  });

  it("an older page that reaches the beginning completes the history", () => {
    const paged = mergeOlder(timeline([message(5)], 5), timeline([message(1)], null));
    expect(paged.older).toBeNull();
    expect(paged.history_complete).toBe(true);
  });

  it("waits on a refusal rather than giving up", () => {
    expect(applyTimelineAnswer(undefined, { outcome: "refused", code: "agent_not_found" })).toEqual({
      kind: "wait",
      wait: "agent_not_found",
    });
    expect(applyTimelineAnswer(undefined, { outcome: "refused", code: "quota" as never })).toEqual({
      kind: "wait",
      wait: "unknown",
    });
  });

  /** Acceptance: an older computer reads as "update the desktop", not an error. */
  it("asks to update the computer after repeated silent closes or an older chat version", () => {
    let run = 0;
    const steps = [1, 2, 3].map(() => {
      const failed = timelineFailure(commandError("conversation_no_answer"), run);
      run = failed.silentCloses;
      return failed.step;
    });
    expect(steps.slice(0, 2)).toEqual([
      { kind: "wait", wait: "unreachable" },
      { kind: "wait", wait: "unreachable" },
    ]);
    expect(steps[2]).toEqual({ kind: "fallback", fallback: "update_desktop" });
    expect(timelineFailure(commandError("agent_chat_desktop_outdated"), 0).step).toEqual({
      kind: "fallback",
      fallback: "update_desktop",
    });
    expect(timelineFailure(commandError("conversation_version_unsupported"), 0).step).toEqual({
      kind: "fallback",
      fallback: "update_phone",
    });
    expect(timelineFailure(commandError("hub_unreachable"), 2)).toEqual({
      silentCloses: 0,
      step: { kind: "wait", wait: "unreachable" },
    });
  });

  it("polls faster while a turn runs or a request waits", () => {
    expect(agentChatActive(undefined)).toBe(false);
    expect(agentChatActive(timeline([]))).toBe(false);
    expect(agentChatActive({ ...timeline([]), turn: { turn_id: "turn-1" } })).toBe(true);
    expect(agentChatActive({ ...timeline([]), pending: [{ request_id: "r", kind: "unknown" }] })).toBe(true);
  });
});

describe("agent chat actions", () => {
  it("names a press with characters the computer's ids accept", () => {
    expect(newActionId("send", () => "1f3a/2 b")).toBe("send-1f3a2b");
    expect(newActionId("send", () => "x".repeat(100))).toHaveLength(64);
  });

  it("says where a sent message went, only when it did not simply start a turn", () => {
    expect(actionNotice("send", { state: "done", delivery: "started" })).toBeUndefined();
    expect(actionNotice("send", { state: "done", delivery: "steered" })?.key).toBe("agentChat.sent.steered");
    expect(actionNotice("send", { state: "done", delivery: "queued" })?.key).toBe("agentChat.sent.queued");
    expect(actionNotice("interrupt", { state: "done" })).toBeUndefined();
  });

  it("gives a refused or uncertain message back to the composer", () => {
    expect(actionNotice("send", { state: "refused", code: "runtime_unavailable" })).toEqual({
      key: "agentChat.refused.runtimeUnavailable",
      giveBack: true,
    });
    expect(actionNotice("send", { state: "refused", code: "rejected", detail: "usage_limit" })).toEqual({
      key: "agentChat.refused.rejected",
      values: { detail: "usage_limit" },
      giveBack: true,
    });
    expect(actionNotice("send", { state: "unknown" })).toEqual({ key: "agentChat.uncertain", giveBack: true });
    expect(actionNotice("answer", { state: "refused", code: "request_not_found" })).toEqual({
      key: "agentChat.refused.requestNotFound",
      giveBack: false,
    });
    expect(actionError("send")).toEqual({ key: "agentChat.notReached", giveBack: true });
  });
});

describe("question cards", () => {
  const questions: AgentChatQuestion[] = [
    {
      id: "db",
      question: "Which database?",
      options: [{ label: "SQLite" }, { label: "Postgres" }],
      multi_select: false,
      allow_other: true,
      is_secret: false,
    },
    {
      id: "checks",
      question: "Which checks?",
      options: [{ label: "lint" }, { label: "test" }, { label: "build" }],
      multi_select: true,
      allow_other: false,
      is_secret: false,
    },
  ];

  it("answers as the desktop card does: own words first, else labels in option order", () => {
    const multi = choose(choose(undefined, 2, true), 0, true);
    expect(questionAnswers(questions, [new Set([1]), multi], ["", ""])).toEqual({
      db: "Postgres",
      checks: "lint, build",
    });
    expect(questionAnswers(questions, [new Set([1]), multi], ["MySQL", ""])).toEqual({
      db: "MySQL",
      checks: "lint, build",
    });
  });

  it("is not ready while a question is unanswered", () => {
    expect(questionAnswers(questions, [new Set([0])], [])).toBeUndefined();
  });

  it("a single choice replaces, a multiple choice toggles", () => {
    expect([...choose(new Set([0]), 1, false)]).toEqual([1]);
    expect([...choose(new Set([0, 1]), 1, true)]).toEqual([0]);
  });
});

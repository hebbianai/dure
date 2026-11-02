import { describe, expect, it } from "vitest";
import type { AgentRuntimeState } from "./agentRuntimeState";
import {
  agentReadiness,
  applyTranscriptAnswer,
  type ChatTranscript,
  chatRows,
  completedTurns,
  CONVERSATION_DEFAULT_VIEW,
  defaultSessionView,
  refreshMark,
  sendsNow,
  sentPrompt,
  sentPromptSettled,
  SILENT_CLOSES_BEFORE_UPDATE,
  transcriptFailure,
} from "./chat";
import type { ConversationCursor, ConversationTranscriptAnswer } from "./ipc";

function runtime(overrides: Partial<AgentRuntimeState> = {}): AgentRuntimeState {
  return {
    lifecycle: "running",
    activity: "waiting",
    attention: "none",
    revision: "10",
    turnCompletedCount: "2",
    ...overrides,
  };
}

function cursor(overrides: Partial<ConversationCursor> = {}): ConversationCursor {
  return {
    terminal_epoch: "terminal-1",
    conversation_id: "conversation-1",
    turn_completed_count: 2,
    turn_open: false,
    runtime_revision: 10,
    ...overrides,
  };
}

function transcriptAnswer(
  overrides: Partial<ConversationTranscriptAnswer> = {},
): ConversationTranscriptAnswer {
  return {
    outcome: "transcript",
    provider: "claude",
    conversation_id: "conversation-1",
    entries: [
      { role: "user", text: "Run the tests" },
      { role: "agent", text: "All **12** tests pass." },
    ],
    history_complete: true,
    cursor: cursor(),
    ...overrides,
  };
}

function shown(answer: ConversationTranscriptAnswer, previous?: ChatTranscript): ChatTranscript {
  const step = applyTranscriptAnswer(previous, answer);
  if (step.kind !== "show") throw new Error(`expected a transcript, got ${step.kind}`);
  return step.transcript;
}

describe("the default view", () => {
  it("opens a session that reports a conversation on Chat, anything else on Terminal", () => {
    expect(CONVERSATION_DEFAULT_VIEW).toBe("chat");
    expect(defaultSessionView(true)).toBe("chat");
    expect(defaultSessionView(false)).toBe("terminal");
  });
});

describe("agentReadiness", () => {
  it("is idle only while running, waiting and without attention", () => {
    expect(agentReadiness(runtime())).toBe("idle");
    expect(agentReadiness(runtime({ activity: "working" }))).toBe("working");
    expect(agentReadiness(runtime({ attention: "approval_required" }))).toBe("attention");
    expect(agentReadiness(runtime({ attention: "input_required" }))).toBe("attention");
    expect(agentReadiness(runtime({ attention: "error", activity: "working" }))).toBe("attention");
    expect(agentReadiness(runtime({ lifecycle: "starting" }))).toBe("starting");
    expect(agentReadiness(runtime({ lifecycle: "exited" }))).toBe("exited");
    expect(agentReadiness(undefined)).toBe("unknown");
  });

  it("sends at once only when idle with nothing queued", () => {
    expect(sendsNow("idle", false)).toBe(true);
    expect(sendsNow("idle", true)).toBe(false);
    expect(sendsNow("working", false)).toBe(false);
  });
});

describe("refreshMark", () => {
  it("moves when a turn completes or starts, not on progress inside a turn", () => {
    const idle = refreshMark(runtime());
    expect(refreshMark(runtime({ revision: "11" }))).toBe(idle);
    expect(refreshMark(runtime({ attention: "approval_required", revision: "12" }))).toBe(idle);
    expect(refreshMark(runtime({ turnCompletedCount: "3" }))).not.toBe(idle);
    expect(refreshMark(runtime({ activity: "working" }))).not.toBe(idle);
    expect(refreshMark(undefined)).toBeUndefined();
  });
});

describe("applyTranscriptAnswer", () => {
  it("shows a first transcript with its cursor", () => {
    const step = applyTranscriptAnswer(undefined, transcriptAnswer());
    expect(step).toEqual({
      kind: "show",
      changed: true,
      transcript: {
        entries: transcriptAnswer().entries,
        historyComplete: true,
        cursor: cursor(),
        provider: "claude",
        conversationId: "conversation-1",
      },
    });
  });

  it("keeps the drawn messages on an unchanged answer and takes its cursor", () => {
    const previous = shown(transcriptAnswer());
    const next = cursor({ runtime_revision: 14 });
    const step = applyTranscriptAnswer(previous, {
      outcome: "unchanged",
      entries: [],
      history_complete: false,
      cursor: next,
      provider: "claude",
      conversation_id: "conversation-1",
    });
    expect(step).toEqual({ kind: "show", changed: false, transcript: { ...previous, cursor: next } });
  });

  it("does not repaint a re-read that found the same messages", () => {
    const previous = shown(transcriptAnswer());
    const step = applyTranscriptAnswer(
      previous,
      transcriptAnswer({ cursor: cursor({ turn_open: true }) }),
    );
    expect(step.kind === "show" && step.changed).toBe(false);
  });

  it("repaints when a message arrives or the conversation changes", () => {
    const previous = shown(transcriptAnswer());
    const longer = transcriptAnswer({
      entries: [...transcriptAnswer().entries, { role: "user", text: "Now lint" }],
    });
    expect(applyTranscriptAnswer(previous, longer)).toMatchObject({ kind: "show", changed: true });
    const other = transcriptAnswer({ conversation_id: "conversation-2" });
    expect(applyTranscriptAnswer(previous, other)).toMatchObject({ kind: "show", changed: true });
  });

  it("falls back to the terminal for remote and non-agent sessions", () => {
    for (const code of ["remote_unsupported", "unsupported_runtime"] as const) {
      expect(
        applyTranscriptAnswer(undefined, {
          outcome: "refused",
          entries: [],
          history_complete: false,
          code,
        }),
      ).toEqual({ kind: "fallback", fallback: "not_available" });
    }
  });

  it("keeps asking after a refusal that may pass", () => {
    for (const code of [
      "conversation_unknown",
      "transcript_unavailable",
      "probe_timeout",
      "unavailable",
      "session_not_found",
    ] as const) {
      expect(
        applyTranscriptAnswer(undefined, {
          outcome: "refused",
          entries: [],
          history_complete: false,
          code,
        }),
      ).toEqual({ kind: "wait", wait: code });
    }
    expect(
      applyTranscriptAnswer(undefined, {
        outcome: "refused",
        entries: [],
        history_complete: false,
        code: "not_idle",
      }),
    ).toEqual({ kind: "wait", wait: "unknown" });
  });
});

describe("transcriptFailure", () => {
  const silent = { code: "conversation_no_answer", message: "closed" };

  it("reads one silent close as a failed ask, not as an old computer", () => {
    expect(transcriptFailure(silent, 0)).toEqual({
      silentCloses: 1,
      step: { kind: "wait", wait: "unreachable" },
    });
  });

  it("suggests updating only after silent closes in a row, and never forces the terminal", () => {
    let run = 0;
    let step = transcriptFailure(silent, run).step;
    for (let attempt = 0; attempt < SILENT_CLOSES_BEFORE_UPDATE; attempt += 1) {
      const failed = transcriptFailure(silent, run);
      run = failed.silentCloses;
      step = failed.step;
    }
    expect(step).toEqual({ kind: "wait", wait: "no_answer" });
    // Anything else ends the run.
    expect(transcriptFailure({ code: "hub_unreachable", message: "" }, run)).toEqual({
      silentCloses: 0,
      step: { kind: "wait", wait: "unreachable" },
    });
  });

  it("asks to update the phone when it cannot read the computer's answer", () => {
    expect(
      transcriptFailure({ code: "conversation_version_unsupported", message: "" }, 2).step,
    ).toEqual({ kind: "fallback", fallback: "update_phone" });
  });

  it("keeps asking when the computer could not be reached", () => {
    expect(transcriptFailure({ code: "hub_computer_offline", message: "" }, 0).step).toEqual({
      kind: "wait",
      wait: "unreachable",
    });
    expect(transcriptFailure(new Error("boom"), 0).step).toEqual({
      kind: "wait",
      wait: "unreachable",
    });
  });
});

describe("a sent prompt", () => {
  const before = shown(transcriptAnswer());

  it("counts turns from the session's runtime, as a decimal string", () => {
    expect(completedTurns(runtime({ turnCompletedCount: "7" }))).toBe(7);
    expect(completedTurns(undefined)).toBeUndefined();
  });

  it("settles when the transcript carries one more message with its text", () => {
    const sent = sentPrompt("Run  the tests\n", before, 2);
    expect(sent.matchesAtSend).toBe(1);
    expect(sentPromptSettled(sent, before)).toBe(false);
    const after = shown(
      transcriptAnswer({
        entries: [...before.entries, { role: "user", text: "Run the tests" }],
        cursor: cursor({ turn_open: true }),
      }),
    );
    expect(sentPromptSettled(sent, after)).toBe(true);
  });

  it("settles once the prompt's own turn has completed, even if the text reads differently", () => {
    const sent = sentPrompt("Lint, please", before, 2);
    expect(sentPromptSettled(sent, shown(transcriptAnswer()))).toBe(false);
    const after = shown(transcriptAnswer({ cursor: cursor({ turn_completed_count: 3 }) }));
    expect(sentPromptSettled(sent, after)).toBe(true);
  });

  /**
   * A queued prompt goes out turns after the last read. Counting from that
   * read would settle the bubble at the next one, before the prompt is there.
   */
  it("does not settle on a read that only catches up with turns before it", () => {
    const stale = shown(transcriptAnswer({ cursor: cursor({ turn_completed_count: 2 }) }));
    // The session had completed 4 turns when the prompt went out.
    const sent = sentPrompt("Deploy", stale, 4);
    expect(sent.matchesAtSend).toBeUndefined();
    const caughtUp = shown(
      transcriptAnswer({
        entries: [
          ...stale.entries,
          { role: "user", text: "Deploy" },
          { role: "agent", text: "An earlier deploy." },
        ],
        cursor: cursor({ turn_completed_count: 4 }),
      }),
    );
    expect(sentPromptSettled(sent, caughtUp)).toBe(false);
    const done = shown(transcriptAnswer({ cursor: cursor({ turn_completed_count: 5 }) }));
    expect(sentPromptSettled(sent, done)).toBe(true);
  });

  it("settles when the agent moved to another conversation", () => {
    const sent = sentPrompt("Lint, please", before, 2);
    const after = shown(transcriptAnswer({ conversation_id: "conversation-2" }));
    expect(sentPromptSettled(sent, after)).toBe(true);
  });
});

describe("chatRows", () => {
  it("maps each entry to a row and leaves empty messages out", () => {
    expect(
      chatRows([
        { role: "user", text: "Run the tests" },
        { role: "agent", text: "   " },
        { role: "agent", text: "Done", truncated: true },
      ]),
    ).toEqual([
      { role: "user", text: "Run the tests", truncated: false },
      { role: "agent", text: "Done", truncated: true },
    ]);
  });
});

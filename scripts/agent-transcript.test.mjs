import { describe, expect, it, vi } from "vitest";
import {
  agentTranscriptFromProvider,
  collectAgentTranscript,
  formatAgentTranscript,
  nativeAgentTranscriptSource,
  recordedAgentTranscriptSource,
} from "../cli/lib/agent-transcript.mjs";

const binding = {
  schemaVersion: 1,
  interactionSessionId: "interaction-1",
  agentId: "agent-1",
  providerId: "codex",
  executionProfile: { kind: "provider_default" },
  providerConversationRef: "thread-1",
  runtime: { runtimeGeneration: "runtime-1", providerEpoch: "provider-1" },
  timelineEpoch: "timeline-1",
  bindingRevision: 1,
  historyComplete: true,
  createdAtMs: 1,
  updatedAtMs: 1,
};

function row(sequence, body, itemId = `item-${sequence}`) {
  return {
    cursor: { epoch: "timeline-1", sequence },
    item: {
      itemId,
      turnId: null,
      clientMessageId: null,
      providerMessageId: null,
      body,
      createdAtMs: sequence,
    },
  };
}

function page(rows, { hasMore = false, liveText = [], finalSequence } = {}) {
  return {
    type: "page",
    page: {
      binding,
      rows,
      liveText,
      pendingRequests: [],
      activeTurn: null, latestFailure: null,
      finalCursor: {
        epoch: "timeline-1",
        sequence: finalSequence ?? rows.at(-1)?.cursor.sequence ?? 0,
      },
      hasMore,
    },
  };
}

describe("agent transcript policy", () => {
  it("exports automatic goal input without assigning it to a human author", async () => {
    const transcript = await collectAgentTranscript({ agentId: "agent-1", providerId: "codex",
      interactionSessionId: "interaction-1", entryLimit: null,
      readPage: async () => page([row(1, { type: "goal_continuation", objective: "Finish the report", goal_revision: 2 })]),
    });
    expect(transcript.entries).toMatchObject([{ kind: "goal_continuation", text: "Finish the report" }]);
    expect(transcript.entries[0]).not.toHaveProperty("role");
    expect(formatAgentTranscript(transcript)).toContain("Finish the report");
    expect(formatAgentTranscript(transcript)).not.toContain("## User");
  });

  it("exports a confirmed question answer while masking secret input", async () => {
    const transcript = await collectAgentTranscript({ agentId: "agent-1", providerId: "codex",
      interactionSessionId: "interaction-1", entryLimit: null,
      readPage: async () => page([row(1, { type: "pending_answer", idempotency_key: "answer-1",
        request: { request: { kind: "question", payload: { input: { questions: [
          { id: "direction", question: "Which direction?", options: [] },
          { id: "secret", question: "Private value?", options: [], isSecret: true },
        ] } } } }, answer: { answers: { direction: "Finish the agreed report", secret: "fixture-secret-value" } },
      })]),
    });
    for (const json of [false, true]) {
      const output = formatAgentTranscript(transcript, { json });
      expect(output).toContain("Finish the agreed report");
      expect(output).not.toContain("fixture-secret-value");
    }
  });

  it("resolves the same exact native conversation source for UI and CLI", () => {
    const agent = {
      id: "agent-native",
      provider: "codex",
      sessionKind: "pty",
      conversationId: "observed-older",
      runtimeBinding: {
        source: "local",
        conversationIdentity: {
          providerId: "codex",
          conversationId: "host-owned-exact",
        },
      },
    };

    expect(nativeAgentTranscriptSource(agent)).toEqual({
      kind: "local",
      agentId: "agent-native",
      provider: "codex",
      conversationId: "host-owned-exact",
    });
    expect(
      nativeAgentTranscriptSource(agent, {
        source: "ssh",
        conversationIdentity: agent.runtimeBinding.conversationIdentity,
      }),
    ).toEqual({ kind: "remote" });
    expect(
      nativeAgentTranscriptSource({
        ...agent,
        runtimeBinding: { source: "local" },
      }),
    ).toEqual({ kind: "identity_unavailable" });
  });

  it("reads an ended Agent's recorded conversation only where its binding records none", () => {
    const agent = {
      id: "agent-ended",
      provider: "codex",
      sessionKind: "pty",
      conversationId: "recorded-thread",
      runtimeBinding: { source: "local" },
    };
    // A live binding without a record has none to show.
    expect(nativeAgentTranscriptSource(agent)).toEqual({
      kind: "identity_unavailable",
    });
    expect(recordedAgentTranscriptSource(agent)).toEqual({
      kind: "local",
      agentId: "agent-ended",
      provider: "codex",
      conversationId: "recorded-thread",
    });
    // The binding's own record wins, and one for another provider means the
    // Agent's recorded id may be that provider's: neither falls back.
    const projected = (providerId) => ({
      ...agent,
      runtimeBinding: {
        source: "local",
        conversationIdentity: { providerId, conversationId: "host-thread" },
      },
    });
    expect(recordedAgentTranscriptSource(projected("codex"))).toMatchObject({
      conversationId: "host-thread",
    });
    expect(recordedAgentTranscriptSource(projected("claude"))).toEqual({
      kind: "identity_unavailable",
    });
    expect(
      recordedAgentTranscriptSource({ ...agent, runtimeBinding: { source: "ssh" } }),
    ).toEqual({ kind: "remote" });
    expect(
      recordedAgentTranscriptSource({ ...agent, conversationId: "../escape" }),
    ).toEqual({ kind: "identity_unavailable" });
  });

  it("reads Pi's own session as it reads Claude's and Codex's transcripts", () => {
    const pi = {
      id: "agent-pi",
      provider: "pi",
      sessionKind: "pty",
      runtimeBinding: {
        source: "local",
        conversationIdentity: { providerId: "pi", conversationId: "pi-session" },
      },
    };
    expect(nativeAgentTranscriptSource(pi)).toEqual({
      kind: "local",
      agentId: "agent-pi",
      provider: "pi",
      conversationId: "pi-session",
    });
    expect(
      nativeAgentTranscriptSource({ ...pi, provider: "opencode" }),
    ).toEqual({ kind: "unsupported" });
  });

  it("applies the same last-entry selection to native provider transcripts", () => {
    const transcript = agentTranscriptFromProvider({
      source: {
        kind: "local",
        agentId: "agent-native",
        provider: "codex",
        conversationId: "conversation-1",
      },
      entryLimit: 2,
      transcript: {
        schemaVersion: 1,
        provider: "codex",
        conversationId: "conversation-1",
        historyComplete: true,
        entries: [
          { role: "user", text: "first" },
          { role: "agent", text: "second" },
          { role: "user", text: "third" },
        ],
      },
    });

    expect(transcript.entries.map((entry) => entry.text)).toEqual([
      "second",
      "third",
    ]);
    expect(formatAgentTranscript(transcript)).toContain(
      "Provider conversation: `conversation-1`",
    );
  });

  it("pages backward until it has the requested transcript entries", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            row(5, { type: "lifecycle", state: "turn_started", detail: null }),
            row(6, { type: "message", role: "assistant", markdown: "new answer" }),
          ],
          { hasMore: true, finalSequence: 6 },
        ),
      )
      .mockResolvedValueOnce(
        page(
          [
            row(2, { type: "message", role: "user", markdown: "old question" }),
            row(3, { type: "reasoning", text: "checked the repository" }),
            row(4, { type: "message", role: "assistant", markdown: "old answer" }),
          ],
          { finalSequence: 2 },
        ),
      );

    const transcript = await collectAgentTranscript({
      agentId: "agent-1",
      providerId: "codex",
      interactionSessionId: "interaction-1",
      entryLimit: 3,
      readPage,
    });

    expect(readPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        direction: "before",
        cursor: { epoch: "timeline-1", sequence: 5 },
      }),
    );
    expect(transcript.entries.map((entry) => entry.kind)).toEqual([
      "reasoning",
      "message",
      "message",
    ]);
    expect(transcript.entries.at(-1)).toMatchObject({ text: "new answer" });
  });

  it("rejects a timeline bound to a different Agent authority", async () => {
    await expect(
      collectAgentTranscript({
        agentId: "agent-expected",
        providerId: "codex",
        interactionSessionId: "interaction-1",
        entryLimit: 20,
        readPage: async () => page([]),
      }),
    ).rejects.toMatchObject({ code: "agent_transcript_response_invalid" });
  });

  it("includes unfinished assistant text once and excludes provider evidence", async () => {
    const transcript = await collectAgentTranscript({
      agentId: "agent-1",
      providerId: "codex",
      interactionSessionId: "interaction-1",
      entryLimit: null,
      readPage: async () =>
        page(
          [
            row(1, {
              type: "provider_evidence",
              namespace: "private",
              kind: "raw",
              value: { token: "never-export" },
            }),
            row(2, { type: "message", role: "user", markdown: "hello" }),
          ],
          {
            liveText: [
              {
                streamId: "stream-1",
                itemId: "live-item-1",
                kind: "assistant",
                text: "working answer",
                turnId: null,
                clientMessageId: null,
                providerMessageId: "provider-message-1",
                updatedAtMs: 3,
              },
            ],
          },
        ),
    });

    expect(transcript.entries).toHaveLength(2);
    const markdown = formatAgentTranscript(transcript);
    expect(markdown).toContain("## User\n\nhello");
    expect(markdown).toContain("## Assistant\n\nworking answer");
    expect(markdown).not.toContain("never-export");
  });

  it("reads a conversation whose timeline records queued input state", async () => {
    const queued = (sequence, state) =>
      row(sequence, { type: "queued_input", state }, `input-${state}-${sequence}`);
    const readPage = async () =>
      page([
        row(1, { type: "message", role: "user", markdown: "first" }),
        row(2, { type: "message", role: "assistant", markdown: "done" }),
        queued(3, "queued"),
        queued(4, "queued"),
        queued(5, "dispatched"),
        row(6, { type: "message", role: "user", markdown: "second" }),
        queued(7, "canceled"),
      ]);
    const all = await collectAgentTranscript({
      agentId: "agent-1",
      providerId: "codex",
      interactionSessionId: "interaction-1",
      entryLimit: null,
      readPage,
    });
    const last = await collectAgentTranscript({
      agentId: "agent-1",
      providerId: "codex",
      interactionSessionId: "interaction-1",
      entryLimit: 2,
      readPage,
    });

    expect(all.entries.map(({ kind, text }) => [kind, text])).toEqual([
      ["message", "first"],
      ["message", "done"],
      ["message", "second"],
    ]);
    expect(last.entries.map(({ text }) => text)).toEqual(["done", "second"]);
    expect(formatAgentTranscript(last)).not.toContain("queued");
  });

  it("normalizes raw backend tool fields at the shared transcript boundary", async () => {
    const transcript = await collectAgentTranscript({
      agentId: "agent-1",
      providerId: "codex",
      interactionSessionId: "interaction-1",
      entryLimit: null,
      readPage: async () =>
        page([
          row(1, {
            type: "tool",
            tool_call_id: "call/1",
            name: "Read",
            state: "completed",
            input: { path: "README.md" },
            output: { ok: true },
          }),
          row(2, { type: "tool_input", json_text: '{"path":"README.md"}' }),
        ]),
    });

    expect(transcript.entries).toMatchObject([
      { kind: "tool", name: "Read", state: "completed" },
      { kind: "tool_input", text: '{"path":"README.md"}' },
    ]);
  });
});

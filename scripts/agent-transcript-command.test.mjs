import { describe, expect, it, vi } from "vitest";
import {
  collectBackendAgentTranscript,
  formatBackendAgentTranscript,
} from "../cli/lib/agent-transcript-command.mjs";

const profile = {
  id: "local",
  transport: { kind: "local" },
  expected: {
    backendId: "backend-1",
    generation: "generation-1",
    protocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
    capabilities: [
      "agent_conversation.inspect",
      "agent_conversation.read.v6",
    ],
  },
  deadlineMs: 2_500,
};

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

describe("agent transcript CLI adapter", () => {
  it("uses inspect and canonical timeline read on the selected backend", async () => {
    const requestBackend = vi
      .fn()
      .mockResolvedValueOnce({ result: { schemaVersion: 1, binding } })
      .mockResolvedValueOnce({
        result: {
          schemaVersion: 1,
          read: {
            type: "page",
            page: {
              binding,
              rows: [
                {
                  cursor: { epoch: "timeline-1", sequence: 1 },
                  item: {
                    itemId: "item-1",
                    turnId: null,
                    clientMessageId: null,
                    providerMessageId: null,
                    body: { type: "message", role: "user", markdown: "ship it" },
                    createdAtMs: 1,
                  },
                },
              ],
              liveText: [],
              pendingRequests: [],
              activeTurn: null, latestFailure: null,
              finalCursor: { epoch: "timeline-1", sequence: 1 },
              hasMore: false,
            },
          },
        },
      });

    const transcript = await collectBackendAgentTranscript({
      agentId: "agent-1",
      backend: { profile, transportOptions: {} },
      entryLimit: 20,
      expectedInteractionSessionId: "interaction-1",
      requestBackend,
    });

    expect(requestBackend.mock.calls.map((call) => call[1].operation)).toEqual([
      "agent_conversation.inspect",
      "agent_conversation.read",
    ]);
    expect(requestBackend.mock.calls[1][1].requiredCapabilities).toEqual([
      "agent_conversation.read.v6",
    ]);
    expect(formatBackendAgentTranscript(transcript)).toContain("## User\n\nship it");
    expect(JSON.parse(formatBackendAgentTranscript(transcript, { json: true }))).toMatchObject({
      kind: "dure.agent_transcript",
      scope: { kind: "last", count: 20 },
    });
  });
});

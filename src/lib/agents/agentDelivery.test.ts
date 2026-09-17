import { beforeEach, describe, expect, it, vi } from "vitest";

const hmuxInput = vi.hoisted(() => ({ send: vi.fn(async () => ({})) }));
vi.mock("@/lib/sessions/managed/managedAgentInput", () => ({
  sendHmuxAgentCommandInput: hmuxInput.send,
}));

import {
  deliverAgentPrompt,
  typeAgentPrompt,
  wrapBracketedPaste,
} from "@/lib/agents/agentDelivery";
import type { Agent } from "@/types";

describe("wrapBracketedPaste", () => {
  it("wraps text in bracketed-paste markers", () => {
    expect(wrapBracketedPaste("a\nb")).toBe("\x1b[200~a\nb\x1b[201~");
  });
});

describe("deliverAgentPrompt", () => {
  beforeEach(() => {
    hmuxInput.send.mockClear();
  });

  it("keeps Hmux text and submit as one reusable semantic operation", async () => {
    const agent = {
      id: "a1",
      sessionKind: "pty",
      sessionId: "s1",
      runtimeBinding: {
        runtime: "hmux_managed_v1",
        source: "local",
        sessionId: "s1",
        workspaceId: "w1",
      },
    } as unknown as Agent;

    await deliverAgentPrompt(agent, "line1\nline2");

    expect(hmuxInput.send).toHaveBeenCalledOnce();
    expect(hmuxInput.send).toHaveBeenCalledWith(
      agent,
      "\x1b[200~line1\nline2\x1b[201~",
      true,
    );
  });

  it("types without submitting for user-reviewed surfaces", async () => {
    const agent = {
      id: "a1",
      sessionKind: "pty",
      sessionId: "s1",
      runtimeBinding: {
        runtime: "hmux_managed_v1",
        source: "local",
        sessionId: "s1",
        workspaceId: "w1",
      },
    } as unknown as Agent;

    await typeAgentPrompt(agent, "capture");

    expect(hmuxInput.send).toHaveBeenCalledOnce();
    expect(hmuxInput.send).toHaveBeenCalledWith(
      agent,
      "\x1b[200~capture\x1b[201~",
      false,
    );
  });
});

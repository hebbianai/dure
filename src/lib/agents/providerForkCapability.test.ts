import { describe, expect, it } from "vitest";
import { providerForkInheritsConversation } from "@/lib/agents/providerForkCapability";

describe("provider fork capability", () => {
  it("inherits only through a reviewed same-provider conversation fork", () => {
    expect(providerForkInheritsConversation("claude", "claude")).toBe(true);
    expect(providerForkInheritsConversation("codex", "codex")).toBe(true);
    expect(providerForkInheritsConversation("claude", "codex")).toBe(false);
  });
});

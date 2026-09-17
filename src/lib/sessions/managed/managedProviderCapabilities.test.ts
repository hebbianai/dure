import { describe, expect, it } from "vitest";
import {
  managedConversationIdentitySource,
  supportsManagedConversationIdentityInspection,
  supportsStandaloneManagedPromotion,
} from "@/lib/sessions/managed/managedProviderCapabilities";

describe("managed provider capabilities", () => {
  it("routes exact identity discovery through provider-owned evidence", () => {
    expect(managedConversationIdentitySource("codex")).toBe("host_rollout");
    expect(managedConversationIdentitySource("claude")).toBe(
      "session_start_hook",
    );
    expect(managedConversationIdentitySource("kimi")).toBeUndefined();
  });

  it("allows exact live inspection to recover a missing hook projection", () => {
    expect(supportsManagedConversationIdentityInspection("codex")).toBe(true);
    expect(supportsManagedConversationIdentityInspection("claude")).toBe(true);
    expect(supportsManagedConversationIdentityInspection("kimi")).toBe(false);
  });

  it("allows standalone promotion for every reviewed exact-adoption adapter", () => {
    expect(supportsStandaloneManagedPromotion("codex")).toBe(true);
    expect(supportsStandaloneManagedPromotion("claude")).toBe(true);
    expect(supportsStandaloneManagedPromotion("kimi")).toBe(false);
  });
});

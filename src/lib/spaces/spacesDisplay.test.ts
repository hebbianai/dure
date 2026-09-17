import { describe, expect, it } from "vitest";
import { resolveAgentDisplayFromTiers } from "@/lib/agents/agentStateModel";
import {
  compareUnopenedAgents,
  DISPLAY_RANK,
  latestAgentActivity,
} from "@/lib/spaces/spacesDisplay";

describe("resolveAgentDisplayFromTiers", () => {
  it("prefers hmux semantic state over heuristic", () => {
    expect(
      resolveAgentDisplayFromTiers({
        heuristic: "waiting",
        hmux: { lifecycle: "running", activity: "waiting", attention: "approval_required" },
      }),
    ).toBe("blocked");
  });

  it("uses presentation lifecycle while no Host projection exists", () => {
    expect(
      resolveAgentDisplayFromTiers({
        heuristic: "working",
      }),
    ).toBe("working");
  });
});

describe("compareUnopenedAgents", () => {
  const base = { name: "a" };
  it("puts unread first regardless of state rank", () => {
    const unreadWaiting = { ...base, unread: true, state: "waiting" as const };
    const readBlocked = { ...base, unread: false, state: "blocked" as const, name: "b" };
    expect(compareUnopenedAgents(unreadWaiting, readBlocked)).toBeLessThan(0);
  });

  it("ranks attention above working", () => {
    expect(DISPLAY_RANK.blocked).toBeLessThan(DISPLAY_RANK.input);
    expect(DISPLAY_RANK.input).toBeLessThan(DISPLAY_RANK.working);
    const blocked = { ...base, unread: false, state: "blocked" as const };
    const working = { ...base, unread: false, state: "working" as const, name: "b" };
    expect(compareUnopenedAgents(blocked, working)).toBeLessThan(0);
  });

  // The checkpoint tiebreak retired with the feature (2026-08-27): ties fall
  // through to the stable name order.
  it("breaks ties by name", () => {
    const first = { unread: false, state: "waiting" as const, name: "a" };
    const second = { unread: false, state: "waiting" as const, name: "b" };
    expect(compareUnopenedAgents(first, second)).toBeLessThan(0);
  });
});

describe("unopened agent activity presentation", () => {
  it("keeps the activity text aligned with its timestamp", () => {
    const prompt = { text: "prompt", at: 20 };

    expect(latestAgentActivity(undefined)).toBeUndefined();
    expect(latestAgentActivity(prompt)).toBe(prompt);
  });
});

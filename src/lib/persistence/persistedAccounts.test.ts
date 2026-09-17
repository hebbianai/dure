import { describe, expect, it } from "vitest";
import { normalizePersistedActiveAccounts } from "@/lib/persistence/persistedAccounts";
import type { AccountProfile } from "@/types";

const accounts: AccountProfile[] = [
  {
    id: "acc-crispy",
    provider: "codex",
    name: "crispy",
    dir: "/Users/test/.hebbian/accounts/codex-crispy",
  },
  {
    id: "acc-claude",
    provider: "claude",
    name: "Claude work",
    dir: "/Users/test/.hebbian/accounts/claude-work",
  },
];

describe("persisted provider accounts", () => {
  it("preserves valid Codex and Claude selectors across app restart", () => {
    expect(
      normalizePersistedActiveAccounts(
        {
          codex: "acc-crispy",
          claude: "acc-claude",
        },
        accounts,
      ),
    ).toEqual({
      codex: "acc-crispy",
      claude: "acc-claude",
    });
  });

  it("drops stale, mismatched, and unsupported selectors", () => {
    expect(
      normalizePersistedActiveAccounts(
        {
          codex: "acc-claude",
          claude: "missing",
          gemini: "acc-gemini",
        },
        accounts,
      ),
    ).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import {
  hmuxManagedPromotionAvailability,
  type HmuxManagedPromotionCandidate,
} from "@/lib/hmux/conversion/hmuxManagedPromotionEligibility";
import type { Project } from "@/types";

const project = {
  id: "project-1",
  name: "HebbianIDE",
  path: "/repo",
  kind: "local",
  isRepo: true,
} satisfies Project;

const candidate = {
  kind: "term",
  runtime: "hmux_standalone_v1",
  provider: "codex",
  displayState: "waiting",
  cwd: "/repo/.worktrees/agent-a",
} satisfies HmuxManagedPromotionCandidate;

describe("hmuxManagedPromotionAvailability", () => {
  it("offers only an idle local standalone supported pane with one owning project", () => {
    expect(hmuxManagedPromotionAvailability(candidate, [project])).toBe(
      "eligible",
    );
    expect(
      hmuxManagedPromotionAvailability(
        {
          ...candidate,
          runtime: "hmux_managed_v1",
          workspaceId: "dure-local-shells-v1",
        } as HmuxManagedPromotionCandidate,
        [project],
      ),
    ).toBe("eligible");
    expect(
      hmuxManagedPromotionAvailability(
        {
          ...candidate,
          runtime: "hmux_managed_v1",
          workspaceId: "managed-agent-workspace",
        } as HmuxManagedPromotionCandidate,
        [project],
      ),
    ).toBe("hidden");
    expect(
      hmuxManagedPromotionAvailability(
        { ...candidate, hostId: "ssh-1" },
        [project],
      ),
    ).toBe("hidden");
    expect(
      hmuxManagedPromotionAvailability(
        { ...candidate, executionLocationKnown: false },
        [project],
      ),
    ).toBe("hidden");
  });

  it("defers working, attention, and not-yet-observed sessions without mutation", () => {
    expect(
      hmuxManagedPromotionAvailability(
        { ...candidate, displayState: "working" },
        [project],
      ),
    ).toBe("working");
    expect(
      hmuxManagedPromotionAvailability(
        { ...candidate, displayState: "blocked" },
        [project],
      ),
    ).toBe("attention_required");
    expect(
      hmuxManagedPromotionAvailability(
        { ...candidate, displayState: undefined },
        [project],
      ),
    ).toBe("not_ready");
  });

  it("shares reviewed provider support and explains unsupported providers", () => {
    expect(
      hmuxManagedPromotionAvailability(
        { ...candidate, provider: "claude" },
        [project],
      ),
    ).toBe("eligible");
    expect(
      hmuxManagedPromotionAvailability(
        { ...candidate, provider: "kimi" },
        [project],
      ),
    ).toBe("provider_unsupported");
  });

  it("rejects ambiguous project ownership", () => {
    expect(
      hmuxManagedPromotionAvailability(candidate, [
        project,
        { ...project, id: "project-2", name: "duplicate" },
      ]),
    ).toBe("project_ambiguous");
    expect(hmuxManagedPromotionAvailability(candidate, [])).toBe(
      "project_not_found",
    );
  });
});

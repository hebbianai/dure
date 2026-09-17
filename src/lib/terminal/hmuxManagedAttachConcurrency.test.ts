import { describe, expect, it } from "vitest";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import {
  hmuxSessionSummaryFixture,
  stopFenceFixture,
} from "@/test/agentFixtures";
import { managedLocalRuntimeLiveness } from "./hmuxManagedAttachConcurrency";

const stopFence = stopFenceFixture({
  hostInstanceId: "host-1",
  terminalEpoch: "terminal-1",
});
const binding = hmuxManagedBinding(
  "session-1",
  "workspace-1",
  undefined,
  undefined,
  stopFence,
);

function summary(
  overrides: Partial<HmuxSessionSummary> = {},
): HmuxSessionSummary {
  return hmuxSessionSummaryFixture({
    sessionId: binding.sessionId,
    workspaceId: binding.workspaceId,
    manifestLifecycle: "ready",
    hostProcessAlive: true,
    terminalEpoch: stopFence.terminalEpoch,
    stopFence,
    outputSeq: "12",
    ...overrides,
  });
}

function sessions(session: HmuxSessionSummary) {
  return {
    [hmuxSessionMetadataKey(session.workspaceId, session.sessionId)]: session,
  };
}

describe("managedLocalRuntimeLiveness", () => {
  it("reports an exact healthy managed generation alive", () => {
    expect(managedLocalRuntimeLiveness(binding, sessions(summary()))).toBe(
      "alive",
    );
    expect(
      managedLocalRuntimeLiveness(
        binding,
        sessions(summary({ health: "compatible_old_healthy" })),
      ),
    ).toBe("alive");
  });

  it.each([
    ["missing metadata", {}],
    ["stale transport", sessions(summary({ health: "stale_transport" }))],
    [
      "changed generation",
      sessions(
        summary({
          terminalEpoch: "terminal-2",
          stopFence: { ...stopFence, terminalEpoch: "terminal-2" },
        }),
      ),
    ],
  ])("rejects %s", (_case, metadata) => {
    expect(managedLocalRuntimeLiveness(binding, metadata)).toBe("unknown");
  });

  it.each([
    ["exited lifecycle", { lifecycle: "exited" as const }],
    ["exited manifest", { manifestLifecycle: "exited" as const }],
    ["exited health", { health: "exited" as const }],
    ["dead host", { hostProcessAlive: false }],
  ])("reports an exact %s generation exited", (_case, overrides) => {
    expect(
      managedLocalRuntimeLiveness(binding, sessions(summary(overrides))),
    ).toBe("exited");
  });

  it("rejects first-run managed and standalone bindings", () => {
    expect(
      managedLocalRuntimeLiveness(
        hmuxManagedBinding("session-1", "workspace-1"),
        sessions(summary()),
      ),
    ).toBe("unknown");
    expect(
      managedLocalRuntimeLiveness(
        hmuxStandaloneBinding("session-1", "workspace-1"),
        sessions(summary()),
      ),
    ).toBe("unknown");
  });
});

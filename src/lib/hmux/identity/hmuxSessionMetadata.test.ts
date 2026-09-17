import { describe, expect, it } from "vitest";
import {
  hmuxSessionDiagnosticDetail,
  hmuxSessionMetadataKey,
  mergeHmuxSessionMetadata,
  normalizeHmuxSessionSummary,
  sameHmuxSessionSummary,
} from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { hmuxSessionSummaryFixture } from "@/test/agentFixtures";

function summary(patch: Partial<HmuxSessionSummary> = {}): HmuxSessionSummary {
  return hmuxSessionSummaryFixture({
    sessionId: "session",
    sessionName: "hmux-codex",
    workspaceId: "workspace",
    sessionClass: "standalone",
    terminalEpoch: "epoch",
    outputSeq: "1",
    capabilities: ["ansi_redraw_v1"],
    health: undefined,
    ...patch,
  });
}

describe("Hmux session metadata", () => {
  it("keys the exact workspace and session tuple without delimiter collisions", () => {
    expect(hmuxSessionMetadataKey("a:b", "c")).not.toBe(
      hmuxSessionMetadataKey("a", "b:c"),
    );
  });

  it("normalizes display names and owns its capability list", () => {
    const capabilities = ["ansi_redraw_v1"];
    const normalized = normalizeHmuxSessionSummary(
      summary({ sessionName: "  hmux-codex  ", capabilities }),
    );
    capabilities.push("shared_terminal_input");

    expect(normalized.sessionName).toBe("hmux-codex");
    expect(normalized.capabilities).toEqual(["ansi_redraw_v1"]);
  });

  it("detects every summary field used by the shared runtime cache", () => {
    const first = summary();
    expect(sameHmuxSessionSummary(first, summary())).toBe(true);
    expect(sameHmuxSessionSummary(first, summary({ outputSeq: "2" }))).toBe(
      false,
    );
    expect(
      sameHmuxSessionSummary(
        first,
        summary({ capabilities: ["ansi_redraw_v1", "shared_terminal_input"] }),
      ),
    ).toBe(false);
    expect(
      sameHmuxSessionSummary(
        first,
        summary({
          retirementPolicy: {
            kind: "after_graceful_last_client_departure_v1",
            gracePeriodMs: 2_000,
          },
        }),
      ),
    ).toBe(false);
  });

  it("merges a complete projection with one map copy and stable unchanged entries", () => {
    const first = summary({ sessionId: "first" });
    const second = summary({ sessionId: "second" });
    const exact = summary({ sessionId: "exact", workspaceId: "remote" });
    const initial = mergeHmuxSessionMetadata({}, [first, second, exact]);
    const identical = mergeHmuxSessionMetadata(initial, [first, second]);
    const changed = mergeHmuxSessionMetadata(identical, [
      { ...first, outputSeq: "2" },
      second,
    ]);
    const secondKey = hmuxSessionMetadataKey("workspace", "second");
    const exactKey = hmuxSessionMetadataKey("remote", "exact");

    expect(identical).toBe(initial);
    expect(changed).not.toBe(initial);
    expect(changed[secondKey]).toBe(initial[secondKey]);
    expect(changed[exactKey]).toBe(initial[exactKey]);
  });

  it("retains failure capsule updates in the shared runtime cache", () => {
    const failure = {
      correlationId: "failure_0123456789abcdef",
      sessionId: "session",
      workspaceId: "workspace",
      terminalEpoch: "epoch",
      code: "provider_exited_before_conversation_identity",
      phase: "conversation_identity" as const,
      summary: "Provider exited with status 1 before conversation identity.",
      exitKind: "provider_error" as const,
      exitCode: 1,
      occurredUnixMs: "1786848179086",
      retryPosture: "never" as const,
    };

    expect(
      sameHmuxSessionSummary(
        summary({ failure }),
        summary({ failure: { ...failure } }),
      ),
    ).toBe(true);
    expect(
      sameHmuxSessionSummary(
        summary({ failure }),
        summary({
          failure: { ...failure, correlationId: "failure_fedcba9876543210" },
        }),
      ),
    ).toBe(false);
    expect(sameHmuxSessionSummary(summary({ failure }), summary())).toBe(false);
  });

  it("retains both publication and withdrawal of socket-owner absence", () => {
    expect(
      sameHmuxSessionSummary(
        summary(),
        summary({ hostSocketOwnerAbsent: true }),
      ),
    ).toBe(false);
    expect(
      sameHmuxSessionSummary(
        summary({ hostSocketOwnerAbsent: true }),
        summary(),
      ),
    ).toBe(false);
    expect(
      sameHmuxSessionSummary(
        summary({ hostSocketOwnerAbsent: true }),
        summary({ hostSocketOwnerAbsent: true }),
      ),
    ).toBe(true);
  });

  it("host 사망 확정(hostProcessAlive)만 바뀐 업데이트를 드랍하지 않는다", () => {
    // 누락 회귀(2026-08-06): 비교에서 빠져 있어 undefined→false 전환이
    // 캐시에서 "동일"로 드랍됐고 사망 표시가 소비자에 전달되지 않았다.
    expect(
      sameHmuxSessionSummary(summary(), summary({ hostProcessAlive: false })),
    ).toBe(false);
    expect(
      sameHmuxSessionSummary(
        summary({ hostProcessAlive: false }),
        summary({ hostProcessAlive: false }),
      ),
    ).toBe(true);
  });

  it("stopFence 세대 변화만 있는 업데이트를 드랍하지 않는다", () => {
    const fence = {
      runnerPrincipal: "runner",
      runnerInstance: "instance-1",
      channelEpoch: "1",
      hostInstanceId: "host-1",
      terminalEpoch: "epoch",
    };
    expect(
      sameHmuxSessionSummary(summary(), summary({ stopFence: fence })),
    ).toBe(false);
    expect(
      sameHmuxSessionSummary(
        summary({ stopFence: fence }),
        summary({ stopFence: { ...fence } }),
      ),
    ).toBe(true);
    expect(
      sameHmuxSessionSummary(
        summary({ stopFence: fence }),
        summary({ stopFence: { ...fence, runnerInstance: "instance-2" } }),
      ),
    ).toBe(false);
    expect(
      sameHmuxSessionSummary(summary({ stopFence: fence }), summary()),
    ).toBe(false);
  });

  it("projects stale-ready diagnostic detail", () => {
    const stale = summary({
      lifecycle: "unavailable",
      manifestLifecycle: "ready",
      health: "stale_transport",
      inputAllowed: false,
      detachOnly: true,
      diagnostic: {
        code: "hmux_stale_transport",
        message: "The bounded handshake failed.",
        retry: "detach_only",
      },
    });

    expect(hmuxSessionDiagnosticDetail(stale)).toBe(
      "stale_transport · hmux_stale_transport · The bounded handshake failed. · detach_only",
    );
  });
});

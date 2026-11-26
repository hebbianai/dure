// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MergedTierReconcileIntent,
  TierReconcileIntent,
} from "@/lib/workspace/performance/tierReconcileScheduler";

vi.mock("@/components/workspace/Workspace", () => ({
  Workspace: ({
    desktopId,
    active,
    frozen,
  }: {
    desktopId: string;
    active: boolean;
    frozen?: boolean;
  }) => (
    <div
      data-testid={`workspace-${desktopId}`}
      data-active={String(active)}
      data-frozen={String(Boolean(frozen))}
    />
  ),
}));

vi.mock("@/lib/workspace/performance/workspaceHardwareProfile", () => ({
  readSystemHardwareProfile: async () => ({
    logicalCores: 16,
    physicalMemoryBytes: 64 * 1024 ** 3,
  }),
  mergeWorkspaceHardwareProfiles: (
    browser: Record<string, unknown>,
    native: Record<string, unknown> | null,
  ) => ({ ...browser, ...native }),
}));

vi.mock("@/lib/workspace/performance/tierReconcileScheduler", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/workspace/performance/tierReconcileScheduler")
  >();
  class ImmediateTierReconcileScheduler {
    constructor(
      private readonly run: (
        intent: MergedTierReconcileIntent,
      ) => void,
    ) {}

    request(intent: TierReconcileIntent) {
      this.run({
        resourceChange: intent.resourceChange ?? false,
        warmCandidates: [...(intent.warmCandidates ?? [])],
        retainCandidates: [...(intent.retainCandidates ?? [])],
        protectedWarmFromCurrent: intent.protectedWarmFromCurrent ?? false,
      });
    }

    dispose() {}
  }
  return {
    ...actual,
    TierReconcileScheduler: ImmediateTierReconcileScheduler,
  };
});

vi.mock("@/lib/workspace/window/windows", () => ({
  DURABLE_STORE_REHYDRATED_EVENT: "dure:test-store-rehydrated",
}));

import { WorkspaceDeck } from "@/components/workspace/WorkspaceDeck";
import { useStore } from "@/store";

const spaces = [
  { id: "active", name: "Active" },
  { id: "neighbor", name: "Neighbor" },
  { id: "far", name: "Far" },
];

describe("WorkspaceDeck speculative prewarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ layouts: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not construct an unseen non-neighbor workspace during idle time", async () => {
    render(<WorkspaceDeck spaces={spaces} activeSpaceId="active" />);

    expect(screen.getByTestId("workspace-active")).toBeTruthy();
    expect(screen.queryByTestId("workspace-far")).toBeNull();

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.queryByTestId("workspace-far")).toBeNull();
  });
});

describe("WorkspaceDeck behind the Work view", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ layouts: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps the active Space mounted and warm, rendered inactive, and never freezes it", async () => {
    const view = render(<WorkspaceDeck spaces={spaces} activeSpaceId="active" />);
    const shell = () => screen.getByTestId("workspace-active");
    expect(shell().dataset.active).toBe("true");

    view.rerender(
      <WorkspaceDeck spaces={spaces} activeSpaceId="active" occluded />,
    );
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(shell().dataset.active).toBe("false");
    expect(shell().dataset.frozen).toBe("false");

    view.rerender(<WorkspaceDeck spaces={spaces} activeSpaceId="active" />);
    expect(shell().dataset.active).toBe("true");
    expect(shell().dataset.frozen).toBe("false");
  });
});

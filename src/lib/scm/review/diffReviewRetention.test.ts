// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startDiffReviewTargetRetention,
  syncCurrentDiffReviewTargets,
} from "@/lib/scm/review/diffReviewRetention";
import { reconcileDiffReviewTargets } from "@/lib/ipc";
import { useStore } from "@/store";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  reconcileDiffReviewTargets: vi.fn().mockResolvedValue({
    activeTargets: 0,
    inactiveTargets: 0,
    deletedTargets: 0,
  }),
}));

const reconcile = vi.mocked(reconcileDiffReviewTargets);
const stops: (() => void)[] = [];

function layout(reviewId: string): unknown {
  return {
    panels: {
      "diff:agent-1": {
        contentComponent: "diff",
        params: { reviewId },
      },
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  reconcile.mockResolvedValue({
    activeTargets: 0,
    inactiveTargets: 0,
    deletedTargets: 0,
  });
  useStore.setState({ layouts: {} });
  syncCurrentDiffReviewTargets();
  await vi.waitFor(() => expect(reconcile).toHaveBeenCalled());
  vi.clearAllMocks();
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  useStore.setState({ layouts: {} });
});

describe("diff review target retention", () => {
  it("publishes current Diff roots from real saved panes across same-slot replacement and restart", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const api = createDockview(element, {
      createComponent: () => ({
        element: document.createElement("div"),
        init() {},
      }),
    });
    api.layout(900, 600);
    stops.push(() => {
      api.dispose();
      element.remove();
    });
    const pane = api.addPanel({
      id: "pane-review",
      component: "diff",
      params: { reviewId: "review-before" },
    });
    const save = () => useStore.setState({ layouts: { space: api.toJSON() } });
    save();
    const stop = startDiffReviewTargetRetention();
    stops.push(stop);
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenLastCalledWith(
        ["review-before"],
        expect.any(Number),
      ),
    );

    const terminal = api.replacePanel(pane.api, {
      component: "terminal",
      params: { reviewId: "review-before" },
    })!;
    expect(terminal.id).toBe(pane.id);
    save();
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenLastCalledWith([], expect.any(Number)),
    );

    const current = api.replacePanel(terminal.api, {
      component: "diff",
      params: { reviewId: "review-after" },
    })!;
    expect(current.id).toBe(pane.id);
    save();
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenLastCalledWith(
        ["review-after"],
        expect.any(Number),
      ),
    );
    stop();
    const saved = api.toJSON();
    api.fromJSON(saved);
    save();
    reconcile.mockClear();
    stops.push(startDiffReviewTargetRetention());
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenLastCalledWith(
        ["review-after"],
        expect.any(Number),
      ),
    );
    expect(api.getPanel(pane.id)?.params).toEqual({ reviewId: "review-after" });
  });

  it("reconciles the complete persisted root set at startup and after layout writes", async () => {
    useStore.setState({ layouts: { first: layout("review-first") } });
    stops.push(startDiffReviewTargetRetention());

    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenLastCalledWith(
        ["review-first"],
        expect.any(Number),
      ),
    );

    useStore.setState({
      layouts: {
        first: layout("review-next"),
        second: layout("review-next"),
      },
    });
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenLastCalledWith(
        ["review-next"],
        expect.any(Number),
      ),
    );
  });

  it("collapses queued changes to the newest complete snapshot", async () => {
    let releaseFirst: (() => void) | undefined;
    reconcile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({
              activeTargets: 0,
              inactiveTargets: 0,
              deletedTargets: 0,
            });
        }),
    );
    stops.push(startDiffReviewTargetRetention());
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    useStore.setState({ layouts: { first: layout("review-stale") } });
    useStore.setState({ layouts: { first: layout("review-current") } });
    releaseFirst?.();

    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenLastCalledWith(
        ["review-current"],
        expect.any(Number),
      ),
    );
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});

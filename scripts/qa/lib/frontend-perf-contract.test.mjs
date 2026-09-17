import { describe, expect, test } from "vitest";
import {
  assertFrontendPerformanceResult,
  formatPageError,
} from "./frontend-perf-contract.mjs";

const completeResult = () => ({
  pageErrorSample: [],
  remountCost: { count: 1 },
  journeys: {
    initialWorkspace: { workspacePaint: { count: 1 } },
    firstVisit: { workspacePaint: { count: 1 } },
    revisit: { workspacePaint: { count: 1 } },
  },
  paneFocus: { paint: { count: 1 } },
});

describe("frontend performance result contract", () => {
  test("preserves an actionable page-error stack", () => {
    const error = new TypeError("panes is not iterable");
    error.stack =
      "TypeError: panes is not iterable\n    at reconcile (http://localhost:1427/src/components/workspace/Workspace.tsx:89:21)";

    expect(formatPageError(error)).toContain(
      "src/components/workspace/Workspace.tsx:89:21",
    );
  });

  test("rejects every unexpected page error", () => {
    expect(() =>
      assertFrontendPerformanceResult({
        ...completeResult(),
        pageErrorSample: [
          "TypeError: panes is not iterable\n    at reconcile (Workspace.tsx:89:21)",
        ],
        remountCost: { count: 1 },
      }),
    ).toThrow(/captured 1 unexpected page error/);
  });

  test("retains the cold-remount evidence gate", () => {
    expect(() =>
      assertFrontendPerformanceResult({
        ...completeResult(),
        remountCost: { count: 0 },
      }),
    ).toThrow(/did not capture a cold remountCost sample/);
  });

  test("requires each workspace journey and pane-focus evidence", () => {
    expect(() =>
      assertFrontendPerformanceResult({
        ...completeResult(),
        journeys: {
          ...completeResult().journeys,
          firstVisit: { workspacePaint: { count: 0 } },
        },
      }),
    ).toThrow(/first visit/);
    expect(() =>
      assertFrontendPerformanceResult({
        ...completeResult(),
        paneFocus: { paint: { count: 0 } },
      }),
    ).toThrow(/pane-focus paint/);
  });

  test("accepts a page-error-free run with cold-remount evidence", () => {
    expect(() => assertFrontendPerformanceResult(completeResult())).not.toThrow();
  });
});

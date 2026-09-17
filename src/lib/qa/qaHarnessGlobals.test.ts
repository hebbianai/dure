import { describe, expect, it } from "vitest";
import { exposeQaHarnessGlobals } from "@/lib/qa/qaHarnessGlobals";

describe("exposeQaHarnessGlobals", () => {
  it("publishes the harness only through canonical Dure globals", () => {
    const target: Record<string, unknown> = {};
    const store = {};
    const dock = {};
    const diffBadges = {};

    exposeQaHarnessGlobals(target, store, dock, diffBadges);

    expect(target.__DURE_STORE__).toBe(store);
    expect(target.__DURE_DOCK__).toBe(dock);
    expect(target.__DURE_DIFF_BADGES__).toBe(diffBadges);
    expect(Object.keys(target).every((key) => !key.includes("HEBBIAN"))).toBe(true);
  });
});

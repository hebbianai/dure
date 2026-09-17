import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_MODEL_BYTES,
  PREWARM_TERMINAL_MODEL_BYTES,
  TERMINAL_MODEL_FALLBACK_BUDGET_BYTES,
} from "./terminalResourceBudget";

describe("terminal resource budget", () => {
  it("admits ordinary surfaces without admitting the thirty-surface incident", () => {
    expect(DEFAULT_TERMINAL_MODEL_BYTES * 13).toBeLessThan(
      TERMINAL_MODEL_FALLBACK_BUDGET_BYTES,
    );
    expect(DEFAULT_TERMINAL_MODEL_BYTES * 30).toBeGreaterThan(
      TERMINAL_MODEL_FALLBACK_BUDGET_BYTES,
    );
  });

  it("bounds speculative surfaces independently from full models", () => {
    expect(PREWARM_TERMINAL_MODEL_BYTES).toBeLessThan(
      DEFAULT_TERMINAL_MODEL_BYTES,
    );
  });
});

import { describe, expect, test } from "vitest";
import {
  DEFAULT_DURATION_MS,
  DEFAULT_ITERATIONS,
  parseArguments,
  RECEIPT_SCHEMA,
} from "./macos-ownership-observer-churn.mjs";

describe("macOS ownership observer churn contract", () => {
  test("defaults to the accepted 60-second 1,000-process workload", () => {
    expect(parseArguments([])).toEqual({
      durationMs: 60_000,
      iterations: 1_000,
    });
    expect(DEFAULT_DURATION_MS).toBe(60_000);
    expect(DEFAULT_ITERATIONS).toBe(1_000);
    expect(RECEIPT_SCHEMA).toBe("dure-macos-ownership-observer-churn/v1");
  });

  test("rejects unbounded churn inputs", () => {
    expect(() => parseArguments(["--duration-ms", "120001"])).toThrow(
      "duration must be between",
    );
    expect(() => parseArguments(["--iterations", "10001"])).toThrow(
      "iterations must be between",
    );
  });
});

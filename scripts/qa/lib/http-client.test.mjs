import { describe, expect, test, vi } from "vitest";
import {
  qaHttpRouteLabel,
  resolveQaHttpTimeout,
  withHttpTimeout,
} from "./http-client.mjs";

describe("QA HTTP timeout", () => {
  test("returns completed operations and clears the timer", async () => {
    vi.useFakeTimers();

    await expect(
      withHttpTimeout("GET /ping", async () => "ok", 100),
    ).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });

  test("aborts and rejects operations that do not settle", async () => {
    vi.useFakeTimers();
    let signal;
    const result = withHttpTimeout(
      "GET /qa/status",
      async (candidate) => {
        signal = candidate;
        return new Promise(() => {});
      },
      250,
    );
    const rejection = expect(result).rejects.toThrow(
      "GET /qa/status timed out after 250ms",
    );

    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });

  test("rejects invalid timeout configuration", () => {
    expect(() => resolveQaHttpTimeout("0")).toThrow(/positive integer/);
    expect(() => resolveQaHttpTimeout("later")).toThrow(/positive integer/);
  });

  test("keeps proof-bearing query strings out of diagnostics", () => {
    expect(
      qaHttpRouteLabel("/qa/hmux/window-focus/status?proof=secret"),
    ).toBe("/qa/hmux/window-focus/status");
  });
});

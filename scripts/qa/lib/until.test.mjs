import { describe, expect, test } from "vitest";
import { until } from "./until.mjs";

describe("until", () => {
  test("returns the first truthy value once the state has been applied", async () => {
    let reads = 0;
    const value = await until(async () => (++reads >= 3 ? { activity: "waiting" } : false),
      "never applied", { intervalMs: 1 });
    expect(value).toEqual({ activity: "waiting" });
    expect(reads).toBe(3);
  });

  test("names what never happened once its time is up", async () => {
    await expect(until(() => false, "The Host did not settle", { timeoutMs: 20, intervalMs: 1 }))
      .rejects.toThrow("The Host did not settle");
  });
});

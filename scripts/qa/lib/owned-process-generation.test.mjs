import { describe, expect, test } from "vitest";
import { runOwnedGenerationSmoke } from "../owned-generation-smoke.mjs";
import { classifyOwnedGeneration } from "./owned-process-generation.mjs";
import { parsePersistedKernelStartMarkerV1 } from "./owned-process-persistence-v1.mjs";

const macos = "kernel-start-v3:macos:11111111-2222-3333-4444-555555555555:123";

describe.each([
  ["macOS", macos, macos],
  ["Linux", "kernel-start-v2:linux:boot-a:42", "linux:boot-a:42"],
])("exact %s generation", (_platform, marker, processIdentity) => {
  const generation = parsePersistedKernelStartMarkerV1(marker);

  test.each(["live", "stopped"])("preserves the canonical %s member", (state) => {
    const member = { pid: 123, processIdentity, state };
    const result = classifyOwnedGeneration(generation, member);
    expect(result.kind).toBe("current");
    expect(result.member).toBe(member);
  });

  test.each([undefined, null, { state: "zombie", processIdentity }])(
    "converges departed observation %j",
    (member) => {
      expect(classifyOwnedGeneration(generation, member)).toEqual({ kind: "departed" });
    },
  );

  test("distinguishes a reused generation at the same PID", () => {
    expect(classifyOwnedGeneration(generation, {
      pid: 123, processIdentity: `${processIdentity}1`, state: "live",
    })).toEqual({ kind: "reused" });
  });
});

test("does not adopt the same Linux PID and ticks from a different boot", () => {
  expect(classifyOwnedGeneration(
    parsePersistedKernelStartMarkerV1("kernel-start-v2:linux:boot-a:42"),
    { pid: 123, processIdentity: "linux:boot-b:42", state: "stopped" },
  )).toEqual({ kind: "reused" });
});

describe("legacy bootless Linux generation", () => {
  const generation = parsePersistedKernelStartMarkerV1("kernel-start-v1:linux:00042");

  test.each(["live", "stopped"])("retains the live authority refusal for %s", (state) => {
    expect(classifyOwnedGeneration(generation, {
      pid: 123, processIdentity: "linux:current-boot:42", state,
    })).toEqual({ kind: "legacy_live" });
  });

  test.each([
    [undefined, "departed"],
    [{ processIdentity: "linux:current-boot:42", state: "zombie" }, "departed"],
    [{ processIdentity: "linux:current-boot:43", state: "live" }, "reused"],
    [{ processIdentity: macos, state: "live" }, "reused"],
  ])("classifies without inventing boot authority: %j", (member, kind) => {
    expect(classifyOwnedGeneration(generation, member)).toEqual({ kind });
  });
});

test.runIf(["darwin", "linux"].includes(process.platform))(
  "freezes and retires a native group after its exact child exits",
  async () => {
    await expect(runOwnedGenerationSmoke()).resolves.toMatchObject({ cleanup: "verified" });
  },
  30_000,
);

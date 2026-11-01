import { describe, expect, it } from "vitest";
import { backendSourceSummary } from "../cli/lib/backend-source.mjs";

// `source.backend` used to be the transport handshake verbatim, including the
// backend's full capability list — about a hundred strings repeated in every
// `--json` receipt. The identity and freshness fields are the contract; the
// list is on request.
describe("backend source summary", () => {
  const handshake = Object.freeze({
    id: "local-backend",
    generation: "local-generation-7",
    protocol: { major: 1, minor: 4 },
    capabilities: Array.from({ length: 100 }, (_, index) => `capability.${index}_v1`),
    observedAtMs: 1_700_000_000_000,
    sourceAgeMs: 12,
  });

  it("keeps identity, protocol and freshness while collapsing the capability list to its size", () => {
    expect(backendSourceSummary(handshake)).toEqual({
      id: "local-backend",
      generation: "local-generation-7",
      protocol: { major: 1, minor: 4 },
      observedAtMs: 1_700_000_000_000,
      sourceAgeMs: 12,
      capabilityCount: 100,
    });
    expect(JSON.stringify(backendSourceSummary(handshake))).not.toContain("capability.0_v1");
  });

  it("includes the full list, as a copy, only when verbose is requested", () => {
    const verbose = backendSourceSummary(handshake, { verbose: true });
    expect(verbose).toMatchObject({ id: "local-backend", capabilityCount: 100 });
    expect(verbose.capabilities).toEqual(handshake.capabilities);
    expect(verbose.capabilities).not.toBe(handshake.capabilities);
    expect(handshake.capabilities).toHaveLength(100);
  });

  it("counts a missing or malformed list as zero rather than inventing one", () => {
    const { capabilities, ...withoutList } = handshake;
    expect(backendSourceSummary(withoutList)).toEqual({ ...withoutList, capabilityCount: 0 });
    expect(backendSourceSummary({ ...withoutList, capabilities: "nope" })).toEqual({ ...withoutList, capabilityCount: 0 });
    expect(backendSourceSummary({ ...withoutList, capabilities: "nope" }, { verbose: true }).capabilities).toEqual([]);
  });

  it("passes a non-object backend through untouched so error shapes stay recognizable", () => {
    expect(backendSourceSummary(undefined)).toBeUndefined();
    expect(backendSourceSummary(null)).toBeNull();
    expect(backendSourceSummary(["x"])).toEqual(["x"]);
  });
});

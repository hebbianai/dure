import { describe, expect, it } from "vitest";
import { paneHealthChip } from "./paneHealthChip";

describe("paneHealthChip", () => {
  it("raises a chip for the two hard problems", () => {
    expect(paneHealthChip("error", undefined)).toBe("connectionError");
    expect(paneHealthChip("stale", undefined)).toBe("notResponding");
  });

  it("raises a transient chip while a session recovers", () => {
    expect(paneHealthChip("recovering", undefined)).toBe("recovering");
    expect(paneHealthChip("recovering", "host_restart")).toBe("recovering");
  });

  it("keeps renderer catch-up out of pane chrome", () => {
    expect(paneHealthChip("recovering", "render_backlog")).toBeNull();
  });

  it("shows nothing for the healthy and first-attach states", () => {
    expect(paneHealthChip("live", undefined)).toBeNull();
    expect(paneHealthChip("connecting", undefined)).toBeNull();
    expect(paneHealthChip(undefined, undefined)).toBeNull();
  });
});

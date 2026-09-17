import { describe, expect, it, vi } from "vitest";
import {
  fileMatchesDeletion,
  publishFileDeletion,
  subscribeFileDeletion,
} from "@/lib/files/fileDeletionEvents";

describe("fileDeletionEvents", () => {
  it("matches only the exact host and path boundary", () => {
    const deletion = {
      source: "ssh" as const,
      hostId: "one",
      path: "/repo/dir",
      isDirectory: true,
    };
    expect(
      fileMatchesDeletion({ source: "ssh", hostId: "one", path: "/repo/dir/a.ts" }, deletion),
    ).toBe(true);
    expect(
      fileMatchesDeletion({ source: "ssh", hostId: "one", path: "/repo/directory.ts" }, deletion),
    ).toBe(false);
    expect(
      fileMatchesDeletion({ source: "ssh", hostId: "two", path: "/repo/dir/a.ts" }, deletion),
    ).toBe(false);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFileDeletion(listener);
    const notice = { source: "ssh" as const, hostId: "one", path: "/x", isDirectory: false };
    publishFileDeletion(notice);
    unsubscribe();
    publishFileDeletion(notice);
    expect(listener).toHaveBeenCalledOnce();
  });
});

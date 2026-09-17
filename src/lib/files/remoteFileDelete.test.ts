import { describe, expect, it } from "vitest";
import { deletedRemoteDraftKeys } from "@/lib/files/remoteFileDelete";

describe("deletedRemoteDraftKeys", () => {
  const keys = [
    "ssh:one:/repo/file.ts",
    "ssh:one:/repo/dir/a.ts",
    "ssh:one:/repo/dir/nested/b.ts",
    "ssh:one:/repo/directory.ts",
    "ssh:two:/repo/dir/a.ts",
    "local::/repo/dir/a.ts",
  ];

  it("clears only the exact remote file draft", () => {
    expect(
      deletedRemoteDraftKeys({
        keys,
        hostId: "one",
        path: "/repo/file.ts",
        isDirectory: false,
      }),
    ).toEqual(["ssh:one:/repo/file.ts"]);
  });

  it("clears directory descendants without matching a shared prefix", () => {
    expect(
      deletedRemoteDraftKeys({
        keys,
        hostId: "one",
        path: "/repo/dir",
        isDirectory: true,
      }),
    ).toEqual([
      "ssh:one:/repo/dir/a.ts",
      "ssh:one:/repo/dir/nested/b.ts",
    ]);
  });
});

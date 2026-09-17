import { describe, expect, it } from "vitest";
import { fileTreeContextActions } from "@/lib/files/fileTreeContextActions";

describe("fileTreeContextActions", () => {
  it("opens local directories in a new file-manager window", () => {
    expect(
      fileTreeContextActions({ source: "local", isDirectory: true, platform: "linux" }),
    ).toEqual(["open-directory-window", "share"]);
  });

  it("adds Finder reveal only on macOS", () => {
    expect(
      fileTreeContextActions({ source: "local", isDirectory: false, platform: "macos" }),
    ).toEqual(["reveal-in-finder", "share"]);
    expect(
      fileTreeContextActions({ source: "local", isDirectory: false, platform: "windows" }),
    ).toEqual(["share"]);
  });

  it("offers only permanent deletion for SSH paths", () => {
    expect(
      fileTreeContextActions({ source: "ssh", isDirectory: true, platform: "macos" }),
    ).toEqual(["delete-permanently"]);
  });
});

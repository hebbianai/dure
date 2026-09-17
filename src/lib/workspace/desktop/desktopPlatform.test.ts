import { describe, expect, it } from "vitest";
import { detectDesktopPlatform, isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";

describe("desktop platform detection", () => {
  it("recognizes the native desktop platform identities used by WebKit", () => {
    expect(detectDesktopPlatform("MacIntel Mozilla/5.0 (Macintosh)")).toBe("macos");
    expect(detectDesktopPlatform("Linux x86_64 Mozilla/5.0 (X11; Linux x86_64)")).toBe(
      "linux",
    );
    expect(detectDesktopPlatform("Win32 Mozilla/5.0 (Windows NT 10.0)")).toBe(
      "windows",
    );
  });

  it("does not expose macOS-only surfaces on Linux or unknown platforms", () => {
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("")).toBe(false);
    expect(isMacPlatform("MacIntel")).toBe(true);
  });
});

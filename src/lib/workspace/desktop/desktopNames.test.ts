import { describe, expect, it } from "vitest";
import { migrateLegacyDesktopName, nextSpaceName } from "@/lib/workspace/desktop/desktopNames";

describe("desktop names", () => {
  it("migrates only legacy generated names", () => {
    expect(migrateLegacyDesktopName("Desktop 1")).toBe("Main");
    expect(migrateLegacyDesktopName("Desktop 2")).toBe("Workspace");
    expect(migrateLegacyDesktopName("Desktop 4")).toBe("Workspace 3");
    expect(migrateLegacyDesktopName("Desktop planning")).toBe("Desktop planning");
  });

  it("fills the first available workspace name without a leading number", () => {
    expect(nextSpaceName([{ name: "Main" }])).toBe("Workspace");
    expect(nextSpaceName([{ name: "Workspace" }])).toBe("Workspace 2");
    expect(
      nextSpaceName([
        { name: "Workspace" },
        { name: "Workspace 2" },
        { name: "Workspace 4" },
      ]),
    ).toBe("Workspace 3");
  });
});

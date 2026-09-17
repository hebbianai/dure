import { describe, expect, it } from "vitest";
import { configuredFrontendAppChannel } from "@/lib/platform/appChannel";

describe("configuredFrontendAppChannel", () => {
  it("prefers the Dure channel and accepts the legacy name only as fallback", () => {
    expect(
      configuredFrontendAppChannel({
        VITE_DURE_APP_CHANNEL: "dev-canonical-a1b2c3d4",
        VITE_HEBBIAN_APP_CHANNEL: "dev-legacy-decoy-a1b2c3d4",
      }),
    ).toBe("dev-canonical-a1b2c3d4");
    expect(
      configuredFrontendAppChannel({
        VITE_HEBBIAN_APP_CHANNEL: "dev-legacy-a1b2c3d4",
      }),
    ).toBe("dev-legacy-a1b2c3d4");
    expect(
      configuredFrontendAppChannel({
        VITE_DURE_APP_CHANNEL: "",
        VITE_HEBBIAN_APP_CHANNEL: "dev-legacy-a1b2c3d4",
      }),
    ).toBe("");
  });
});

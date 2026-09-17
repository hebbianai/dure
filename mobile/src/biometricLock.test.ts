import { describe, expect, it, vi } from "vitest";
import { type BiometricBridge, confirmOwner, probeBiometry } from "./biometricLock";

function bridge(overrides: Partial<BiometricBridge> = {}): BiometricBridge {
  return {
    checkStatus: () => Promise.resolve({ isAvailable: true, biometryType: 2 }),
    authenticate: () => Promise.resolve(),
    ...overrides,
  };
}

describe("probeBiometry", () => {
  it("reads Face ID from biometryType 2", async () => {
    expect(await probeBiometry(bridge())).toBe("face");
  });

  it("reads a fingerprint or iris as touch", async () => {
    expect(
      await probeBiometry(
        bridge({ checkStatus: () => Promise.resolve({ isAvailable: true, biometryType: 1 }) }),
      ),
    ).toBe("touch");
    expect(
      await probeBiometry(
        bridge({ checkStatus: () => Promise.resolve({ isAvailable: true, biometryType: 3 }) }),
      ),
    ).toBe("touch");
  });

  it("is unavailable when the device says so, whatever the type", async () => {
    expect(
      await probeBiometry(
        bridge({ checkStatus: () => Promise.resolve({ isAvailable: false, biometryType: 2 }) }),
      ),
    ).toBe("unavailable");
    expect(
      await probeBiometry(
        bridge({ checkStatus: () => Promise.resolve({ isAvailable: true, biometryType: 0 }) }),
      ),
    ).toBe("unavailable");
  });

  it("is unavailable when the plugin is missing, without throwing", async () => {
    expect(
      await probeBiometry(
        bridge({ checkStatus: () => Promise.reject(new Error("plugin biometric not found")) }),
      ),
    ).toBe("unavailable");
  });
});

describe("confirmOwner", () => {
  it("passes when the prompt resolves, asking with the reason and a passcode fallback", async () => {
    const authenticate = vi.fn<BiometricBridge["authenticate"]>(() => Promise.resolve());
    expect(await confirmOwner(bridge({ authenticate }), "왜")).toBe("passed");
    expect(authenticate).toHaveBeenCalledWith(
      "왜",
      expect.objectContaining({ allowDeviceCredential: true }),
    );
  });

  it("is cancelled when the person dismissed the sheet", async () => {
    expect(
      await confirmOwner(bridge({ authenticate: () => Promise.reject("userCancel") }), "왜"),
    ).toBe("cancelled");
    expect(
      await confirmOwner(
        bridge({ authenticate: () => Promise.reject(new Error("Authentication canceled")) }),
        "왜",
      ),
    ).toBe("cancelled");
  });

  it("is unavailable when the plugin or its command is missing", async () => {
    expect(
      await confirmOwner(
        bridge({ authenticate: () => Promise.reject(new Error("plugin biometric not found")) }),
        "왜",
      ),
    ).toBe("unavailable");
    expect(
      await confirmOwner(
        bridge({
          authenticate: () =>
            Promise.reject("Command plugin:biometric|authenticate not found"),
        }),
        "왜",
      ),
    ).toBe("unavailable");
  });

  it("fails on any other refusal", async () => {
    expect(
      await confirmOwner(
        bridge({ authenticate: () => Promise.reject(new Error("authenticationFailed")) }),
        "왜",
      ),
    ).toBe("failed");
  });
});

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runCheckoutLifecycleSshSmoke } from "./checkout-lifecycle-ssh-smoke.mjs";

const adapters = vi.hoisted(() => ({ build: vi.fn(), run: vi.fn() }));
vi.mock("./managed-provider-fixture.mjs", () => ({
  cargoArtifact: adapters.build,
  run: adapters.run,
}));

beforeEach(() => {
  vi.resetAllMocks();
  adapters.build.mockResolvedValue("/fixture/current-tauri-tests");
  adapters.run.mockResolvedValue("native SSH evidence\n");
});
afterEach(() => vi.unstubAllEnvs());

test("builds the exact Tauri library and supplies it to the existing owned SSH fixture", async () => {
  vi.stubEnv("DURE_QA_CHECKOUT_TAURI_TEST_BINARY", "/stale/tauri-tests");
  vi.stubEnv("HMUX_DISCOVERY_ROOT", "/fixture/guardian-discovery");
  expect(await runCheckoutLifecycleSshSmoke()).toBe("native SSH evidence\n");
  expect(adapters.build).toHaveBeenCalledExactlyOnceWith([
    "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--no-run",
  ], "agent_ide_lib", { kind: "qa" });
  expect(adapters.run).toHaveBeenCalledExactlyOnceWith(process.execPath,
    ["scripts/qa/checkout-registration-ssh-smoke.mjs"], {
      env: expect.objectContaining({
        DURE_QA_CHECKOUT_TAURI_TEST_BINARY: "/fixture/current-tauri-tests",
        HMUX_DISCOVERY_ROOT: "/fixture/guardian-discovery",
      }),
    });
});

test("does not launch a VM when compilation fails", async () => {
  const failure = new Error("Cargo failed");
  adapters.build.mockRejectedValue(failure);
  await expect(runCheckoutLifecycleSshSmoke()).rejects.toBe(failure);
  expect(adapters.run).not.toHaveBeenCalled();
});

test("preserves a failed native result without rebuilding or retrying", async () => {
  const failure = new Error("native SSH lifecycle failed");
  adapters.run.mockRejectedValue(failure);
  await expect(runCheckoutLifecycleSshSmoke()).rejects.toBe(failure);
  expect(adapters.build).toHaveBeenCalledTimes(1);
  expect(adapters.run).toHaveBeenCalledTimes(1);
});

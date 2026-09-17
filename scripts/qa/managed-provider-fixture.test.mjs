import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { cargoArtifact, cargoArtifacts } from "./managed-provider-fixture.mjs";

const child = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: child.spawn }));
afterEach(() => vi.resetAllMocks());

function compilerOutput(status = 0) {
  child.spawn.mockImplementation(() => {
    const process = new EventEmitter();
    process.stdout = new PassThrough();
    queueMicrotask(() => {
      process.stdout.end([
        "non-JSON diagnostic",
        JSON.stringify({ reason: "compiler-artifact", target: { name: "hmux-runtime" }, executable: "/fixture/runtime" }),
        JSON.stringify({ reason: "compiler-artifact", target: { name: "managed_smoke" }, executable: "/fixture/test" }),
        JSON.stringify({ reason: "compiler-artifact", target: { name: "dependency" }, executable: null }),
        JSON.stringify({ reason: "build-finished", success: status === 0 }),
      ].join("\n"));
      process.emit("close", status);
    });
    return process;
  });
}

test("keeps the existing single-artifact callers and their storage class", async () => {
  compilerOutput();
  expect(await cargoArtifact(["test", "--no-run"], "managed_smoke")).toBe("/fixture/test");
  expect(child.spawn.mock.calls[0][1]).toEqual([
    "scripts/run-with-build-storage.mjs", "cli", "--", "cargo", "test", "--no-run", "--message-format=json",
  ]);
});

test("returns all executable artifacts from one admitted QA preparation", async () => {
  compilerOutput();
  expect((await cargoArtifacts(["test", "--no-run"], { kind: "qa" })).map((entry) => entry.executable))
    .toEqual(["/fixture/runtime", "/fixture/test"]);
  expect(child.spawn.mock.calls[0][1][1]).toBe("qa");
  expect(child.spawn).toHaveBeenCalledTimes(1);
});

test("does not return a partial executable after failed compilation", async () => {
  compilerOutput(101);
  await expect(cargoArtifacts(["test", "--no-run"])).rejects.toThrow("failed");
});

test("does not substitute a different executable when Cargo omits the target", async () => {
  compilerOutput();
  await expect(cargoArtifact(["test", "--no-run"], "absent")).rejects.toThrow("Cargo did not publish absent");
});

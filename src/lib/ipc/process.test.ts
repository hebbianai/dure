import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { runShell } from "./process";

it("forwards the native command and preserves its exit result and rejection", async () => {
  const result = { stdout: "", stderr: "permission denied", code: 2 };
  vi.mocked(invoke).mockResolvedValueOnce(result);
  expect(await runShell("cat 'file name' ")).toBe(result);
  expect(invoke).toHaveBeenCalledWith("run_shell", { cmd: "cat 'file name' " });
  const failure = new Error("transport closed");
  vi.mocked(invoke).mockRejectedValueOnce(failure);
  await expect(runShell("next")).rejects.toBe(failure);
});

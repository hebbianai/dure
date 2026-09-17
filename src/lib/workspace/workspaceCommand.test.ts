import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({ hostToOpts: vi.fn((host) => ({ host: host.host })), sshExecOnce: vi.fn() }));
vi.mock("@/lib/ipc/process", () => ({ runShell: vi.fn() }));
import { sshExecOnce } from "@/lib/ipc";
import { runShell } from "@/lib/ipc/process";
import { useStore } from "@/store";
import { runWorkspaceCommand } from "./workspaceCommand";

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ sshHosts: [] });
});

describe("workspace command routing", () => {
  it("preserves local exit information for the caller's policy", async () => {
    const result = { stdout: "no matches", stderr: "", code: 1 };
    vi.mocked(runShell).mockResolvedValue(result);
    expect(await runWorkspaceCommand({ source: "local" }, "grep needle")).toBe(result);
    expect(runShell).toHaveBeenCalledWith("grep needle");
    expect(sshExecOnce).not.toHaveBeenCalled();
  });

  it("resolves the latest host configuration at each submission", async () => {
    const host = { id: "remote", name: "Remote", host: "old.example", user: "test", port: 22, auth: "auto" as const };
    useStore.setState({ sshHosts: [host] });
    await runWorkspaceCommand({ source: "ssh", hostId: host.id }, "find .");
    useStore.setState({ sshHosts: [{ ...host, host: "new.example" }] });
    await runWorkspaceCommand({ source: "ssh", hostId: host.id }, "grep needle");
    expect(sshExecOnce).toHaveBeenNthCalledWith(1, { host: "old.example" }, "find .");
    expect(sshExecOnce).toHaveBeenNthCalledWith(2, { host: "new.example" }, "grep needle");
    expect(runShell).not.toHaveBeenCalled();
  });

  it("rejects missing remote identity without falling back to local execution", async () => {
    await expect(runWorkspaceCommand({ source: "ssh" }, "touch file")).rejects.toThrow();
    await expect(runWorkspaceCommand({ source: "ssh", hostId: "removed" }, "touch file")).rejects.toThrow();
    expect(runShell).not.toHaveBeenCalled();
    expect(sshExecOnce).not.toHaveBeenCalled();
  });

  it("propagates transport failure without retrying a command", async () => {
    const error = new Error("unavailable");
    vi.mocked(runShell).mockRejectedValue(error);
    await expect(runWorkspaceCommand({ source: "local" }, "touch file")).rejects.toBe(error);
    expect(runShell).toHaveBeenCalledTimes(1);
  });
});

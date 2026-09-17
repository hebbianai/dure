import { describe, expect, it, vi } from "vitest";
import type { ExecResult } from "@/lib/ipc/hmuxContracts";
import { createWorkspaceSearchController } from "./workspaceSearchController";

const input = { query: "needle", caseSensitive: false, wholeWord: true, includeGlob: "*.ts", excludeGlob: "vendor" };
const target = { cwd: "/repo", source: "ssh" as const, hostId: "remote" };
const matches = { stdout: "./src/file.ts:2:needle\n", stderr: "", code: 0 };
function deferred() {
  let resolve!: (value: ExecResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ExecResult>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("workspace search observation", () => {
  it.each(["success", "failure"])("keeps newer results after a late %s", async (outcome) => {
    const old = deferred();
    const execute = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(matches);
    const search = createWorkspaceSearchController(target, execute);
    const first = search.search({ ...input, query: "old" });
    await search.search(input);
    if (outcome === "success") old.resolve({ ...matches, stdout: "./obsolete.ts:1:old\n" });
    else old.reject(new Error("old transport"));
    await first;
    expect(search.getSnapshot().snapshot?.result.groups[0].file).toBe("src/file.ts");
    expect(search.getSnapshot().error).toBeNull();
  });

  it("keeps no-match, truncated and command-error outcomes distinct", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ stdout: "", stderr: "", code: 1 })
      .mockResolvedValueOnce({ ...matches, stdout: Array(501).fill("./src/file.ts:2:needle").join("\n") })
      .mockResolvedValueOnce({ stdout: "", stderr: " denied \n", code: 2 });
    const search = createWorkspaceSearchController(target, execute);
    await search.search(input);
    expect(search.getSnapshot().snapshot?.result).toEqual({ groups: [], truncated: false });
    await search.search(input);
    expect(search.getSnapshot().snapshot?.result.truncated).toBe(true);
    expect(search.getSnapshot().snapshot?.result.groups[0].matches).toHaveLength(500);
    await search.search(input);
    expect(search.getSnapshot()).toMatchObject({ phase: "idle", snapshot: null, error: "denied" });
  });

  it("uses captured options and files for replacement and its refresh, and admits it once", async () => {
    const pending = deferred();
    const execute = vi.fn().mockResolvedValueOnce(matches).mockReturnValueOnce(pending.promise).mockResolvedValue({ ...matches, stdout: "" });
    const search = createWorkspaceSearchController(target, execute);
    await search.search(input);
    const snapshot = search.getSnapshot().snapshot!;
    const request = { snapshot, replacement: "new", preserveCase: false };
    const replace = search.replace(request);
    await search.replace(request);
    await search.search({ ...input, query: "other" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]).toEqual([target, expect.stringContaining("'./src/file.ts'")]);
    expect(execute.mock.calls[1][1]).toContain("s{\\bneedle\\b}{new}gi");
    pending.resolve({ ...matches, stdout: "" });
    await replace;
    expect(execute.mock.calls[2]).toEqual(execute.mock.calls[0]);
    expect(search.getSnapshot()).toMatchObject({ phase: "idle", replacedFiles: 1 });
    await search.replace(request);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("clear invalidates replacement completion and prevents refresh or duplicate mutation", async () => {
    const pending = deferred();
    const execute = vi.fn().mockResolvedValueOnce(matches).mockReturnValueOnce(pending.promise);
    const search = createWorkspaceSearchController(target, execute);
    await search.search(input);
    const request = { snapshot: search.getSnapshot().snapshot!, replacement: "new", preserveCase: false };
    const replacing = search.replace(request);
    search.clear();
    await search.replace(request);
    pending.resolve(matches);
    await replacing;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(search.getSnapshot()).toMatchObject({ phase: "idle", snapshot: null, replacedFiles: null });
  });

  it("reports replacement failures and preserves an explicit confirmed retry", async () => {
    const execute = vi.fn().mockResolvedValueOnce(matches).mockResolvedValueOnce({ stdout: "", stderr: "read only", code: 1 }).mockResolvedValue(matches);
    const search = createWorkspaceSearchController(target, execute);
    await search.search(input);
    await search.replace({ snapshot: search.getSnapshot().snapshot!, replacement: "new", preserveCase: false });
    expect(search.getSnapshot()).toMatchObject({ phase: "idle", error: "read only", replacedFiles: null });
    expect(execute).toHaveBeenCalledTimes(2);
    await search.replace({ snapshot: search.getSnapshot().snapshot!, replacement: "new", preserveCase: false });
    expect(search.getSnapshot()).toMatchObject({ phase: "idle", error: null, replacedFiles: 1 });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("stops notifying after observation disposal and can be used after effect replay", async () => {
    const pending = deferred();
    const execute = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(matches);
    const search = createWorkspaceSearchController(target, execute);
    const listener = vi.fn();
    const release = search.subscribe(listener);
    const work = search.search(input);
    search.clear();
    release();
    listener.mockClear();
    pending.resolve(matches);
    await work;
    expect(listener).not.toHaveBeenCalled();
    expect(search.getSnapshot().snapshot).toBeNull();
    await search.search(input);
    expect(search.getSnapshot().snapshot?.input.query).toBe("needle");
  });
});

it("does not let an older export error interrupt a new search", async () => {
  const pending = deferred();
  const execute = vi.fn().mockResolvedValueOnce(matches).mockReturnValueOnce(pending.promise);
  const search = createWorkspaceSearchController(target, execute);
  await search.search(input);
  const snapshot = search.getSnapshot().snapshot!;
  const next = search.search({ ...input, query: "next" });
  search.reportError(snapshot, new Error("old export failed"));
  expect(search.getSnapshot()).toMatchObject({ phase: "searching", error: null });
  pending.resolve(matches);
  await next;
});

import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/ipc", () => ({ listDir: vi.fn(), listRemoteDir: vi.fn() }));
import { listDir, listRemoteDir } from "@/lib/ipc";
import { useStore } from "@/store";
import { loadDirectory } from "./directoryListing";

afterEach(() => vi.resetAllMocks());
it("keeps local ignore filtering separate from remote listing semantics", async () => {
  const entries = [{ name: "ignored", path: "/repo/ignored", isDir: false, isRepo: false, ignored: true }];
  vi.mocked(listDir).mockResolvedValue(entries);
  vi.mocked(listRemoteDir).mockResolvedValue(entries);
  useStore.setState({ sshHosts: [{ id: "host", name: "Host", host: "example", user: "test", port: 22, auth: "auto" }] });
  expect(await loadDirectory({ path: "/repo", source: "local", showGitIgnored: false })).toEqual([]);
  expect(listDir).toHaveBeenCalledWith("/repo", true, true);
  expect(await loadDirectory({ path: "/repo", source: "ssh", hostId: "host", showGitIgnored: false })).toBe(entries);
});

it("retains the shared SSH concurrency bound and releases slots on failure", async () => {
  useStore.setState({ sshHosts: [{ id: "host", name: "Host", host: "example", user: "test", port: 22, auth: "auto" }] });
  const pending: Array<{ resolve: () => void; reject: () => void }> = [];
  vi.mocked(listRemoteDir).mockImplementation(() => new Promise((resolve, reject) => {
    pending.push({ resolve: () => resolve([]), reject: () => reject(new Error("disconnected")) });
  }));
  const reads = Array.from({ length: 6 }, (_, i) => loadDirectory({ path: `/repo/${i}`, source: "ssh", hostId: "host", showGitIgnored: true }));
  const results = Promise.allSettled(reads);
  expect(pending).toHaveLength(4);
  pending[0].reject();
  pending[1].resolve();
  await vi.waitFor(() => expect(pending).toHaveLength(6));
  for (const read of pending.slice(2)) read.resolve();
  expect((await results).map((result) => result.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
});

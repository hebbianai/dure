import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/ipc", () => ({ readFile: vi.fn(), sshReadFile: vi.fn(), writeFile: vi.fn(), sshWriteFile: vi.fn(), findFileCandidates: vi.fn(), sshFindFileCandidates: vi.fn(), hostToOpts: vi.fn((host) => ({ host: host.host })) }));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }));
import { readFile, writeFile, findFileCandidates, sshReadFile, sshWriteFile, sshFindFileCandidates } from "@/lib/ipc";
import { useStore } from "@/store";
import { fileDocumentIO } from "./fileDocumentIO";
import { fileDraftKey } from "./fileTarget";

afterEach(() => vi.clearAllMocks());
it("routes local reads, candidate search and writes without altering path or content", async () => {
  const target = { source: "local" as const, path: "/a path/name:with colon" };
  await fileDocumentIO.read(target);
  await fileDocumentIO.findCandidates(target);
  await fileDocumentIO.write(target, "unchanged\nbytes");
  expect(readFile).toHaveBeenCalledWith(target.path);
  expect(findFileCandidates).toHaveBeenCalledWith(target.path);
  expect(writeFile).toHaveBeenCalledWith(target.path, "unchanged\nbytes");
  expect(sshReadFile).not.toHaveBeenCalled();
});

it("retains session-only SSH routing and resolves edited hosts at each submission", async () => {
  useStore.setState({ sshHosts: [], fileDrafts: {} });
  const target = { source: "ssh" as const, path: "/repo/file", hostId: "remote", sessionId: "session" };
  await fileDocumentIO.read(target);
  expect(sshReadFile).toHaveBeenCalledWith({ id: "session", connectOpts: undefined, path: target.path });
  useStore.setState({ sshHosts: [{ id: "remote", name: "Remote", host: "current", user: "dev", port: 22, auth: "auto" }] });
  await fileDocumentIO.findCandidates(target);
  await fileDocumentIO.write(target, "new");
  expect(sshFindFileCandidates).toHaveBeenCalledWith({ id: "session", connectOpts: { host: "current" }, path: target.path });
  expect(sshWriteFile).toHaveBeenCalledWith({ id: "session", connectOpts: { host: "current" }, path: target.path, content: "new" });
  const key = fileDraftKey(target);
  expect(fileDraftKey({ ...target, sessionId: "reconnected" })).toBe(key);
  fileDocumentIO.writeDraft(key, "retained");
  expect(fileDocumentIO.readDraft(key)).toBe("retained");
  fileDocumentIO.writeDraft(key, null);
  expect(fileDocumentIO.readDraft(key)).toBeUndefined();
  expect(writeFile).not.toHaveBeenCalled();
});

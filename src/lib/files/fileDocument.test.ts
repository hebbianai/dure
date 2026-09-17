import { afterEach, expect, it, vi } from "vitest";
import type { FileContent } from "@/lib/ipc/files";
import { createFileDocument, type FileDocumentIO } from "./fileDocument";

const target = { path: "/repo/file.txt", source: "local" as const };
const file: FileContent = { ...target, name: "file.txt", kind: "text", content: "disk", size: 4, truncated: false };
function setup() {
  const drafts = new Map<string, string>();
  const io: FileDocumentIO = {
    read: vi.fn(async () => file), findCandidates: vi.fn(async () => []), write: vi.fn(async () => 4),
    readDraft: (key) => drafts.get(key),
    writeDraft: (key, value) => { if (value === null) drafts.delete(key); else drafts.set(key, value); },
    notify: vi.fn(),
  };
  return { io, drafts, document: createFileDocument(target, io) };
}
afterEach(() => vi.useRealTimers());

it("resolves a unique candidate once and preserves the selected path for reads and writes", async () => {
  const { io, document } = setup();
  vi.mocked(io.read).mockRejectedValueOnce(new Error("missing"));
  vi.mocked(io.findCandidates).mockResolvedValueOnce(["/repo/nested/file.txt"]);
  await document.load();
  document.change("new");
  await document.save();
  expect(io.read).toHaveBeenLastCalledWith({ ...target, path: "/repo/nested/file.txt" });
  expect(io.write).toHaveBeenCalledWith({ ...target, path: "/repo/nested/file.txt" }, "new");
  expect(io.findCandidates).toHaveBeenCalledTimes(1);
});

it("shows multiple candidates and keeps a failed candidate lookup from hiding the read error", async () => {
  const { io, document } = setup();
  vi.mocked(io.read).mockRejectedValue(new Error("denied"));
  vi.mocked(io.findCandidates).mockResolvedValueOnce(["/one", "/two"]).mockRejectedValue(new Error("lookup denied"));
  await document.load();
  expect(document.getSnapshot()).toMatchObject({ candidates: ["/one", "/two"], loading: false, error: null });
  await document.load("/two");
  expect(document.getSnapshot()).toMatchObject({ path: "/two", loading: false, error: "Error: denied" });
});

it("refresh waits for the submitted write before reading and discarding the draft", async () => {
  const { io, document, drafts } = setup();
  let finish!: (bytes: number) => void;
  vi.mocked(io.write).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await document.load();
  document.change("saved");
  const save = document.save();
  document.change("discard me");
  const reload = document.load(target.path, true);
  expect(io.read).toHaveBeenCalledTimes(1);
  vi.mocked(io.read).mockResolvedValue({ ...file, content: "saved" });
  finish(5);
  await Promise.all([save, reload]);
  expect(document.getSnapshot()).toMatchObject({ draft: null, file: { content: "saved" }, saving: false });
  expect(drafts.size).toBe(0);
});

it("debounces edits, changes delay without flushing, and suppresses unchanged failed autosaves", async () => {
  vi.useFakeTimers();
  const { io, document } = setup();
  await document.load();
  document.configureAutoSave(true, 500);
  document.change("first");
  await vi.advanceTimersByTimeAsync(400);
  document.change("second");
  document.configureAutoSave(true, 200);
  await vi.advanceTimersByTimeAsync(199);
  expect(io.write).not.toHaveBeenCalled();
  vi.mocked(io.write).mockRejectedValueOnce(new Error("read only"));
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(io.write).toHaveBeenCalledTimes(1);
  expect(document.getSnapshot().draft).toBe("second");
  await document.save();
  expect(io.write).toHaveBeenCalledTimes(2);
  expect(document.getSnapshot().draft).toBeNull();
  document.detach();
});

it("retains a closed draft across an abandoned read and never autosaves truncated content", async () => {
  const { io, document, drafts } = setup();
  drafts.set("local::/repo/file.txt", "retained");
  let finish!: (file: FileContent) => void;
  vi.mocked(io.read).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const read = document.load();
  await Promise.resolve();
  document.detach();
  finish(file);
  await read;
  expect(drafts.get("local::/repo/file.txt")).toBe("retained");
  vi.mocked(io.read).mockResolvedValue({ ...file, truncated: true });
  await document.load();
  document.change("partial");
  await document.save();
  expect(io.write).not.toHaveBeenCalled();
  await document.detach();
  expect(drafts.get("local::/repo/file.txt")).toBe("retained");
});

it("can retry a synchronous adapter failure without retaining a completed write as in-flight", async () => {
  const { io, document } = setup();
  await document.load();
  document.change("new");
  vi.mocked(io.write).mockImplementationOnce(() => { throw new Error("adapter failed before submission"); });
  await document.save();
  await document.save();
  expect(io.write).toHaveBeenCalledTimes(2);
  expect(document.getSnapshot()).toMatchObject({ draft: null, saving: false });
});

it("does not retry unchanged failed autosave content just because the pane closes", async () => {
  vi.useFakeTimers();
  const { io, document, drafts } = setup();
  await document.load();
  document.configureAutoSave(true, 200);
  vi.mocked(io.write).mockRejectedValue(new Error("read only"));
  document.change("retain after failure");
  await vi.advanceTimersByTimeAsync(200);
  await document.detach();
  expect(io.write).toHaveBeenCalledTimes(1);
  expect(drafts.get("local::/repo/file.txt")).toBe("retain after failure");
});

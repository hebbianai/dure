// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hostToOpts: vi.fn(() => ({ host: "example.com", user: "dev" })),
  sshReadFile: vi.fn(),
  sshWriteFile: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  findFileCandidates: vi.fn(async () => []),
  hostToOpts: mocks.hostToOpts,
  readFile: vi.fn(),
  sshFindFileCandidates: vi.fn(async () => []),
  sshReadFile: mocks.sshReadFile,
  sshWriteFile: mocks.sshWriteFile,
  writeFile: vi.fn(),
}));
vi.mock("@/components/editor/LazyCodeEditor", () => ({
  LazyCodeEditor: (props: {
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
  }) => (
    <textarea
      aria-label="code editor"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          props.onSave();
        }
      }}
    />
  ),
}));
vi.mock("@/lib/workspace/performance/workspacePerformance", () => ({
  workspacePerformance: { beginPaneOpen: vi.fn(), markPaneReady: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));
vi.mock("@/lib/toast", () => ({ showErrorToast: vi.fn(), showToast: vi.fn() }));

import {
  FileViewerPanel,
  type FileViewerParams,
} from "@/components/files/FileViewerPanel";
import { useStore } from "@/store";
import type { SshHostConfig } from "@/types";
import { readFile, writeFile, findFileCandidates, type FileContent } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { publishFileDeletion } from "@/lib/files/fileDeletionEvents";

function panelProps(params: FileViewerParams): IDockviewPanelProps<FileViewerParams> {
  return {
    params,
    api: { id: "file:ssh", setTitle: vi.fn() },
  } as unknown as IDockviewPanelProps<FileViewerParams>;
}

beforeEach(() => {
  vi.clearAllMocks();
  const host: SshHostConfig = {
    id: "ssh-1",
    name: "remote",
    host: "example.com",
    port: 22,
    user: "dev",
    auth: "auto",
  };
  useStore.setState((state) => ({ sshHosts: [host], fileDrafts: {}, uiPrefs: { ...state.uiPrefs, autoSaveFiles: false } }));
  mocks.sshReadFile.mockResolvedValue({
    name: "notes.txt",
    path: "/srv/repo/notes.txt",
    kind: "text",
    content: "before",
    size: 6,
    truncated: false,
  });
  mocks.sshWriteFile.mockResolvedValue(5);
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("FileViewerPanel SSH editing", () => {
  it("edits and saves through host options without a live SSH terminal", async () => {
    render(
      <FileViewerPanel
        {...panelProps({
          path: "/srv/repo/notes.txt",
          source: "ssh",
          hostId: "ssh-1",
        })}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "code editor" });
    expect((editor as HTMLTextAreaElement).value).toBe("before");
    fireEvent.change(editor, { target: { value: "after" } });
    fireEvent.click(await screen.findByText("저장"));

    await waitFor(() =>
      expect(mocks.sshWriteFile).toHaveBeenCalledWith({
        id: undefined,
        connectOpts: { host: "example.com", user: "dev" },
        path: "/srv/repo/notes.txt",
        content: "after",
      }),
    );
    expect(mocks.hostToOpts).toHaveBeenCalled();
  });

  it("cancels an open draft when the remote tree deletes that exact file", async () => {
    render(
      <FileViewerPanel
        {...panelProps({
          path: "/srv/repo/notes.txt",
          source: "ssh",
          hostId: "ssh-1",
        })}
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "code editor" });
    fireEvent.change(editor, { target: { value: "unsaved" } });

    act(() =>
      publishFileDeletion({
        source: "ssh",
        hostId: "ssh-1",
        path: "/srv/repo/notes.txt",
        isDirectory: false,
      }),
    );

    expect(await screen.findByText("파일이 원격 서버에서 삭제되었습니다")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(mocks.sshWriteFile).not.toHaveBeenCalled();
  });
});


function textFile(path: string, content: string): FileContent {
  return { path, name: path.split("/").pop()!, kind: "text", content, size: content.length, truncated: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const editor = () => screen.getByRole("textbox", { name: "code editor" }) as HTMLTextAreaElement;

it("changes the document when path props change and retains each path's own draft", async () => {
  vi.mocked(readFile).mockImplementation(async (path) => textFile(path, path));
  const view = render(<FileViewerPanel {...panelProps({ path: "/one.txt", source: "local" })} />);
  await screen.findByRole("textbox", { name: "code editor" });
  fireEvent.change(editor(), { target: { value: "draft one" } });
  view.rerender(<FileViewerPanel {...panelProps({ path: "/two.txt", source: "local" })} />);
  await waitFor(() => expect(editor().value).toBe("/two.txt"));
  expect(useStore.getState().fileDrafts["local::/one.txt"]).toBe("draft one");
  fireEvent.change(editor(), { target: { value: "draft two" } });
  view.rerender(<FileViewerPanel {...panelProps({ path: "/one.txt", source: "local" })} />);
  await waitFor(() => expect(editor().value).toBe("draft one"));
  expect(useStore.getState().fileDrafts["local::/two.txt"]).toBe("draft two");
});

it.each(["read", "candidates"])("ignores an old %s response after the execution target changes", async (kind) => {
  const pending = deferred<FileContent>();
  const candidates = deferred<string[]>();
  vi.mocked(readFile).mockReturnValue(pending.promise);
  vi.mocked(findFileCandidates).mockReturnValue(candidates.promise);
  const view = render(<FileViewerPanel {...panelProps({ path: "/notes.txt", source: "local" })} />);
  if (kind === "candidates") {
    await act(async () => pending.reject(new Error("No such file")));
    expect(findFileCandidates).toHaveBeenCalledWith("/notes.txt");
  }
  view.rerender(<FileViewerPanel {...panelProps({ path: "/notes.txt", source: "ssh", hostId: "ssh-1" })} />);
  await screen.findByRole("textbox", { name: "code editor" });
  expect(editor().value).toBe("before");
  await act(async () => {
    if (kind === "read") pending.resolve(textFile("/notes.txt", "old local content"));
    else candidates.resolve(["/old-a.txt", "/old-b.txt"]);
  });
  expect(editor().value).toBe("before");
  expect(screen.queryByText("/old-a.txt")).toBeNull();
});

it("does not let an old save replace the next document", async () => {
  const pending = deferred<number>();
  vi.mocked(readFile).mockResolvedValue(textFile("/notes.txt", "local"));
  vi.mocked(writeFile).mockReturnValue(pending.promise);
  const view = render(<FileViewerPanel {...panelProps({ path: "/notes.txt", source: "local" })} />);
  await screen.findByRole("textbox", { name: "code editor" });
  fireEvent.change(editor(), { target: { value: "local edit" } });
  fireEvent.keyDown(editor(), { key: "s", ctrlKey: true });
  await settle();
  expect(writeFile).toHaveBeenCalledWith("/notes.txt", "local edit");
  view.rerender(<FileViewerPanel {...panelProps({ path: "/notes.txt", source: "ssh", hostId: "ssh-1" })} />);
  await waitFor(() => expect(editor().value).toBe("before"));
  await act(async () => pending.resolve(10));
  expect(editor().value).toBe("before");
});

it("retains text typed during a write and reverts to the confirmed saved baseline", async () => {
  const pending = deferred<number>();
  mocks.sshWriteFile.mockReturnValue(pending.promise);
  render(<FileViewerPanel {...panelProps({ path: "/notes.txt", source: "ssh", hostId: "ssh-1" })} />);
  await screen.findByRole("textbox", { name: "code editor" });
  fireEvent.change(editor(), { target: { value: "first edit" } });
  fireEvent.keyDown(editor(), { key: "s", ctrlKey: true });
  fireEvent.change(editor(), { target: { value: "second edit" } });
  await act(async () => pending.resolve(10));
  expect(editor().value).toBe("second edit");
  fireEvent.click(screen.getByRole("button", { name: t("panels.fileViewer.revert") }));
  expect(editor().value).toBe("first edit");
});


async function settle() { await act(async () => {}); }
function autoSave(enabled: boolean, delay = 200) {
  act(() => useStore.setState((state) => ({ uiPrefs: { ...state.uiPrefs, autoSaveFiles: enabled, autoSaveDelayMs: delay } })));
}

it("disabling autosave after StrictMode replay cancels rather than flushes the pending edit", async () => {
  vi.useFakeTimers();
  autoSave(true);
  render(<StrictMode><FileViewerPanel {...panelProps({ path: "/notes.txt", source: "ssh", hostId: "ssh-1" })} /></StrictMode>);
  await settle();
  fireEvent.change(editor(), { target: { value: "pending edit" } });
  autoSave(false);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(mocks.sshWriteFile).not.toHaveBeenCalled();
  expect(editor().value).toBe("pending edit");
});

it("flushes the latest edit after an in-flight autosave finishes on close", async () => {
  vi.useFakeTimers();
  autoSave(true);
  const pending = deferred<number>();
  mocks.sshWriteFile.mockReturnValueOnce(pending.promise).mockResolvedValue(20);
  const view = render(<FileViewerPanel {...panelProps({ path: "/notes.txt", source: "ssh", hostId: "ssh-1" })} />);
  await settle();
  fireEvent.change(editor(), { target: { value: "first" } });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(mocks.sshWriteFile).toHaveBeenCalledTimes(1);
  fireEvent.change(editor(), { target: { value: "last edit before close" } });
  view.unmount();
  await act(async () => pending.resolve(5));
  expect(mocks.sshWriteFile).toHaveBeenCalledTimes(2);
  expect(mocks.sshWriteFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/notes.txt", content: "last edit before close" }));
  expect(useStore.getState().fileDrafts["ssh:ssh-1:/notes.txt"]).toBeUndefined();
});

it("keeps a deleted remote document closed when its earlier save completes", async () => {
  const pending = deferred<number>();
  mocks.sshWriteFile.mockReturnValue(pending.promise);
  render(<FileViewerPanel {...panelProps({ path: "/notes.txt", source: "ssh", hostId: "ssh-1" })} />);
  await screen.findByRole("textbox", { name: "code editor" });
  fireEvent.change(editor(), { target: { value: "edited" } });
  fireEvent.keyDown(editor(), { key: "s", ctrlKey: true });
  act(() => publishFileDeletion({ path: "/notes.txt", source: "ssh", hostId: "ssh-1", isDirectory: false }));
  await act(async () => pending.resolve(6));
  expect(screen.queryByRole("textbox", { name: "code editor" })).toBeNull();
  expect(screen.queryByRole("button", { name: t("panels.fileViewer.save") })).toBeNull();
});

it("does not queue a close-flush write after the remote file is deleted during an in-flight save", async () => {
  vi.useFakeTimers();
  autoSave(true);
  const pending = deferred<number>();
  mocks.sshWriteFile.mockReturnValueOnce(pending.promise).mockResolvedValue(20);
  const view = render(<FileViewerPanel {...panelProps({ path: "/notes.txt", source: "ssh", hostId: "ssh-1" })} />);
  await settle();
  fireEvent.change(editor(), { target: { value: "first" } });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  fireEvent.change(editor(), { target: { value: "last edit" } });
  view.unmount();
  act(() => publishFileDeletion({ source: "ssh", hostId: "ssh-1", path: "/notes.txt", isDirectory: false }));
  await act(async () => pending.resolve(5));
  expect(mocks.sshWriteFile).toHaveBeenCalledTimes(1);
  expect(useStore.getState().fileDrafts["ssh:ssh-1:/notes.txt"]).toBeUndefined();
});

it("restores Markdown in source mode and keeps that mode when explicitly discarding edits", async () => {
  vi.mocked(readFile).mockResolvedValue({ ...textFile("/notes.md", "# Disk"), kind: "markdown" });
  useStore.setState({ fileDrafts: { "local::/notes.md": "# Restored" } });
  render(<FileViewerPanel {...panelProps({ path: "/notes.md", source: "local" })} />);
  await screen.findByRole("textbox", { name: "code editor" });
  expect(editor().value).toBe("# Restored");
  fireEvent.click(screen.getByRole("button", { name: t("common.preview") }));
  expect(screen.queryByRole("textbox", { name: "code editor" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: t("panels.fileViewer.editSource") }));
  fireEvent.change(editor(), { target: { value: "# Discard this" } });
  fireEvent.click(screen.getByRole("button", { name: t("common.refresh") }));
  await waitFor(() => expect(editor().value).toBe("# Disk"));
  expect(useStore.getState().fileDrafts["local::/notes.md"]).toBeUndefined();
});

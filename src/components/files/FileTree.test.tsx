// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FileTree가 실제로 부르는 것만 대체한다 — 나머지 ipc 표면은 import만 되고 호출되지 않는다
vi.mock("@/lib/ipc", () => ({
  hostToOpts: vi.fn(() => ({ host: "example.com" })),
  listDir: vi.fn(),
  listRemoteDir: vi.fn(),
  saveFilesToDirectory: vi.fn(),
  sshDeleteFile: vi.fn(),
  sshExecOnce: vi.fn(),
  uploadSshFilesToDirectory: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@/lib/ipc/process", () => ({ runShell: vi.fn() }));
vi.mock("@/lib/toast", () => ({
  showErrorToast: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@/lib/workspace/desktop/desktopPlatform", () => ({ detectDesktopPlatform: () => "macos" }));
vi.mock("@/lib/platform/share", () => ({ shareFileAtPointer: vi.fn(async () => {}) }));

import { FileTree } from "@/components/files/FileTree";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listDir, sshExecOnce } from "@/lib/ipc";
import { runShell } from "@/lib/ipc/process";
import { useFileTreeExpansion } from "@/lib/files/fileTreeExpansionStore";
import {
  hostToOpts,
  listRemoteDir,
  saveFilesToDirectory,
  sshDeleteFile,
  uploadSshFilesToDirectory,
} from "@/lib/ipc";
import { useStore } from "@/store";
import { t } from "@/lib/i18n";
import type { SshHostConfig } from "@/types";

const tree: Record<
  string,
  { name: string; path: string; isDir: boolean; isRepo: boolean }[]
> = {
  "/repo": [
    { name: "src", path: "/repo/src", isDir: true, isRepo: false },
    { name: "README.md", path: "/repo/README.md", isDir: false, isRepo: false },
  ],
  "/repo/src": [
    { name: "main.ts", path: "/repo/src/main.ts", isDir: false, isRepo: false },
  ],
};

beforeEach(() => {
  vi.mocked(listDir).mockImplementation(async (path: string) => tree[path] ?? []);
  vi.mocked(listRemoteDir).mockImplementation(async (_host, path: string) => tree[path] ?? []);
  vi.mocked(saveFilesToDirectory).mockResolvedValue([]);
  vi.mocked(sshDeleteFile).mockResolvedValue(undefined);
  vi.mocked(uploadSshFilesToDirectory).mockResolvedValue([]);
  vi.mocked(runShell).mockResolvedValue({ stdout: "", stderr: "", code: 0 });
  vi.mocked(sshExecOnce).mockResolvedValue({ stdout: "", stderr: "", code: 0 });
  // 스토어 격리 — 펼침 상태는 모듈 전역 zustand라 테스트 간에 새어 나간다
  useFileTreeExpansion.setState({ trees: {}, recency: [] });
  useStore.setState({ fileTreeSelected: {}, sshHosts: [] });
  useStore.getState().setUiPrefs({ showGitIgnored: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTree() {
  return render(
    <FileTree cwd="/repo" source="local" onOpenFile={() => {}} />,
  );
}

describe("FileTree", () => {
  it("renders root entries from the directory listing", async () => {
    renderTree();
    expect(await screen.findByText("src")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("expands a directory on click and loads its children", async () => {
    renderTree();
    fireEvent.click(await screen.findByText("src"));
    expect(await screen.findByText("main.ts")).toBeTruthy();
  });

  it("restores expansion after unmount/remount (탭 전환·pop-out 회귀)", async () => {
    const first = renderTree();
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("main.ts");
    first.unmount();

    // 다시 마운트 — 클릭 없이 저장된 펼침이 스스로 복원되어야 한다
    renderTree();
    expect(await screen.findByText("main.ts")).toBeTruthy();
  });

  it("opens files instead of expanding them", async () => {
    const onOpenFile = vi.fn();
    render(<FileTree cwd="/repo" source="local" onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByText("README.md"));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("/repo/README.md"));
  });

  it("opens directory windows and reveals local entries in Finder from the context menu", async () => {
    renderTree();
    const directory = (await screen.findByText("src")).closest("button");
    expect(directory).not.toBeNull();

    fireEvent.contextMenu(directory as HTMLButtonElement);
    fireEvent.click(await screen.findByText("새 창으로 열기"));
    expect(openPath).toHaveBeenCalledWith("/repo/src");

    fireEvent.contextMenu(directory as HTMLButtonElement);
    fireEvent.click(await screen.findByText("Finder에서 보기"));
    expect(revealItemInDir).toHaveBeenCalledWith("/repo/src");
  });

  it("adds Finder files to the tree root", async () => {
    const view = renderTree();
    await screen.findByText("README.md");
    const scrollArea = view.container.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    expect(scrollArea).not.toBeNull();

    const dataTransfer = {
      files: [new File([new Uint8Array([1, 2, 3])], "hello world.txt")],
      types: ["Files"],
    };
    fireEvent.dragOver(scrollArea as HTMLElement, { dataTransfer });
    fireEvent.drop(scrollArea as HTMLElement, { dataTransfer });

    await waitFor(() =>
      expect(saveFilesToDirectory).toHaveBeenCalledWith("/repo", [
        { fileName: "hello world.txt", dataB64: "AQID" },
      ]),
    );
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(2));
  });

  it("uses a hovered directory as the Finder file destination", async () => {
    renderTree();
    const directory = (await screen.findByText("src")).closest("button");
    expect(directory).not.toBeNull();
    fireEvent.click(directory as HTMLButtonElement);
    await screen.findByText("main.ts");
    const dataTransfer = {
      files: [new File([new Uint8Array([7])], "nested.txt")],
      types: ["Files"],
    };

    fireEvent.dragOver(directory as HTMLButtonElement, { dataTransfer });
    expect(directory?.className).toContain("ring-primary/40");
    fireEvent.drop(directory as HTMLButtonElement, { dataTransfer });

    await waitFor(() =>
      expect(saveFilesToDirectory).toHaveBeenCalledWith("/repo/src", [
        { fileName: "nested.txt", dataB64: "Bw==" },
      ]),
    );
    await waitFor(() =>
      expect(vi.mocked(listDir).mock.calls.filter(([path]) => path === "/repo/src")).toHaveLength(2),
    );
    expect(screen.getByText("main.ts")).toBeTruthy();
  });

  it("uploads Finder files to an SSH tree without requiring a live terminal session", async () => {
    const host: SshHostConfig = {
      id: "ssh-1",
      name: "remote",
      host: "example.com",
      port: 22,
      user: "dev",
      auth: "auto",
    };
    useStore.setState({ sshHosts: [host] });
    const view = render(
      <FileTree
        cwd="/remote/repo"
        source="ssh"
        hostId={host.id}
        onOpenFile={() => {}}
      />,
    );
    const scrollArea = view.container.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    expect(scrollArea).not.toBeNull();
    const dataTransfer = {
      files: [new File([new Uint8Array([9])], "remote.txt")],
      types: ["Files"],
    };

    fireEvent.drop(scrollArea as HTMLElement, { dataTransfer });

    await waitFor(() =>
      expect(uploadSshFilesToDirectory).toHaveBeenCalledWith(
        { host: "example.com" },
        "/remote/repo",
        [{ fileName: "remote.txt", dataB64: "CQ==" }],
      ),
    );
    expect(hostToOpts).toHaveBeenCalledWith(host);
  });

  it("permanently deletes a confirmed SSH file through a one-off host connection", async () => {
    const host: SshHostConfig = {
      id: "ssh-1",
      name: "remote",
      host: "example.com",
      port: 22,
      user: "dev",
      auth: "auto",
    };
    useStore.setState({
      sshHosts: [host],
      fileDrafts: {
        "ssh:ssh-1:/repo/README.md": "unsaved",
        "ssh:ssh-2:/repo/README.md": "other host",
      },
    });
    render(
      <FileTree cwd="/repo" source="ssh" hostId={host.id} onOpenFile={() => {}} />,
    );
    const file = (await screen.findByText("README.md")).closest("button");
    expect(file).not.toBeNull();

    fireEvent.contextMenu(file as HTMLButtonElement);
    fireEvent.click(await screen.findByText("영구 삭제…"));

    // The row swaps to the popup-free confirm (SOUL §6); nothing is deleted
    // until its own destructive button is pressed.
    const confirmRow = await screen.findByRole("alertdialog");
    expect(confirmRow.textContent).toContain("실행 취소할 수 없습니다");
    expect(sshDeleteFile).not.toHaveBeenCalled();
    fireEvent.click(within(confirmRow).getByText("삭제"));

    await waitFor(() =>
      expect(sshDeleteFile).toHaveBeenCalledWith({
        connectOpts: { host: "example.com" },
        root: "/repo",
        path: "/repo/README.md",
        isDirectory: false,
      }),
    );
    await waitFor(() => expect(listRemoteDir).toHaveBeenCalledTimes(2));
    expect(useStore.getState().fileDrafts).toEqual({
      "ssh:ssh-2:/repo/README.md": "other host",
    });
  });

  it("does not intercept internal file-tree drags", async () => {
    const view = renderTree();
    await screen.findByText("README.md");
    const scrollArea = view.container.querySelector<HTMLElement>('[data-slot="scroll-area"]');
    const dataTransfer = { files: [], types: ["text/plain"], dropEffect: "none" };

    expect(fireEvent.dragOver(scrollArea as HTMLElement, { dataTransfer })).toBe(true);
    fireEvent.drop(scrollArea as HTMLElement, { dataTransfer });

    expect(saveFilesToDirectory).not.toHaveBeenCalled();
    expect(uploadSshFilesToDirectory).not.toHaveBeenCalled();
  });

  it("searches the current directory and opens a keyboard-selected local result", async () => {
    vi.mocked(runShell).mockResolvedValue({
      stdout: "src/first.ts\nsrc/second.ts\n",
      stderr: "",
      code: 0,
    });
    const onOpenFile = vi.fn();
    render(<FileTree cwd="/repo" source="local" onOpenFile={onOpenFile} />);
    const search = screen.getByRole("combobox", { name: "파일 검색" });

    fireEvent.change(search, { target: { value: "ts" } });
    expect(await screen.findByText("src/second.ts")).toBeTruthy();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("/repo/src/second.ts"));
    expect((search as HTMLInputElement).value).toBe("");
    expect(await screen.findByText("README.md")).toBeTruthy();
  });

  it("searches an SSH root and opens the exact remote file", async () => {
    const host: SshHostConfig = {
      id: "ssh-1",
      name: "remote",
      host: "example.com",
      port: 22,
      user: "dev",
      auth: "auto",
    };
    useStore.setState({ sshHosts: [host] });
    vi.mocked(sshExecOnce).mockResolvedValue({
      stdout: "src/main.ts\n",
      stderr: "",
      code: 0,
    });
    const onOpenFile = vi.fn();
    render(
      <FileTree
        cwd="/remote/repo"
        source="ssh"
        hostId={host.id}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "파일 검색" }), {
      target: { value: "main" },
    });
    fireEvent.click(await screen.findByText("src/main.ts"));

    expect(sshExecOnce).toHaveBeenCalled();
    expect(onOpenFile).toHaveBeenCalledWith("/remote/repo/src/main.ts");
  });
});

describe("FileTree · Git이 무시한 파일", () => {
  it("기본(표시)에서는 무시 여부를 묻지 않는다 — 목록마다 git을 띄우지 않는다", async () => {
    render(<FileTree cwd="/repo" source="local" onOpenFile={() => {}} />);
    await screen.findByText("README.md");

    expect(vi.mocked(listDir)).toHaveBeenCalledWith("/repo", true, false);
  });

  it("끄면 무시 표시된 항목이 목록에서 빠진다", async () => {
    useStore.getState().setUiPrefs({ showGitIgnored: false });
    vi.mocked(listDir).mockImplementation(async (path: string) =>
      path === "/repo"
        ? [
            { name: "src", path: "/repo/src", isDir: true, isRepo: false },
            { name: "dist", path: "/repo/dist", isDir: true, isRepo: false, ignored: true },
          ]
        : [],
    );

    render(<FileTree cwd="/repo" source="local" onOpenFile={() => {}} />);
    await screen.findByText("src");

    expect(vi.mocked(listDir)).toHaveBeenCalledWith("/repo", true, true);
    expect(screen.queryByText("dist")).toBeNull();
  });

  it("설정을 바꾸면 이미 그려진 목록도 다시 읽는다", async () => {
    render(<FileTree cwd="/repo" source="local" onOpenFile={() => {}} />);
    await screen.findByText("README.md");
    vi.mocked(listDir).mockClear();

    useStore.getState().setUiPrefs({ showGitIgnored: false });

    await waitFor(() => expect(vi.mocked(listDir)).toHaveBeenCalledWith("/repo", true, true));
  });
});


describe("directory result ownership", () => {
  it.each(["success", "failure"])("retains the current root after the previous root's late %s", async (outcome) => {
    let resolve!: (entries: typeof tree[string]) => void;
    let reject!: (error: Error) => void;
    const old = new Promise<typeof tree[string]>((done, fail) => { resolve = done; reject = fail; });
    vi.mocked(listDir).mockImplementation(async (path) => path === "/repo" ? old : [
      { name: "current.ts", path: "/other/current.ts", isDir: false, isRepo: false },
    ]);
    const view = render(<FileTree cwd="/repo" source="local" onOpenFile={() => {}} />);
    view.rerender(<FileTree cwd="/other" source="local" onOpenFile={() => {}} />);
    await screen.findByText("current.ts");
    await act(async () => {
      if (outcome === "success") resolve(tree["/repo"]);
      else reject(new Error("previous root denied"));
    });
    expect(screen.queryByText("current.ts")).not.toBeNull();
    expect(screen.queryByText("previous root denied")).toBeNull();
  });
});

it("retries an expanded folder at its error row", async () => {
  vi.mocked(listDir).mockResolvedValueOnce(tree["/repo"])
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce(tree["/repo/src"]);
  renderTree();
  fireEvent.click(await screen.findByText("src"));
  fireEvent.click(await screen.findByText(t("sidebar.fileTree.loadFailedRetry")));
  expect(await screen.findByText("main.ts")).toBeTruthy();
});

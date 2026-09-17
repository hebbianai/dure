// @vitest-environment jsdom
//
// 시안 2391:49612 반영으로 UI가 두 군데서 걷혔다: "변경 내용" 줄의 아이콘 세 개와
// 기본 버튼에 붙어 있던 커밋 변형 셰브런. 걷은 것들이 갈 곳을 잃지 않았는지가
// 이 파일이 지키는 계약이다 — 시안대로 비운 자리가 곧 기능 삭제가 되면 안 된다.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusCtxSnapshot } from "@/lib/scm/focusCtxBroadcast";
import { t } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({
  gitAvailability: vi.fn(),
  gitExec: vi.fn(),
  gitInfo: vi.fn(),
  gitAction: vi.fn(),
  gitLog: vi.fn(),
  gitBranches: vi.fn(),
  openSourceControlWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/ipc/git", async (original) => ({
  ...(await original<object>()),
  gitAvailability: mocks.gitAvailability,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), message: vi.fn() }));
vi.mock("@/lib/scm/history/git", () => ({
  gitExec: mocks.gitExec,
  gitInfo: mocks.gitInfo,
  gitAction: mocks.gitAction,
  gitLog: mocks.gitLog,
  gitBranches: mocks.gitBranches,
}));
vi.mock("@/lib/workspace/window/windows", () => ({
  openSourceControlWindow: mocks.openSourceControlWindow,
}));
vi.mock("@/lib/scm/scmDetailRelay", () => ({ openScmDetailInWindow: vi.fn() }));
vi.mock("@/lib/workspace/dock/openScmPanel", () => ({
  openGitPanel: vi.fn(),
}));

import { SourceControlPane } from "@/components/scm/SourceControlPane";
import { useStore } from "@/store";

const focus: FocusCtxSnapshot = {
  key: "pane-1",
  cwd: "/repo",
  source: "local",
  label: "repo",
};

/** Radix 트리거는 pointerdown에서 연다 — click만으로는 메뉴가 뜨지 않는다. */
function openMenu(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
}

/** 레포 줄의 ⋯ — 이 패널의 세 ⋯ 중 유일하게 "Git 액션"으로 불린다. */
function repoOverflow(): HTMLElement {
  return screen.getByLabelText("Git 액션");
}

beforeEach(() => {
  mocks.gitAvailability.mockReset().mockResolvedValue({ status: "available" });
  mocks.gitExec.mockReset();
  mocks.gitInfo.mockReset();
  mocks.gitLog.mockReset();
  mocks.gitBranches.mockReset();
  mocks.openSourceControlWindow.mockReset();
  // rev-parse --show-toplevel(리포 판정)과 이후 커밋 명령이 모두 여기로 온다.
  mocks.gitExec.mockResolvedValue({ stdout: "/repo\n", stderr: "", code: 0 });
  mocks.gitInfo.mockResolvedValue({ branch: "main", ahead: 0, behind: 0, files: [] });
  mocks.gitLog.mockResolvedValue([]);
  mocks.gitBranches.mockResolvedValue({ current: "main", local: [], remote: [] });
});

afterEach(() => {
  cleanup();
  useStore.setState({ focusCtx: null });
});

describe("SourceControlPane — 시안 2391:49612", () => {
  it("guides missing Git instead of showing an empty repository or Git actions", async () => {
    mocks.gitAvailability.mockResolvedValue({ status: "missing" });
    render(<SourceControlPane ctxOverride={focus} />);
    await screen.findByText(t("panels.git.availability.missing"));
    expect(screen.queryByLabelText(t("scm.actions.menuLabel"))).toBeNull();
    expect(mocks.gitInfo).not.toHaveBeenCalled();
    expect(mocks.gitExec).not.toHaveBeenCalled();
  });

  it("preserves a commit draft while the selected SSH host is rechecked", async () => {
    const remote = { id: "remote", name: "Remote", host: "remote.example.test", user: "dev", port: 2222, auth: "auto" as const };
    useStore.setState({ sshHosts: [remote] });
    render(<SourceControlPane ctxOverride={{ ...focus, source: "ssh", hostId: remote.id }} />);
    const input = await screen.findByPlaceholderText(t("scm.commit.messagePlaceholder"));
    fireEvent.change(input, { target: { value: "keep my draft" } });
    let finish!: (value: { status: "available" }) => void;
    mocks.gitAvailability.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => useStore.setState({ sshHosts: [{ ...remote, name: "Renamed host" }] }));
    await screen.findByText(t("panels.git.availability.checking"));
    await act(async () => finish({ status: "available" }));
    await waitFor(() => expect((screen.getByPlaceholderText(t("scm.commit.messagePlaceholder")) as HTMLInputElement).value).toBe("keep my draft"));
  });

  it("좁은 사이드바에서도 그래프 액션을 모두 노출한다", async () => {
    render(<SourceControlPane ctxOverride={focus} />);

    expect(await screen.findByRole("button", { name: "현재 커밋으로" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "브랜치 체크아웃" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "변경 내용 동기화" })).toBeTruthy();
  });

  it("변경 내용 줄은 라벨뿐이고, 그 줄이 들고 있던 액션은 패널 헤더 ⋯에 있다", async () => {
    render(<SourceControlPane ctxOverride={focus} />);
    await screen.findByText("변경 내용");

    // 걷어낸 인라인 아이콘 셋: 보기 토글·모두 접기는 더 이상 버튼이 아니다.
    expect(screen.queryByRole("button", { name: "트리로 보기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "모두 접기" })).toBeNull();

    // 헤더 ⋯ 하나가 그 셋을 전부 받는다.
    openMenu(screen.getAllByLabelText("더보기")[0]);
    await screen.findByText("모두 접기");
    expect(screen.getByText("새로고침")).toBeTruthy();
    expect(screen.getByText("목록으로 보기")).toBeTruthy();
    expect(screen.getByText("트리로 보기")).toBeTruthy();
  });

  it("사이드바에서만 '새 창으로 열기'가 뜬다 — 별도 창(미러)에서는 자기 자신을 다시 열 수 없다", async () => {
    // ctxOverride === undefined 가 사이드바 호스팅 신호다. 그 경로에서도
    // 메뉴가 서려면 저장소가 있어야 하므로 포커스는 스토어로 넣는다.
    useStore.setState({ focusCtx: focus });
    const { unmount } = render(<SourceControlPane />);
    await screen.findByText("변경 내용");
    openMenu(screen.getAllByLabelText("더보기")[0]);
    await screen.findByText("새 창으로 열기");
    unmount();
    cleanup();

    render(<SourceControlPane ctxOverride={focus} />);
    await screen.findByText("변경 내용");
    openMenu(screen.getAllByLabelText("더보기")[0]);
    await screen.findByText("모두 접기");
    expect(screen.queryByText("새 창으로 열기")).toBeNull();
  });

  it("저장소가 없으면 헤더 ⋯를 아예 걸지 않는다 — 모든 항목이 무동작인 메뉴다", async () => {
    render(<SourceControlPane ctxOverride={null} />);
    await screen.findByText(
      "패널(에이전트·터미널)을 선택하면 그 작업 폴더의 git 저장소가 여기 표시됩니다.",
    );
    expect(screen.queryByLabelText("더보기")).toBeNull();
  });

  it("새로고침은 git 상태만 다시 읽는다 — 쓰던 커밋 메시지를 날리지 않는다", async () => {
    render(<SourceControlPane ctxOverride={focus} />);
    const input = await screen.findByPlaceholderText("메시지");
    fireEvent.change(input, { target: { value: "쓰던 초안" } });

    const before = mocks.gitInfo.mock.calls.length;
    openMenu(screen.getAllByLabelText("더보기")[0]);
    fireEvent.click(await screen.findByText("새로고침"));

    // 다시 읽기는 실제로 일어나고,
    await waitFor(() => expect(mocks.gitInfo.mock.calls.length).toBeGreaterThan(before));
    // 초안은 그대로다 (카드가 리마운트되면 빈 문자열로 돌아간다).
    expect((screen.getByPlaceholderText("메시지") as HTMLInputElement).value).toBe("쓰던 초안");
  });

  it("셰브런이 사라진 뒤에도 커밋 변형은 레포 줄 ⋯에서 열린다", async () => {
    render(<SourceControlPane ctxOverride={focus} />);
    await screen.findByText("변경 내용");

    // 쪼갠 버튼은 없다 — 커밋 옵션을 여는 셰브런이 사라졌다.
    expect(screen.queryByRole("button", { name: "커밋 옵션" })).toBeNull();

    openMenu(repoOverflow());
    // git 액션은 그대로, 커밋 변형이 그 위에 얹혔다. ("커밋"은 기본 버튼에도
    // 있으므로 menuitem 역할로 좁힌다.)
    const trigger = await screen.findByRole("menuitem", { name: "커밋" });
    expect(screen.getByText("풀 (Pull)")).toBeTruthy();

    fireEvent.click(trigger);
    await screen.findByText("커밋 수정 (Amend)");
    expect(screen.getByText("커밋 (Signed Off)")).toBeTruthy();
    expect(screen.getByText("마지막 커밋 취소")).toBeTruthy();
  });

  it("기본 버튼 하나가 메시지를 커밋한다", async () => {
    render(<SourceControlPane ctxOverride={focus} />);
    const input = await screen.findByPlaceholderText("메시지");

    const commitButton = screen.getByRole("button", { name: "커밋" });
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "fix: 무언가" } });
    expect((commitButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(commitButton);

    await waitFor(() =>
      expect(mocks.gitExec).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/repo" }),
        ["commit", "-m", "fix: 무언가"],
      ),
    );
  });

  it("분할선을 콘텐츠보다 크게 끌 수 없고, 더블클릭이 자동 높이로 되돌린다", async () => {
    render(<SourceControlPane ctxOverride={focus} />);
    await screen.findByText("변경 내용");
    const handle = document.querySelector<HTMLElement>('[data-slot="scm-resize-handle"]')!;
    const changes = handle.previousElementSibling as HTMLElement;

    // 기본은 콘텐츠 높이 — 인라인 height가 없다.
    expect(changes.style.height).toBe("");
    expect(changes.classList.contains("shrink")).toBe(true);

    // 아래로 크게 끌어도 콘텐츠 높이(jsdom에서 scrollHeight=0 → 하한 64)를 넘지 않는다.
    fireEvent.mouseDown(handle, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 900 });
    fireEvent.mouseUp(window);
    const stretched = changes.style.height;
    expect(stretched).toBe("64px");
    expect(changes.classList.contains("shrink")).toBe(true);

    // 한 번 끌고 나면 예전에는 자동으로 못 돌아갔다 — 더블클릭이 그 길이다.
    fireEvent.doubleClick(handle);
    expect(changes.style.height).toBe("");
    expect(changes.classList.contains("shrink")).toBe(true);
  });

  it("keeps a long change list in its own scroll viewport without displacing the graph", async () => {
    mocks.gitInfo.mockResolvedValue({
      branch: "main",
      ahead: 0,
      behind: 0,
      files: Array.from({ length: 30 }, (_, index) => ({
        xy: " M",
        path: `src/file-${index}.ts`,
      })),
    });
    render(<SourceControlPane ctxOverride={focus} />);
    await screen.findByText("file-29.ts");
    const handle = document.querySelector<HTMLElement>('[data-slot="scm-resize-handle"]')!;
    const changes = handle.previousElementSibling as HTMLElement;
    const graph = handle.nextElementSibling as HTMLElement;

    expect(changes.classList.contains("shrink")).toBe(true);
    expect(graph.classList.contains("min-h-[120px]")).toBe(true);
  });

  it("ahead/behind가 있으면 같은 자리가 동기화 버튼이 된다", async () => {
    mocks.gitInfo.mockResolvedValue({ branch: "main", ahead: 2, behind: 11, files: [] });
    render(<SourceControlPane ctxOverride={focus} />);

    // 아래 그래프 툴바에도 같은 이름의 아이콘 버튼이 있다 — 라벨 텍스트를
    // 가진 쪽(카드의 기본 버튼)만 고른다.
    const label = await screen.findByText("변경 내용 동기화");
    const sync = label.closest("button");
    if (!sync) throw new Error("기본 버튼을 찾지 못했습니다");
    expect(sync.textContent).toContain("11↓");
    expect(sync.textContent).toContain("2↑");
    // 메시지가 비어 있어도 동기화는 눌린다 — 커밋과 달리 초안이 필요 없다.
    expect(sync.disabled).toBe(false);
  });
});

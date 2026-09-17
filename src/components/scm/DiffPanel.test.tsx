// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffPanel } from "@/components/scm/DiffPanel";
import type { DiffReviewPanelParams } from "@/lib/scm/review/diffReviewTarget";
import type { ReviewSnapshotV1, ReviewTargetRecordV1 } from "@/lib/ipc";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

const { createDiffReviewTarget, diffReviewSnapshot } = vi.hoisted(() => ({
  createDiffReviewTarget: vi.fn(),
  diffReviewSnapshot: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  createDiffReviewTarget,
  diffReviewSnapshot,
}));

vi.mock("@/lib/scm/review/diffReviewRetention", () => ({
  syncCurrentDiffReviewTargets: vi.fn(),
}));

vi.mock("@/components/workspace/usePaneFirstReveal", () => ({
  usePaneFirstReveal: () => true,
}));

vi.mock("@/components/editor/LazyCodeEditor", () => ({
  LazyCodeEditor: ({ value, fileName }: { value: string; fileName: string }) => (
    <pre data-testid="diff-editor" data-file-name={fileName}>
      {value}
    </pre>
  ),
}));

const target: ReviewTargetRecordV1 = {
  reviewId: "review-fixed",
  worktreePath: "/repo/.worktrees/feature",
  worktreeGitDir: "/repo/.git/worktrees/feature",
  baseRef: "origin/main",
  baseCommitSha: "a".repeat(40),
  headCommitSha: "b".repeat(40),
  sourceSessionId: "session-1",
  feedbackAgentId: null,
  createdAtMs: 10,
};

function panelProps(
  params: DiffReviewPanelParams,
  updateParameters = vi.fn(),
): IDockviewPanelProps<DiffReviewPanelParams> {
  return {
    params,
    api: {
      id: "diff:session:session-1",
      updateParameters,
    },
  } as unknown as IDockviewPanelProps<DiffReviewPanelParams>;
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ agents: [], projects: [], diffComments: {} });
  createDiffReviewTarget.mockResolvedValue(target);
  diffReviewSnapshot.mockResolvedValue({
    target,
    review: {
      worktreePath: target.worktreePath,
      baseRef: target.baseRef,
      mergeBase: target.baseCommitSha,
      files: [],
      diff: "fixed diff",
    },
  });
});

afterEach(cleanup);

describe("DiffPanel durable target", () => {
  it.each(["report.ts", "report.ts "])("selects the exact patch for filename %j", async (selectedPath) => {
    const paths = ["report.ts", "report.ts "];
    const patches = paths.map((path, index) => [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}${index ? "\t" : ""}`,
      `+++ b/${path}${index ? "\t" : ""}`,
      "@@ -1 +1 @@",
      "-old",
      `+change for file ${index}`,
    ].join("\n"));
    diffReviewSnapshot.mockResolvedValue({
      target,
      review: {
        worktreePath: target.worktreePath,
        baseRef: target.baseRef,
        mergeBase: target.baseCommitSha,
        files: paths.map((path) => ({ path, status: "M", added: 1, deleted: 1 })),
        diff: patches.join("\n"),
      },
    });
    render(<DiffPanel {...panelProps({ reviewId: target.reviewId, cwd: "/repo" })} />);
    fireEvent.click(await screen.findByLabelText(selectedPath, { normalizer: (value) => value }));
    expect(screen.getByTestId("diff-editor").textContent).toBe(patches[paths.indexOf(selectedPath)]);
  });

  // Raw paths and quoted spellings observed with git -c core.quotepath=false diff.
  const quotedPaths = [
    ["tab\tname.ts", String.raw`tab\tname.ts`],
    ["tab\\tname.ts", String.raw`tab\\tname.ts`],
    ["line\nname.ts", String.raw`line\nname.ts`],
    ["line\\nname.ts", String.raw`line\\nname.ts`],
    ["한글\t끝\n.ts", String.raw`한글\t끝\n.ts`],
    ["tail.ts\t", String.raw`tail.ts\t`],
    ["tail.ts\n", String.raw`tail.ts\n`],
  ];
  it.each(quotedPaths)("selects the exact patch for Git-quoted filename %j", async (selectedPath) => {
    const patches = quotedPaths.map(([, quotedPath], index) => [
      `diff --git "a/${quotedPath}" "b/${quotedPath}"`,
      `--- "a/${quotedPath}"`,
      `+++ "b/${quotedPath}"`,
      "@@ -1 +1 @@",
      "-old",
      `+change for quoted file ${index}`,
    ].join("\n"));
    diffReviewSnapshot.mockResolvedValue({
      target,
      review: {
        worktreePath: target.worktreePath,
        baseRef: target.baseRef,
        mergeBase: target.baseCommitSha,
        files: quotedPaths.map(([path]) => ({ path, status: "M", added: 1, deleted: 1 })),
        diff: patches.join("\n"),
      },
    });
    render(<DiffPanel {...panelProps({ reviewId: target.reviewId, cwd: "/repo" })} />);
    fireEvent.click(await screen.findByLabelText(selectedPath, { normalizer: (value) => value }));
    const index = quotedPaths.findIndex(([path]) => path === selectedPath);
    expect(screen.getByTestId("diff-editor").textContent).toBe(patches[index]);
  });

  it("selects a rename whose actual destination starts with b/", async () => {
    diffReviewSnapshot.mockResolvedValue({ target, review: {
      worktreePath: target.worktreePath, baseRef: target.baseRef, mergeBase: target.baseCommitSha,
      files: [{ path: "b/new.ts", oldPath: "old.ts", status: "R", added: 0, deleted: 0, binary: false }],
      diff: "diff --git a/old.ts b/b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to b/new.ts",
    } });
    render(<DiffPanel {...panelProps({ reviewId: target.reviewId, cwd: "/repo" })} />);
    fireEvent.click(await screen.findByRole("button", { name: /b\/new\.ts/ }));
    expect(screen.getByTestId("diff-editor").textContent).toContain("rename to b/new.ts");
  });
  it("keeps one complete latest snapshot across overlapping refreshes and a read failure", async () => {
    const snapshot = (name: string): ReviewSnapshotV1 => ({
      target: { ...target, worktreePath: `/repo/${name}`, headCommitSha: name.repeat(40) },
      review: { worktreePath: `/repo/${name}`, baseRef: name, mergeBase: name.repeat(40),
        files: [{ path: `${name}.ts`, oldPath: null, status: "M", added: 1, deleted: 1 }],
        diff: `diff --git a/${name}.ts b/${name}.ts\n@@ -1 +1 @@\n-old\n+${name}`, },
    });
    diffReviewSnapshot.mockResolvedValueOnce(snapshot("a"));
    render(<DiffPanel {...panelProps({ reviewId: target.reviewId, cwd: "/repo" })} />);
    fireEvent.click(await screen.findByRole("button", { name: /a\.ts/ }));
    let finishOld!: (value: ReviewSnapshotV1) => void;
    diffReviewSnapshot.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce(snapshot("b"));
    fireEvent.click(screen.getByRole("button", { name: t("common.refresh") }));
    await waitFor(() => expect(diffReviewSnapshot).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: t("common.refresh") }));
    await screen.findByRole("button", { name: /b\.ts/ });
    await act(async () => { finishOld(snapshot("old")); });
    expect(screen.getByLabelText("/repo/b")).toBeTruthy();
    expect(screen.getByTestId("diff-editor").dataset.fileName).toBe("review.diff");
    expect(screen.getByTestId("diff-editor").textContent).toContain("+b");
    expect(screen.queryByRole("button", { name: /old\.ts/ })).toBeNull();
    diffReviewSnapshot.mockRejectedValueOnce(new Error("read denied"));
    fireEvent.click(screen.getByRole("button", { name: t("common.refresh") }));
    await screen.findByText("Error: read denied");
    expect(screen.getByLabelText("/repo/b")).toBeTruthy();
    expect(screen.getByTestId("diff-editor").textContent).toContain("+b");
  });
  it("keeps a standalone legacy pane usable when its host cannot persist parameters", async () => {
    render(
      <DiffPanel
        {...({
          params: { agentId: "agent-1" },
          api: { id: "diff-window:agent-1" },
        } as unknown as IDockviewPanelProps<DiffReviewPanelParams>)}
      />,
    );

    await waitFor(() => expect(diffReviewSnapshot).toHaveBeenCalledOnce());
    expect(screen.getByText("fixed diff")).toBeTruthy();
  });

  it("loads a restored pane by its durable review id", async () => {
    render(
      <DiffPanel
        {...panelProps({
          reviewId: target.reviewId,
          cwd: "/repo/subdir",
          sessionId: "session-1",
        })}
      />,
    );

    await waitFor(() => expect(diffReviewSnapshot).toHaveBeenCalledWith(target.reviewId));
    expect(createDiffReviewTarget).toHaveBeenCalledWith({
      reviewId: target.reviewId,
      path: "/repo/subdir",
      sourceSessionId: "session-1",
      feedbackAgentId: undefined,
    });
    expect(screen.getByText("fixed diff")).toBeTruthy();
    expect(screen.getByLabelText(target.worktreePath)).toBeTruthy();
  });

  it("adds one stable review id to a legacy cwd-only pane before creation", async () => {
    const updateParameters = vi.fn();
    render(
      <DiffPanel
        {...panelProps(
          {
            cwd: "/repo/subdir",
            sessionId: "session-1",
          },
          updateParameters,
        )}
      />,
    );

    await waitFor(() => expect(createDiffReviewTarget).toHaveBeenCalledOnce());
    const createdId = createDiffReviewTarget.mock.calls[0]?.[0].reviewId;
    expect(createdId).toMatch(/^review-/);
    expect(updateParameters).toHaveBeenCalledWith({
      cwd: "/repo/subdir",
      sessionId: "session-1",
      reviewId: createdId,
    });
  });

  it("uses the selected file path for syntax highlighting", async () => {
    diffReviewSnapshot.mockResolvedValue({
      target,
      review: {
        worktreePath: target.worktreePath,
        baseRef: target.baseRef,
        mergeBase: target.baseCommitSha,
        files: [
          {
            path: "src/example.ts",
            status: "M",
            added: 1,
            deleted: 1,
            binary: false,
          },
          {
            path: "assets/example.bin",
            status: "M",
            added: 0,
            deleted: 0,
            binary: true,
          },
        ],
        diff: [
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1 +1 @@",
          "-const before = true;",
          "+const after = true;",
          "diff --git a/assets/example.bin b/assets/example.bin",
          "Binary files a/assets/example.bin and b/assets/example.bin differ",
        ].join("\n"),
      },
    });

    const view = render(
      <DiffPanel
        {...panelProps({
          reviewId: target.reviewId,
          cwd: "/repo/subdir",
          sessionId: "session-1",
        })}
      />,
    );

    const editor = view.getByTestId("diff-editor");
    expect(editor.dataset.fileName).toBe("review.diff");

    fireEvent.click(await view.findByRole("button", { name: /src\/example\.ts/ }));

    expect(editor.dataset.fileName).toBe("src/example.ts");
    expect(editor.textContent).toContain("+const after = true;");

    // diffDocument 모드에서 fileName은 fallback 언어 힌트일 뿐이다 — 언어를
    // 모르는 파일도 경로를 그대로 넘기고, 오버레이가 강조를 생략한다.
    fireEvent.click(view.getByRole("button", { name: /assets\/example\.bin/ }));

    expect(editor.dataset.fileName).toBe("assets/example.bin");

    fireEvent.click(view.getByRole("button", { name: "전체 파일 (2)" }));

    expect(editor.dataset.fileName).toBe("review.diff");
  });
});

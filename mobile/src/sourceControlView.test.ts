import { describe, expect, it } from "vitest";
import {
  type SourceControlChanges,
  type SourceControlModel,
  changesFromOutcome,
  renderSourceControl,
} from "./sourceControlView";
import type { SourceControlOutcome } from "./ipc";

const NOTHING = { back: () => {}, refresh: () => {} };

function render(changes: SourceControlChanges, extra: Partial<SourceControlModel> = {}) {
  const model: SourceControlModel = {
    title: "카드 토큰",
    branch: "fix/payment-retry",
    changes,
    ...extra,
  };
  return renderSourceControl(model, NOTHING);
}

describe("renderSourceControl", () => {
  it("파일과 ±줄 수를 그린다", () => {
    const screen = render({
      kind: "read",
      files: [{ path: "src/payments/retry.ts", status: "M", added: 14, deleted: 3 }],
      ahead: 2,
      behind: 0,
      baseRef: "main",
    });

    expect(screen.querySelector(".scm__file-path")?.textContent).toBe("src/payments/retry.ts");
    expect(screen.querySelector(".scm__file-added")?.textContent).toBe("+14");
    expect(screen.querySelector(".scm__file-deleted")?.textContent).toBe("−3");
    expect(screen.querySelector(".scm__branch-track")?.textContent).toBe("2 ahead, 0 behind");
    expect(screen.querySelector(".scm__branch-facts")?.textContent).toContain("forked from main");
  });

  /**
   * 줄을 누르면 그 파일의 패치 화면이 열린다.
   *
   * `<button>` 인 것이 요점의 절반이다 — `<div onclick>` 은 키보드로 닿지 않고
   * 스크린리더가 읽지 않는다. 나머지 절반은 목록이 준 경로가 **그대로** 넘어
   * 간다는 것: 폰이 경로를 짓거나 다듬으면 답하는 쪽 목록과 안 맞아 거절된다.
   */
  it("파일 줄을 누르면 그 파일을 연다", () => {
    const opened: string[] = [];
    const screen = renderSourceControl(
      {
        title: "카드 토큰",
        changes: {
          kind: "read",
          files: [{ path: "src/payments/retry.ts", status: "M", added: 14, deleted: 3 }],
        },
      },
      { ...NOTHING, openFile: (file) => opened.push(file.path) },
    );

    // 체크박스와 다른 표적이다 — 하나로 묶으면 diff 를 보려던 누름이 선택을
    // 바꾼다. 그래서 여는 것은 경로 쪽 버튼이다.
    const row = screen.querySelector<HTMLButtonElement>(".scm__file-open");
    expect(row?.tagName).toBe("BUTTON");
    row?.click();
    expect(opened).toEqual(["src/payments/retry.ts"]);
  });

  /**
   * 열 수 없으면 버튼이 아니다. 눌러도 아무 일이 없는 버튼은 앱이 멈춘 것처럼
   * 읽힌다 — `dom.ts` 의 `cardRow` 가 같은 이유로 `disabled` 를 붙인다.
   */
  it("열 수 없는 목록의 줄은 버튼이 아니다", () => {
    const screen = render({
      kind: "read",
      files: [{ path: "src/payments/retry.ts", status: "M" }],
    });

    expect(screen.querySelector(".scm__file-open")?.tagName).toBe("DIV");
  });

  /**
   * 체크박스는 **커밋할 것이 있는** 줄에만 선다.
   *
   * 목록은 기준 브랜치와의 비교라 이미 커밋된 파일도 들어 있다. 그 줄에도
   * 체크박스를 두면 사람이 고를 수 있고, `git commit --only` 는 선택 **전체**를
   * 거절한다 — 자기가 고른 나머지 파일까지 커밋되지 않은 이유는 화면 어디에도
   * 안 나온다.
   */
  it("커밋할 것이 있는 줄에만 체크박스를 그린다", () => {
    const screen = renderSourceControl(
      {
        title: "카드 토큰",
        changes: {
          kind: "read",
          filesRead: true,
          files: [
            { path: "wip.ts", status: "M", uncommitted: true },
            { path: "committed.ts", status: "M", uncommitted: false },
            // 안 물어본 파일. 거짓이 아니라 모르는 것이라, 역시 못 고른다.
            { path: "unknown.ts", status: "M" },
          ],
        },
      },
      { ...NOTHING, toggleFile: () => {} },
    );

    const rows = [...screen.querySelectorAll(".scm__file")];
    expect(rows[0]?.querySelector(".scm__check")).not.toBeNull();
    expect(rows[1]?.querySelector(".scm__check")).toBeNull();
    expect(rows[2]?.querySelector(".scm__check")).toBeNull();
    // 고를 수 없는 줄에는 상태 글자가 그대로 선다 — 회색 체크박스는
    // "안 골랐다" 로 읽히는데 실제로는 "고를 수 없다" 다.
    expect(rows[1]?.querySelector(".scm__file-status")?.textContent).toBe("M");
  });

  /**
   * 셋째 상태가 있다: 일부만 골랐다. `checked` 로 그리면 누르는 사람은 전체
   * 해제를 기대하는데, 이 자리의 동작은 나머지를 다 고르는 것이다.
   */
  it("일부만 고른 머리줄은 indeterminate 다", () => {
    const model = {
      title: "카드 토큰",
      tab: "changes" as const,
      changes: {
        kind: "read" as const,
        filesRead: true,
        files: [
          { path: "a.ts", status: "M", uncommitted: true },
          { path: "b.ts", status: "M", uncommitted: true },
        ],
      },
    };
    const actions = { ...NOTHING, toggleFile: () => {}, toggleAll: () => {} };

    const some = renderSourceControl({ ...model, selection: new Set(["a.ts"]) }, actions);
    const header = some.querySelector<HTMLInputElement>(".scm__select .scm__check");
    expect(header?.indeterminate).toBe(true);
    expect(header?.checked).toBe(false);
    expect(some.querySelector(".scm__select-label")?.textContent).toBe("1 of 2 included");

    const all = renderSourceControl(
      { ...model, selection: new Set(["a.ts", "b.ts"]) },
      actions,
    );
    const full = all.querySelector<HTMLInputElement>(".scm__select .scm__check");
    expect(full?.checked).toBe(true);
    expect(full?.indeterminate).toBe(false);
  });

  /**
   * 고른 것이 없으면 커밋 버튼도 없다. 회색 버튼은 눌러도 아무 일이 없는
   * 컨트롤이고, 그건 앱이 멈춘 것처럼 읽힌다.
   */
  it("고른 것이 있을 때만 커밋 버튼을 그린다", () => {
    const model = {
      title: "카드 토큰",
      tab: "changes" as const,
      changes: {
        kind: "read" as const,
        filesRead: true,
        files: [{ path: "a.ts", status: "M", uncommitted: true }],
      },
    };
    const actions = { ...NOTHING, toggleFile: () => {}, commit: () => {} };

    expect(renderSourceControl(model, actions).querySelector(".prform__footer")).toBeNull();
    const chosen = renderSourceControl({ ...model, selection: new Set(["a.ts"]) }, actions);
    expect(chosen.querySelector(".prform__footer")?.textContent).toBe("Commit 1 files");
  });

  /**
   * 쓸 수 없는 경로에는 컨트롤이 아예 없다. 눌러도 아무 일이 없는 체크박스는
   * "안 골랐다" 로 읽히는데, 실제로는 이 상자에 그 명령이 없다.
   */
  it("쓸 수 없으면 체크박스도 머리줄도 없다", () => {
    const screen = render({
      kind: "read",
      filesRead: true,
      files: [{ path: "a.ts", status: "M", uncommitted: true }],
    });

    expect(screen.querySelector(".scm__check")).toBeNull();
    expect(screen.querySelector(".scm__select")).toBeNull();
  });

  /**
   * 이진 파일은 0 줄이 아니다. `+0 −0` 은 "안 바뀜" 으로 읽히는데 그 파일은
   * 바뀌었다 — 숫자 대신 아무것도 안 그린다.
   */
  it("이진 파일에는 ± 를 안 그린다", () => {
    const screen = render({ kind: "read", files: [{ path: "logo.png", status: "M" }] });

    expect(screen.querySelector(".scm__file-path")?.textContent).toBe("logo.png");
    expect(screen.querySelector(".scm__file-added")).toBeNull();
    expect(screen.querySelector(".scm__file-deleted")).toBeNull();
  });

  /**
   * 이 화면이 절대 내면 안 되는 답 하나: 못 읽은 것을 "바뀐 게 없다" 로 그리는
   * 것. 두 상태는 서로 다른 문장을 낸다.
   */
  it("못 읽은 것과 깨끗한 것을 갈라 말한다", () => {
    const failed = render({ kind: "failed", detail: "이 컴퓨터에서 그 세션을 찾지 못했습니다" });
    expect(failed.textContent).toContain("Could not read the changes");
    // 노트북이 준 문장을 그대로 — 다시 쓰면 다음에 뭘 해야 하는지가 사라진다.
    expect(failed.textContent).toContain("이 컴퓨터에서 그 세션을 찾지 못했습니다");
    expect(failed.querySelectorAll(".scm__file")).toHaveLength(0);

    const clean = render({ kind: "read", files: [] });
    expect(clean.textContent).toContain("No changed files");
    expect(clean.textContent).not.toContain("Could not read");
  });

  /**
   * 이 화면이 "브랜치를 아직 받지 못했습니다" 를 말하던 이유가 이것이다:
   * 배치표의 브랜치는 에이전트 id 로 색인된 캐시라 터미널 pane 을 못 담고,
   * 기존 체크아웃에서 만든 에이전트에는 아예 비어 있다. 물어서 받은 값이 있으면
   * 그쪽이 이긴다.
   */
  it("읽어 온 브랜치가 배치표의 캐시를 이긴다", () => {
    const screen = render(
      { kind: "read", files: [], branch: "worktree/card-tokens" },
      { branch: "옛날에-밀어둔-것" },
    );

    expect(screen.querySelector(".scm__branch-name")?.textContent).toBe("worktree/card-tokens");
    expect(screen.querySelector(".session__detail")?.textContent).toContain("worktree/card-tokens");
  });

  /** 목록을 못 읽었어도 브랜치를 읽었으면 그린다. */
  it("실패한 응답이 들고 온 브랜치도 그린다", () => {
    const screen = render({
      kind: "failed",
      detail: "기준 ref 를 찾지 못했습니다",
      branch: "worktree/card-tokens",
    });

    expect(screen.querySelector(".scm__branch-name")?.textContent).toBe("worktree/card-tokens");
  });

  /**
   * 브랜치가 없을 때 이유를 알면 그 이유를 그 자리에 쓴다. 다섯 가지 원인에 같은
   * 한 문장을 쓰면 다음에 보는 사람이 무엇을 해야 할지 알 수 없다.
   */
  it("브랜치가 없으면 아는 이유를 그 자리에 쓴다", () => {
    const screen = render(
      { kind: "failed", detail: "이 컴퓨터에서 그 세션을 찾지 못했습니다" },
      { branch: undefined },
    );

    expect(screen.querySelector(".scm__branch-name")?.textContent).toBe(
      "이 컴퓨터에서 그 세션을 찾지 못했습니다",
    );
  });

  /** 캐시밖에 없으면 캐시를 쓴다 — 요청이 도는 동안 빈칸을 보여주지 않는다. */
  it("아직 못 받았으면 배치표의 값을 그린다", () => {
    const screen = render({ kind: "loading" }, { branch: "fix/payment-retry" });

    expect(screen.querySelector(".scm__branch-name")?.textContent).toBe("fix/payment-retry");
  });

  /** 둘 다 없을 때만 못 받았다고 말한다. */
  it("둘 다 없으면 그렇다고 말한다", () => {
    const screen = render({ kind: "read", files: [] }, { branch: undefined });

    expect(screen.querySelector(".scm__branch-name")?.textContent).toBe("No branch reported yet");
  });

  /** 옮긴 파일은 목적지만 그리면 추가와 구별이 안 된다. */
  it("이름이 바뀐 파일은 원래 경로도 그린다", () => {
    const screen = render({
      kind: "read",
      files: [
        {
          path: "src/lib/hub/gitStatus.ts",
          status: "R",
          oldPath: "src/gitStatus.ts",
          added: 2,
          deleted: 0,
        },
      ],
    });

    expect(screen.querySelector(".scm__file-from")?.textContent).toBe("src/gitStatus.ts");
    expect(screen.querySelector(".scm__file-name")?.textContent).toBe("src/lib/hub/gitStatus.ts");
  });

  /** 숫자가 아직 없는 동안 "0 ahead" 는 자리 표시가 아니라 틀린 주장이다. */
  it("읽는 중에는 개수를 주장하지 않는다", () => {
    const screen = render({ kind: "loading" });

    expect(screen.querySelector(".scm__branch-track")).toBeNull();
    expect(screen.querySelector(".scm__branch-facts")).toBeNull();
    expect(screen.querySelector(".session__detail")?.textContent).toBe("fix/payment-retry");
    expect(screen.textContent).toContain("Reading changes");
  });
});

/** 답 하나. 필드가 늘어도 시험은 관심 있는 것만 말한다. */
function outcome(partial: Partial<SourceControlOutcome> = {}): SourceControlOutcome {
  return {
    read: true,
    branch: null,
    files: [],
    ahead: null,
    behind: null,
    base_ref: null,
    detail: null,
    comparison: null,
    root: null,
    code: null,
    files_read: true,
    commits: [],
    commits_read: false,
    review: null,
    review_read: false,
    branches: [],
    branches_read: false,
    reviewers: [],
    reviewers_read: false,
    commit_body: null,
    ...partial,
  };
}

describe("changesFromOutcome", () => {
  /**
   * 브랜치 카드는 물어본 탭의 개수만 말한다.
   *
   * 커밋 탭과 PR 탭의 답은 파일을 싣지 않는다. 그 빈 목록으로 개수를 그리면
   * 더러운 워크트리 위에 "0 changed" 라고 쓰게 된다 — 읽지도 않은 것에 대한
   * 주장이고, 노트북 경로에서 이미 그렇게 되고 있었다.
   */
  it("읽지 않은 파일 목록으로 개수를 주장하지 않는다", () => {
    const asked = changesFromOutcome(outcome({ files_read: true, files: [] }));
    const notAsked = changesFromOutcome(
      outcome({ files_read: false, files: [], commits_read: true }),
    );

    expect(asked).toMatchObject({ kind: "read", filesRead: true });
    expect(notAsked.kind === "read" && notAsked.filesRead).toBeUndefined();
  });

  /**
   * 폰의 Rust 경계는 "아무도 안 셈"을 `null` 로 준다. 그대로 들고 오면 행이
   * `+null` 을 그리고, 0 으로 바꾸면 바뀐 파일을 `+0 −0` 으로 그린다. 둘 다
   * 틀렸다 — 여기서 **없는 값**이 되어야 한다.
   */
  it("이진 파일의 null 은 없는 값이 된다", () => {
    const changes = changesFromOutcome(
      outcome({
        files: [
          { path: "logo.png", status: "M", old_path: null, added: null, deleted: null, uncommitted: null },
        ],
      }),
    );

    expect(changes).toEqual({
      kind: "read",
      filesRead: true,
      files: [{ path: "logo.png", status: "M" }],
    });
  });

  it("센 줄과 앞뒤 수를 그대로 옮긴다", () => {
    const changes = changesFromOutcome(
      outcome({
        branch: "fix/payment-retry",
        files: [
          { path: "src/app.ts", status: "M", old_path: null, added: 14, deleted: 3, uncommitted: true },
        ],
        ahead: 2,
        behind: 0,
        base_ref: "main",
        comparison: "merge_base",
      }),
    );

    expect(changes).toEqual({
      kind: "read",
      filesRead: true,
      files: [{ path: "src/app.ts", status: "M", added: 14, deleted: 3, uncommitted: true }],
      branch: "fix/payment-retry",
      ahead: 2,
      behind: 0,
      baseRef: "main",
    });
  });

  /** 거절은 노트북의 문장을 그대로 들고 온다. 없으면 그 사실을 말한다. */
  it("거절은 이유를 들고 온다", () => {
    expect(
      changesFromOutcome(
        outcome({ read: false, detail: "이 컴퓨터에서 그 세션을 찾지 못했습니다" }),
      ),
    ).toEqual({ kind: "failed", detail: "이 컴퓨터에서 그 세션을 찾지 못했습니다" });

    // 빈 문자열도 이유가 아니다 — `??` 면 여기서 빈 줄이 그려진다.
    for (const detail of [null, ""]) {
      expect(changesFromOutcome(outcome({ read: false, detail }))).toEqual({
        kind: "failed",
        detail: "The laptop did not say why",
      });
    }
  });

  /**
   * 낡은 상자는 "다시 눌러 보라" 가 아니다. 할 일은 그 상자의 hmux 를 갱신하는
   * 것이고, 화면은 그 문장을 말해야 한다 — 게이트웨이가 돌려준 프로토콜 문장이
   * 아니라.
   */
  it("낡은 상자는 갱신하라고 말한다", () => {
    const changes = changesFromOutcome(
      outcome({
        read: false,
        detail: "the server speaks …",
        code: "unsupported_protocol_version",
      }),
    );

    expect(changes).toEqual({
      kind: "failed",
      detail: "This box's hmux is too old to read the changes",
    });
  });

  /** 저장소가 아닌 디렉토리는 깨끗한 저장소와 다른 사실이다. */
  it("저장소가 아니면 깨끗하다고 하지 않는다", () => {
    const changes = changesFromOutcome(
      outcome({
        read: false,
        detail: "이 세션의 디렉토리는 저장소가 아닙니다",
        code: "not_versioned",
      }),
    );

    expect(changes.kind).toBe("failed");
  });
});

/**
 * 탭 줄이 없다. 커밋 탭이 브랜치 전환·올리기·PR 폼과 함께 빠졌다(2026-09-04) —
 * 이 화면은 변경 목록과 커밋뿐이고, 시안(3042:80841)이 그리는 대로 헤더 바로
 * 아래 브랜치 카드로 시작한다.
 */
describe("변경뿐인 화면", () => {
  const read: SourceControlChanges = {
    kind: "read",
    files: [{ path: "src/payments/retry.ts", status: "M", added: 14, deleted: 3 }],
    filesRead: true,
    baseRef: "main",
  };

  it("탭 줄도 커밋 목록도 없다", () => {
    const screen = render(read);

    expect(screen.querySelector(".scm__tabs")).toBeNull();
    expect(screen.querySelector(".scm__commit")).toBeNull();
    expect(screen.querySelector(".scm__card")).not.toBeNull();
  });

  /** 시안이 영어로 쓰는 제목 그대로 — `2 ahead` 처럼 git 의 낱말이다. */
  it("헤더는 시안의 제목을 그대로 쓴다", () => {
    const screen = render(read);

    expect(screen.querySelector(".session__title")?.textContent).toBe("Source control");
  });

  /** 브랜치 줄은 사실이지 문이 아니다 — 전환은 노트북에서 한다. */
  it("브랜치 줄은 버튼이 아니다", () => {
    const screen = render(read);

    expect(screen.querySelector(".scm__branch")?.tagName).toBe("DIV");
    expect(screen.querySelector(".scm__push")).toBeNull();
  });

  /**
   * 목록은 스크롤러의 자식이고, 스크롤러는 세로 flex 다. 줄어드는 채로 자기
   * 넘침까지 잘라 내면 스크롤할 것이 남지 않는다 — 그것이 파일 14개 중 12개만
   * 그려지던 이유다(2026-09-03). 카드가 아닌 상자에 담는 것이 그 잘라내기를
   * 없앤다.
   */
  it("목록은 스크롤러의 자식이고 카드가 아니다", () => {
    const screen = render(read);

    const body = screen.querySelector(".scm__body");
    const list = screen.querySelector(".scm__list");
    expect(list?.parentElement).toBe(body);
    expect(list?.classList.contains("scm__files")).toBe(false);
  });
});

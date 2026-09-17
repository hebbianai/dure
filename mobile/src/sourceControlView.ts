/**
 * Source control — what the session header's git button opens.
 * Figma `dure-UI` 3042:80841.
 *
 * # One screen: the changes, and a commit
 *
 * The owner cut this surface down to two things (2026-09-04): see what changed,
 * and commit some of it. The tabs, the commit list and its detail, the branch
 * switcher, push and the pull-request form are gone — a branch is switched
 * and pushed from a laptop, where the consequences are visible. What is left
 * is the frame above, drawn as it stands: the branch card, the rows, and the
 * commit button.
 *
 * # Why the list sits on the pane
 *
 * The mockup draws its rows straight onto `glass/pane`: no card, no
 * separators, just 40px rows for files. The card is spent on the one thing
 * that is not a list — the branch.
 *
 * # What the rows can and cannot do
 *
 * Every *read* has a wire: the branch rides the pushed sidebar layout, and the
 * files, their ±line counts and ahead/behind come back from `hub_git_status`.
 * A row opens that file's patch on its own screen (`hub_file_diff`,
 * `fileDiffView.ts`).
 *
 * A checkbox stands only on a row that has something to commit — the list is a
 * comparison against the base ref, so it carries files already committed on
 * this branch, and those have nothing to stage. The status letter takes the
 * column instead: it is a fact, where a greyed checkbox would read as "not
 * ticked" for a row nobody could tick.
 */

import iconChevronLeft from "./assets/icon-chevron-left.svg";
import iconChevronRight from "./assets/icon-chevron-right.svg";
import iconGitBranch from "./assets/icon-git-branch.svg";
import iconRefreshCw from "./assets/icon-refresh-cw.svg";
import { element, fadeWhileScrollable, glyph, loader } from "./dom";
import type { SourceControlOutcome } from "./ipc";
import { t } from "./i18n";

/** One changed file, as the laptop reported it. */
export interface ChangedFile {
  readonly path: string;
  /** git name-status 첫 글자: A/M/D/R/C/T. */
  readonly status: string;
  /** 옮겨진 파일의 원래 경로. 없으면 옮긴 게 아니다. */
  readonly oldPath?: string;
  /** Absent for a binary file. Not zero — nobody counted, rather than none. */
  readonly added?: number;
  readonly deleted?: number;
  /**
   * 아직 커밋되지 않은 변경이 이 파일에 있나.
   *
   * 없으면 **안 물어봤다** 는 뜻이다. 목록은 기준 브랜치와의 비교라 이미 커밋된
   * 파일도 들어 있고, 커밋하거나 되돌릴 수 있는지는 HEAD 와의 비교가 답하는
   * 다른 질문이다. 이 값이 참인 줄에만 체크박스가 선다.
   */
  readonly uncommitted?: boolean;
}

/**
 * What the laptop said about this session's repository.
 *
 * `read` with an empty list is a clean worktree; `failed` is a laptop that
 * could not answer. Collapsing the two would show "nothing changed" for a
 * session whose changes simply did not arrive, which is the one wrong answer
 * this screen must never give.
 */
export type SourceControlChanges =
  | { readonly kind: "loading" }
  | {
      readonly kind: "read";
      readonly files: readonly ChangedFile[];
      /** 그 순간 읽은 브랜치. 배치표의 캐시를 이긴다. */
      readonly branch?: string;
      /**
       * 파일 목록을 실제로 읽었나. 쓰기의 답은 파일을 싣지 않을 수 있으므로,
       * 거짓이면 브랜치 카드는 개수를 주장하지 않는다.
       */
      readonly filesRead?: boolean;
      readonly ahead?: number;
      readonly behind?: number;
      /** The branch this one forked from. */
      readonly baseRef?: string;
    }
  | {
      readonly kind: "failed";
      readonly detail: string;
      /** 목록은 못 읽었어도 브랜치는 읽었을 수 있다. 그건 버릴 이유가 없다. */
      readonly branch?: string;
    };

export interface SourceControlModel {
  /** The session this is about — its title rides the breadcrumb. */
  readonly title: string;
  /** The branch, when the laptop said so. Absent is a real answer. */
  readonly branch?: string;
  /** The file list, or why there is not one yet. */
  readonly changes: SourceControlChanges;
  /**
   * Which files are ticked for the next commit. Paths, as the list gave them.
   *
   * Presentation state and nothing else — nothing is staged in git until the
   * commit itself runs, so leaving this screen loses a selection and stages
   * nothing. That is the point: an index left half-staged by a phone is a
   * surprise waiting on somebody's desk.
   */
  readonly selection?: ReadonlySet<string>;
  /** A change is in flight. Controls that would start a second one are dead. */
  readonly busy?: boolean;
}

/**
 * The laptop's answer, in the shape this screen draws.
 *
 * One conversion and one only: `null` from the phone's Rust boundary means
 * *nobody counted* — a binary file — and it has to become an **absent** count
 * here, or a row renders `+null` (and, if it were mapped to 0, the worse
 * `+0 −0`, which reads as "unchanged" for a file that changed).
 */
export function changesFromOutcome(outcome: SourceControlOutcome): SourceControlChanges {
  if (!outcome.read) {
    if (outcome.code === "unsupported_protocol_version") {
      // 다시 눌러도 달라지지 않는다. 할 일은 그 상자의 hmux 를 갱신하는 것이고,
      // 그 문장을 그대로 말한다.
      return {
        kind: "failed",
        detail: t("이 상자의 hmux가 오래되어 변경 목록을 읽지 못합니다"),
        ...(outcome.branch === null ? {} : { branch: outcome.branch }),
      };
    }
    // `||` 다. 빈 문자열도 이유가 아니다 — `??` 로 두면 이 대체 문장이 존재하는
    // 바로 그 경우(이유 없는 거절)에 빈 줄이 그려진다.
    return {
      kind: "failed",
      detail: outcome.detail || t("노트북이 이유를 말하지 않았습니다"),
      ...(outcome.branch === null ? {} : { branch: outcome.branch }),
    };
  }
  return {
    kind: "read",
    ...(outcome.files_read ? { filesRead: true } : {}),
    files: outcome.files.map((file) => ({
      path: file.path,
      status: file.status,
      ...(file.old_path === null ? {} : { oldPath: file.old_path }),
      ...(file.added === null ? {} : { added: file.added }),
      ...(file.deleted === null ? {} : { deleted: file.deleted }),
      // `null` 은 거짓이 아니다 — 안 물어본 것이다. 없는 채로 두면 화면이
      // 체크박스를 안 그리고, 그것이 "커밋할 게 없다" 와 다른 답이다.
      ...(file.uncommitted === null ? {} : { uncommitted: file.uncommitted }),
    })),
    ...(outcome.branch === null ? {} : { branch: outcome.branch }),
    ...(outcome.ahead === null ? {} : { ahead: outcome.ahead }),
    ...(outcome.behind === null ? {} : { behind: outcome.behind }),
    ...(outcome.base_ref === null ? {} : { baseRef: outcome.base_ref }),
  };
}

export interface SourceControlActions {
  readonly back: () => void;
  readonly refresh: () => void;
  /**
   * 파일 하나를 연다.
   *
   * 없으면 줄은 눌리지 않는다 — 이 화면이 세 답 경로를 가지고 있고, 그중
   * 패치를 물을 수 없는 경로가 생기면 그 목록의 줄은 버튼처럼 보이지
   * 않아야 한다.
   */
  readonly openFile?: (file: ChangedFile) => void;
  /**
   * Tick or untick one file.
   *
   * Absent when this answer path cannot commit at all — a session on a box
   * this phone only reaches over SSH. Then no checkbox is drawn, which is the
   * honest shape: the control would have nothing to do.
   */
  readonly toggleFile?: (path: string) => void;
  /** Tick every file that can be committed, or clear the selection. */
  readonly toggleAll?: () => void;
  /** Commit what is ticked. The screen collects the message first. */
  readonly commit?: () => void;
}

/**
 * The branch to print.
 *
 * What the laptop just read wins over what the sidebar layout pushed earlier:
 * the pushed value is a cache that holds nothing for a terminal pane and
 * nothing for an agent made in an existing checkout, and is a creation-time
 * snapshot for the rest. The cache still fills the gap while the request is out.
 */
function liveBranch(model: SourceControlModel): string | undefined {
  if (model.changes.kind !== "loading" && model.changes.branch) return model.changes.branch;
  return model.branch;
}

/** The glass header: back, title, the branch under it, and refresh. */
function header(model: SourceControlModel, actions: SourceControlActions): HTMLElement {
  const bar = element("header", "session__header");

  const back = element("button", "icon-tap");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.append(glyph(iconChevronLeft, 20));
  back.addEventListener("click", actions.back);
  bar.append(back);

  const text = element("div", "session__heading");
  // "Source control", in English, on the Korean screen too: the frame
  // (3042:80841) writes the title the way it writes `2 ahead` — as the git
  // term — and the owner asked for the header exactly as drawn (2026-09-04).
  // Not through `t()`: a key in English is the same string in every locale,
  // and wrapping it would only pretend to follow the Korean-source rule.
  text.append(element("h1", "session__title", "Source control"));
  // The mockup writes "worktree/card-tokens · 2 ahead". The second half appears
  // only once a count has actually arrived — a header that says "0 ahead" while
  // the request is still out is a claim, not a placeholder.
  // 시안은 이 세 조각(`2 ahead`, `0 behind`, `14 changed`)을 한국어 화면에서도
  // 영어 git 용어 그대로 쓴다. `t()` 로 감싸면 한국어 원문 규칙을 지키는 척만
  // 하게 된다 — 키가 영어라 어느 로케일에서도 같은 문자열이 나온다.
  const facts = [liveBranch(model) ?? model.title];
  if (model.changes.kind === "read" && model.changes.ahead !== undefined) {
    facts.push(`${model.changes.ahead} ahead`);
  }
  const details = element("p", "session__details");
  details.append(element("span", "session__detail", facts.join(" · ")));
  text.append(details);
  bar.append(text);

  const icons = element("div", "session__icons");
  const refresh = element("button", "icon-tap");
  refresh.type = "button";
  refresh.setAttribute("aria-label", t("새로고침"));
  refresh.append(glyph(iconRefreshCw, 20));
  refresh.addEventListener("click", actions.refresh);
  icons.append(refresh);
  bar.append(icons);
  return bar;
}

/**
 * The branch card. Figma 3042:80841 — the owner's pick over the blocked-banner
 * variant in 81248.
 *
 * The mockup fills it with five facts. Four now arrive; the fifth (the PR row)
 * is drawn but inert. A slot whose value has not come back stays empty rather
 * than holding a plausible number — "0 behind" and "14 changed" are each a
 * claim about a repository, and a wrong one is worse here than a missing one.
 */
function branchCard(model: SourceControlModel): HTMLElement {
  const card = element("div", "scm__card");

  const branch = liveBranch(model);
  const changes = model.changes;
  // A fact, not a control: switching branches left this screen with the rest
  // of the git surface (2026-09-04), so the row is a `<div>` — a button that
  // does nothing reads as an app that has stopped.
  const row = element("div", "scm__branch");
  row.append(glyph(iconGitBranch, 16));
  // 브랜치가 없을 때 그 이유를 아는 경우가 있다. 다섯 가지 원인에 같은 한 문장을
  // 쓰면, 다음에 이 화면을 보는 사람은 무엇을 해야 하는지 알 수 없다.
  const missing =
    changes.kind === "failed" ? changes.detail : t("브랜치를 아직 받지 못했습니다");
  const name = element("span", "scm__branch-name", branch ?? missing);
  if (branch === undefined) name.classList.add("scm__branch-name--missing");
  row.append(name);
  if (changes.kind === "read" && changes.ahead !== undefined && changes.behind !== undefined) {
    row.append(
      element("span", "scm__branch-track", `${changes.ahead} ahead, ${changes.behind} behind`),
    );
  }
  card.append(row);

  if (changes.kind === "read") {
    const facts: string[] = [];
    if (changes.baseRef) facts.push(t("{base}에서 분기", { base: changes.baseRef }));
    // 읽은 목록만 개수를 말한다. 파일을 싣지 않은 답의 빈 목록으로 "0 changed"
    // 를 그리면 더러운 워크트리 위에 깨끗하다고 쓰게 된다 — 읽지도 않은 것에
    // 대한 주장이다.
    if (changes.filesRead) facts.push(`${changes.files.length} changed`);
    if (facts.length > 0) {
      // 낱말 사이 공백으로 벌리면 HTML 이 접어서 한 문장처럼 붙는다. 시안
      // (3042:80841)은 둘을 눈에 띄게 떼어 놓는다 — 서로 다른 사실이고, 붙여
      // 놓으면 "main에서 분기 3 changed" 가 한 구절로 읽힌다.
      const line = element("p", "scm__branch-facts");
      for (const fact of facts) line.append(element("span", undefined, fact));
      card.append(line);
    }
  }
  return card;
}

interface FileRowOptions {
  readonly open?: (file: ChangedFile) => void;
  /** Absent when this file cannot be selected — then no checkbox is drawn. */
  readonly toggle?: () => void;
  readonly selected: boolean;
  readonly busy: boolean;
}

function fileRow(file: ChangedFile, options: FileRowOptions): HTMLElement {
  const row = element("div", `scm__file scm__file--${file.status.toLowerCase()}`);

  // Figma 3043:81248 은 체크박스를 상태 글자 자리에 둔다. 고를 수 없는 줄에는
  // 글자가 그대로 서고, 그 글자는 진짜 사실이다 — 회색 체크박스를 두면
  // "안 골랐다" 로 읽히는데 실제로는 "고를 수 없다" 다.
  if (options.toggle) {
    const box = element("input", "scm__check");
    box.type = "checkbox";
    box.checked = options.selected;
    box.disabled = options.busy;
    box.setAttribute("aria-label", file.path);
    box.addEventListener("change", () => options.toggle?.());
    row.append(box);
  } else {
    row.append(element("span", "scm__file-status", file.status));
  }

  // 경로를 누르면 파일이 열린다. 체크박스와 다른 일이라 다른 표적이다 —
  // 하나로 묶으면 diff 를 보려던 누름이 선택을 바꾼다.
  const target = options.open
    ? element("button", "scm__file-open")
    : element("div", "scm__file-open");
  if (options.open) {
    (target as HTMLButtonElement).type = "button";
    target.addEventListener("click", () => options.open?.(file));
  }

  const path = element("span", "scm__file-path");
  if (file.oldPath !== undefined) {
    // 목적지만 그리면 추가와 똑같이 보인다. 무엇이 어디서 왔는지가 그 줄의 전부다.
    path.append(element("span", "scm__file-from", file.oldPath));
    path.append(element("span", "scm__file-arrow", " → "));
  }
  path.append(element("span", "scm__file-name", file.path));
  target.append(path);
  const counts = element("span", "scm__file-counts");
  if (file.added !== undefined) counts.append(element("span", "scm__file-added", `+${file.added}`));
  if (file.deleted !== undefined) {
    counts.append(element("span", "scm__file-deleted", `\u2212${file.deleted}`));
  }
  target.append(counts);
  if (options.open) {
    const chevron = glyph(iconChevronRight, 16);
    chevron.classList.add("scm__file-chevron");
    target.append(chevron);
  }
  row.append(target);
  return row;
}

/**
 * "14개 중 3개 포함" — 목록 위의 줄. Figma 3043:81248.
 *
 * 체크박스는 세 상태다: 아무것도 안 골랐다 / 다 골랐다 / 일부. 셋째를 `checked`
 * 로 그리면 누르는 사람은 전체 해제를 기대하는데, 실제로는 나머지를 다 고르는
 * 것이 이 자리의 동작이다. `indeterminate` 가 그 차이를 말한다.
 */
function selectionHeader(
  selectable: readonly ChangedFile[],
  total: number,
  selection: ReadonlySet<string>,
  actions: SourceControlActions,
  busy: boolean,
): HTMLElement {
  const bar = element("div", "scm__select");
  const box = element("input", "scm__check");
  box.type = "checkbox";
  const chosen = selectable.filter((file) => selection.has(file.path)).length;
  box.checked = chosen > 0 && chosen === selectable.length;
  box.indeterminate = chosen > 0 && chosen < selectable.length;
  box.disabled = busy || selectable.length === 0;
  box.setAttribute("aria-label", t("모두 포함"));
  box.addEventListener("change", () => actions.toggleAll?.());
  bar.append(box);
  bar.append(
    element("span", "scm__select-label", t("{total}개 중 {chosen}개 포함", { total, chosen })),
  );
  return bar;
}

/** The file list, the empty repository, or the reason there is neither. */
function changeList(
  changes: SourceControlChanges,
  open: ((file: ChangedFile) => void) | undefined,
  toggle: ((path: string) => void) | undefined,
  selection: ReadonlySet<string>,
  busy: boolean,
): HTMLElement {
  if (changes.kind === "loading") {
    const box = element("div", "scm__pending");
    box.append(loader(16));
    box.append(element("p", "scm__pending-title", t("변경 사항을 읽는 중")));
    return box;
  }
  if (changes.kind === "failed") {
    const box = element("div", "scm__pending");
    box.append(element("p", "scm__pending-title", t("변경 사항을 읽지 못했습니다")));
    // The laptop's own sentence, not a rewrite of it: "그 세션을 못 찾았다" and
    // "git 이 실패했다" call for different next moves.
    box.append(element("p", "scm__pending-note", changes.detail));
    return box;
  }
  if (changes.files.length === 0) {
    const box = element("div", "scm__pending");
    box.append(element("p", "scm__pending-title", t("변경된 파일이 없습니다")));
    return box;
  }
  const list = element("div", "scm__list");
  for (const file of changes.files) {
    list.append(
      fileRow(file, {
        ...(open === undefined ? {} : { open }),
        // 체크박스는 커밋할 것이 있는 줄에만 선다. 이미 커밋된 파일은 목록에
        // 남아 있지만(기준 브랜치와의 비교라) 커밋할 것이 없고, 고르게 두면
        // 선택 전체가 거절된다.
        ...(toggle && file.uncommitted === true
          ? { toggle: () => toggle(file.path) }
          : {}),
        selected: selection.has(file.path),
        busy,
      }),
    );
  }
  return list;
}

function footerWith(control: HTMLElement): HTMLElement {
  const footer = element("div", "prform__footer");
  footer.append(control);
  return footer;
}

export function renderSourceControl(
  model: SourceControlModel,
  actions: SourceControlActions,
): HTMLElement {
  const screen = element("div", "session scm");
  screen.append(header(model, actions));

  const body = element("div", "scm__body");
  // The start only: the docked footer draws its own fade over the foot.
  fadeWhileScrollable(body, { start: "scroll-fade--start" }, "y");
  body.append(branchCard(model));
  const selection = model.selection ?? new Set<string>();
  const busy = model.busy === true;
  const selectable = committable(model.changes);
  // 고를 수 있는 줄이 하나도 없으면 머리줄도 없다. "14개 중 0개 포함" 은
  // 고를 수 있다는 뜻으로 읽히는데, 그 화면에서는 아무것도 고를 수 없다.
  const list = changeList(model.changes, actions.openFile, actions.toggleFile, selection, busy);
  // Inside the list, not above it: the header is the first row of the list it
  // counts, on the rows' own column and rhythm, rather than a bar with the
  // body's gap and its own inset between it and the first file (2026-09-15
  // 승연: the space between 전체 선택 and the first row read as wrong).
  if (actions.toggleFile && selectable.length > 0 && model.changes.kind === "read") {
    list.prepend(
      selectionHeader(selectable, model.changes.files.length, selection, actions, busy),
    );
  }
  body.append(list);
  screen.append(body);
  const footer = commitFooter(model, actions);
  if (footer) screen.append(footer);
  return screen;
}

/** The files a commit could actually include. */
function committable(changes: SourceControlChanges): readonly ChangedFile[] {
  if (changes.kind !== "read") return [];
  return changes.files.filter((file) => file.uncommitted === true);
}

/**
 * "3개 파일 커밋" — Figma 3042:80841 의 아래 버튼.
 *
 * 고른 것이 없으면 없다. 회색 버튼을 두면 눌러도 아무 일이 없는 컨트롤이 되고,
 * 그건 앱이 멈춘 것처럼 읽힌다 — 목록 위의 머리줄이 이미 무엇을 해야 하는지
 * 말하고 있다.
 */
function commitFooter(
  model: SourceControlModel,
  actions: SourceControlActions,
): HTMLElement | undefined {
  if (!actions.commit) return undefined;
  const chosen = model.selection?.size ?? 0;
  if (chosen === 0) return undefined;
  const button = element(
    "button",
    "pair-button pair-button--solid pair-button--block",
    t("{count}개 파일 커밋", { count: chosen }),
  );
  button.type = "button";
  button.disabled = model.busy === true;
  button.addEventListener("click", () => actions.commit?.());
  return footerWith(button);
}

// 워크트리 에이전트 생성의 순수 계획 로직 (hebbian-frontend-qvu).
//
// 에이전트 추가 다이얼로그는 "브랜치 × 위치"를 명시적으로 다룬다: 새 브랜치(기준 ref에서
// 딴다) / 기존 브랜치 이어서. 이미 존재하는 linked worktree의 reuse는 이
// planner가 암묵적으로 결정하지 않고 exact-ref selector가 별도로 승인한다. 이 모듈은
// PTY·Tauri·git 없이 repo 상태(브랜치·워크트리 목록)와 사용자 입력만으로
// "무엇을 할지(action)"와 "충돌 신호"를 계산한다. 실제 git은 store/백엔드가 이
// 계획을 받아 실행한다.

import { t } from "@/lib/i18n";

/** 사용자가 고른 브랜치 운용 방식. `existing`은 이미 있는 브랜치를 재사용한다. */
export type WorktreeMode = "new-branch" | "existing-branch";

export interface BranchInfo {
  /** 예: "agent/refactor-auth", "main" */
  name: string;
  /** 이 브랜치가 현재 체크아웃돼 있는 워크트리 경로 (없으면 어디에도 안 붙음) */
  checkedOutAt?: string;
}

export interface WorktreeSummary {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface WorktreePlanInput {
  repoPath: string;
  /** 에이전트 이름 — 기본 브랜치 이름 파생용 */
  agentName: string;
  /** 사용자가 입력/선택한 브랜치 이름 */
  branch: string;
  mode: WorktreeMode;
  /** 새 브랜치를 딸 기준 ref (mode=new-branch 일 때만 의미) */
  baseRef?: string;
  branches: readonly BranchInfo[];
  worktrees: readonly WorktreeSummary[];
  /** 워크트리를 담을 디렉터리(레포 기준 상대). 생략하면 기존 관례 `.worktrees/`.
   *
   *  시안 2256:29177이 이걸 고르게 한다. 기본값을 바꾸지 않는 이유는 이미
   *  만들어진 워크트리가 전부 `.worktrees/` 아래 있기 때문이다 — 기본을 옮기면
   *  같은 레포에서 목록이 두 곳으로 갈린다. */
  worktreeRoot?: string;
}

/** 계획이 실행할 구체 행동. */
export type WorktreeAction =
  /** 기준 ref에서 새 브랜치를 만들어 새 워크트리에 체크아웃 */
  | "create-new-branch"
  /** 이미 있는 브랜치를 새 워크트리에 체크아웃 */
  | "checkout-existing-branch"
  /** 그 브랜치를 이미 쓰고 있는 기존 워크트리를 그대로 붙인다(생성 안 함) */
  | "adopt-worktree";

/** 진행을 막는 문제 — 이게 있으면 "에이전트 시작"을 비활성화한다. */
type WorktreeBlocker =
  | { kind: "empty-branch" }
  /** mode=new인데 그 브랜치가 이미 존재 → 기존 브랜치 모드로 바꾸거나 이름 변경 */
  | { kind: "branch-exists"; branch: string }
  /** mode=existing인데 그 브랜치가 없음 */
  | { kind: "no-such-branch"; branch: string }
  /** 그 브랜치가 기본 체크아웃에 물려 있어 격리 워크트리를 만들 수 없음 */
  | { kind: "branch-in-main-worktree"; branch: string }
  /** linked worktree reuse는 exact selector에서 명시적으로 선택해야 함 */
  | { kind: "existing-worktree-requires-explicit-selection"; path: string }
  /** 파생 워크트리 경로가 primary checkout에 이미 점유됨 → 이름 변경 */
  | { kind: "worktree-path-taken"; path: string; occupiedBy: string };

export interface WorktreePlan {
  branch: string;
  mode: WorktreeMode;
  action: WorktreeAction;
  /** 새로 만들거나 붙일 워크트리 경로 */
  worktreePath: string;
  /** 이 계획이 쓴 워크트리 루트(레포 기준 상대). 백엔드가 경로를 재조립하므로
   *  실행 요청에 그대로 실어 보내야 한다 — 빼면 백엔드 기본값으로 되돌아간다. */
  worktreeRoot?: string;
  /** mode=new-branch 일 때 기준 ref */
  baseRef?: string;
  /** 이 브랜치가 이미 존재하는가 */
  branchExists: boolean;
  /** 이 브랜치를 이미 쓰고 있는 워크트리 (있으면 adopt 후보) */
  adoptable?: WorktreeSummary;
  /** 파생 경로에 이미 있는 (다른 브랜치의) 워크트리 */
  pathCollision?: WorktreeSummary;
  /** 진행 불가 사유 (없으면 실행 가능) */
  blocker?: WorktreeBlocker;
}

/** git worktree_command(gitx.rs)의 sanitize와 동일 규칙 — Rust `char::is_alphanumeric()`
 *  (유니코드 Alphabetic ∪ Number)·`-`·`_`만 남기고 나머지는 `-`로. `\p{Alphabetic}`은
 *  결합 표시(Other_Alphabetic)까지 포함해 Rust와 일치한다(`\p{L}`은 그보다 좁다). */
export function sanitizeSegment(input: string): string {
  return [...input]
    .map((ch) => (/[\p{Alphabetic}\p{N}_-]/u.test(ch) ? ch : "-"))
    .join("");
}

/** 에이전트 이름 → 기본 브랜치 이름 (`agent/<sanitize>`). */
export function defaultBranchName(agentName: string): string {
  return `agent/${sanitizeSegment(agentName.trim())}`;
}

/** 브랜치 이름 → 워크트리 디렉토리 이름. 마지막 세그먼트만 취해 sanitize한다
 *  (`agent/refactor-auth` → `refactor-auth`). 접두사만 다른 브랜치들이 같은
 *  폴더로 뭉치지 않도록, 세그먼트가 비면 전체를 sanitize해 폴백한다. */
export function worktreeDirName(branch: string): string {
  const trimmed = branch.trim().replace(/\/+$/, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const dir = sanitizeSegment(last);
  return dir || sanitizeSegment(trimmed);
}

/** 기본 워크트리 루트 — 바꾸면 기존 레포의 워크트리 목록이 갈린다.
 *  UI가 고르는 선택지는 addAgentForm.WORKTREE_ROOTS에 있고, 그쪽 기본값이
 *  이 값과 같은지는 addAgentForm.test.ts가 지킨다. */
const DEFAULT_WORKTREE_ROOT = ".worktrees/";

function joinPath(repoPath: string, dir: string, root?: string): string {
  const base = repoPath.replace(/\/+$/, "");
  // 앞뒤 슬래시를 정규화해 `..` 같은 상대 루트도 한 겹으로 붙는다.
  const normalized = (root ?? DEFAULT_WORKTREE_ROOT).replace(/^\/+|\/+$/g, "");
  const joined = normalized ? `${base}/${normalized}/${dir}` : `${base}/${dir}`;
  // `..`를 문자 그대로 남기면 git worktree list가 주는 정규화된 절대 경로와
  // 문자열 비교가 어긋나 경로 충돌 검사가 통째로 새 나간다(백엔드 gitx.rs의
  // normalize_absolute_path와 같은 규칙).
  return normalizePath(joined);
}

export function defaultWorktreePath(
  repoPath: string,
  directoryName: string,
): string {
  return joinPath(repoPath, directoryName);
}

/** 절대 경로의 `.`/`..`를 접는다 — 심링크는 따지지 않는다(표기 정규화만). */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** A linked checkout is selectable, but the primary checkout is never adoptable. */
function blockerForPathCollision(collision: WorktreeSummary): WorktreeBlocker {
  return collision.isMain
    ? {
        kind: "worktree-path-taken",
        path: collision.path,
        occupiedBy: collision.branch,
      }
    : {
        kind: "existing-worktree-requires-explicit-selection",
        path: collision.path,
      };
}

/** repo 상태 + 사용자 입력 → 실행 계획 + 충돌 신호. 순수 함수. */
export function planWorktree(input: WorktreePlanInput): WorktreePlan {
  const branch = input.branch.trim();
  const dir = worktreeDirName(branch || input.agentName);
  const worktreePath = joinPath(input.repoPath, dir, input.worktreeRoot);

  const branchRecord = input.branches.find((b) => b.name === branch);
  const branchExists = Boolean(branchRecord);
  // 이 브랜치를 이미 쓰고 있는 (기본 체크아웃이 아닌) 워크트리 — adopt 후보.
  // 기본(primary) 체크아웃은 절대 adopt하지 않는다: 에이전트가 사용자의 메인
  // 작업 트리에서 격리 없이 돌아 '한 워크트리 한 에이전트' 불변식을 깨기 때문.
  const adoptable =
    input.worktrees.find((w) => !w.isMain && w.branch === branch) ??
    (branchRecord?.checkedOutAt
      ? input.worktrees.find((w) => !w.isMain && w.path === branchRecord.checkedOutAt)
      : undefined);
  // 이 브랜치가 기본 체크아웃에 물려 있는가 — 격리 워크트리를 만들 수 없다(git도 거부).
  const inMainWorktree = input.worktrees.some((w) => w.isMain && w.branch === branch);
  // 파생 경로를 이미 다른 워크트리가 점유 중인가 (adopt 대상 자신은 제외).
  const pathCollision = input.worktrees.find(
    (w) => w.path === worktreePath && w.path !== adoptable?.path,
  );

  const base: Omit<WorktreePlan, "action" | "blocker"> = {
    branch,
    mode: input.mode,
    worktreePath: adoptable?.path ?? worktreePath,
    worktreeRoot: input.worktreeRoot,
    baseRef: input.mode === "new-branch" ? input.baseRef : undefined,
    branchExists,
    adoptable,
    pathCollision,
  };

  if (!branch) {
    return { ...base, action: "create-new-branch", blocker: { kind: "empty-branch" } };
  }

  if (input.mode === "existing-branch") {
    if (!branchExists) {
      return {
        ...base,
        action: "checkout-existing-branch",
        blocker: { kind: "no-such-branch", branch },
      };
    }
    if (adoptable) {
      return {
        ...base,
        action: "checkout-existing-branch",
        blocker: {
          kind: "existing-worktree-requires-explicit-selection",
          path: adoptable.path,
        },
      };
    }
    if (inMainWorktree) {
      // 기본 체크아웃에 물린 브랜치 — 격리 불가(체크아웃하면 git이 거부).
      return {
        ...base,
        action: "checkout-existing-branch",
        blocker: { kind: "branch-in-main-worktree", branch },
      };
    }
    if (pathCollision) {
      return {
        ...base,
        action: "checkout-existing-branch",
        blocker: blockerForPathCollision(pathCollision),
      };
    }
    return { ...base, action: "checkout-existing-branch" };
  }

  // mode === "new-branch"
  if (branchExists) {
    return {
      ...base,
      action: "create-new-branch",
      blocker: { kind: "branch-exists", branch },
    };
  }
  if (pathCollision) {
    return {
      ...base,
      action: "create-new-branch",
      blocker: blockerForPathCollision(pathCollision),
    };
  }
  return { ...base, action: "create-new-branch" };
}

// --- 에이전트 추가 다이얼로그 뷰 로직 (컴포넌트는 얇게, 로직은 여기서) ---

/** 사용자의 모드 선택. `auto`는 입력한 브랜치의 존재 여부로 new/existing을
 *  자동 판정한다(입력 편집 시 auto로 되돌린다). */
export type WorktreeModeChoice = "auto" | WorktreeMode;

/** auto면 브랜치 존재 여부로 결정, 명시 선택이면 그대로. */
export function resolveMode(
  choice: WorktreeModeChoice,
  branch: string,
  branches: readonly BranchInfo[],
): WorktreeMode {
  if (choice !== "auto") return choice;
  return branches.some((b) => b.name === branch) ? "existing-branch" : "new-branch";
}

/** 새 브랜치의 기본 기준 ref — 메인 워크트리 브랜치 > main > master > HEAD. */
export function defaultBaseRef(
  worktrees: readonly WorktreeSummary[],
  branches: readonly BranchInfo[],
): string {
  const main = worktrees.find((w) => w.isMain)?.branch;
  if (main && main !== "(detached)" && branches.some((b) => b.name === main)) return main;
  if (branches.some((b) => b.name === "main")) return "main";
  if (branches.some((b) => b.name === "master")) return "master";
  return "HEAD";
}

export interface WorktreeDialogInput {
  repoPath: string;
  agentName: string;
  branchInput: string;
  modeChoice: WorktreeModeChoice;
  baseRef: string;
  branches: readonly BranchInfo[];
  worktrees: readonly WorktreeSummary[];
  /** 브랜치·워크트리 목록 로딩 완료 여부 — 미완이면 시작 비활성 */
  loaded: boolean;
  /** 워크트리를 담을 디렉터리(레포 기준 상대). 생략하면 기본값. */
  worktreeRoot?: string;
}

interface WorktreeBanner {
  kind: "explicit-existing" | "branch-exists" | "no-such-branch" | "path-taken" | "empty-branch";
  /** Translated at plan time — planFromDialog runs per render, so the live language applies. */
  message: string;
  /** adopt 가능하면 그 워크트리 경로 */
  adoptPath?: string;
  canRename: boolean;
  severity: "info" | "warn" | "error";
}

export interface WorktreeDialogView {
  effectiveBranch: string;
  resolvedMode: WorktreeMode;
  autoResolved: boolean;
  plan: WorktreePlan;
  branchOptions: string[];
  baseRefOptions: string[];
  showBaseRef: boolean;
  banner?: WorktreeBanner;
  action: WorktreeAction;
  canStart: boolean;
  /** Translated at plan time, like `banner.message`. */
  startLabel: string;
}

function bannerFor(plan: WorktreePlan): WorktreeBanner | undefined {
  const b = plan.blocker;
  if (!b) return undefined;
  switch (b.kind) {
    case "branch-exists":
      return {
        kind: "branch-exists",
        message: t("scm.worktree.branchExists", { branch: b.branch }),
        canRename: true,
        severity: "warn",
      };
    case "no-such-branch":
      return {
        kind: "no-such-branch",
        message: t("scm.worktree.branchMissing", { branch: b.branch }),
        canRename: false,
        severity: "warn",
      };
    case "branch-in-main-worktree":
      return {
        kind: "path-taken",
        message: t("scm.worktree.branchInPrimaryCheckout", { branch: b.branch }),
        canRename: false,
        severity: "error",
      };
    case "existing-worktree-requires-explicit-selection":
      return {
        kind: "explicit-existing",
        message: t("scm.worktree.pathAlreadyLinked", { path: b.path }),
        adoptPath: b.path,
        canRename: true,
        severity: "warn",
      };
    case "worktree-path-taken":
      return {
        kind: "path-taken",
        message: t("scm.worktree.pathOccupied", { path: b.path, branch: b.occupiedBy }),
        canRename: true,
        severity: "error",
      };
    case "empty-branch":
      return {
        kind: "empty-branch",
        message: t("scm.worktree.branchNameRequired"),
        canRename: false,
        severity: "error",
      };
  }
}

/** repo 상태 + 다이얼로그 입력 → 렌더에 필요한 모든 파생값. 순수 함수. */
export function planFromDialog(input: WorktreeDialogInput): WorktreeDialogView {
  const effectiveBranch = input.branchInput.trim() || defaultBranchName(input.agentName);
  const resolvedMode = resolveMode(input.modeChoice, effectiveBranch, input.branches);
  const autoResolved = input.modeChoice === "auto";
  const plan = planWorktree({
    repoPath: input.repoPath,
    agentName: input.agentName,
    branch: effectiveBranch,
    mode: resolvedMode,
    baseRef: input.baseRef,
    branches: input.branches,
    worktrees: input.worktrees,
    worktreeRoot: input.worktreeRoot,
  });

  // adoptable(기본이 아닌 워크트리에 체크아웃된) 브랜치를 앞으로, 그 다음 접두사 필터.
  const adoptable = new Set(input.worktrees.filter((w) => !w.isMain).map((w) => w.branch));
  const query = input.branchInput.trim().toLowerCase();
  const branchOptions = input.branches
    .map((b) => b.name)
    .filter((n) => !query || n.toLowerCase().startsWith(query))
    .sort((a, b) => Number(adoptable.has(b)) - Number(adoptable.has(a)));

  const baseRefOptions = Array.from(
    new Set([
      "HEAD",
      ...(input.branches.some((b) => b.name === "main") ? ["main"] : []),
      ...(input.branches.some((b) => b.name === "master") ? ["master"] : []),
      ...input.branches.map((b) => b.name).filter((n) => n !== "(detached)"),
    ]),
  );

  const banner = bannerFor(plan);
  return {
    effectiveBranch,
    resolvedMode,
    autoResolved,
    plan,
    branchOptions,
    baseRefOptions,
    showBaseRef: resolvedMode === "new-branch",
    banner,
    action: plan.action,
    canStart: input.loaded && !plan.blocker,
    startLabel: t("scm.worktree.startAgent"),
  };
}

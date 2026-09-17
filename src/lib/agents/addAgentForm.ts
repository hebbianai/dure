// 에이전트 추가 다이얼로그(시안 2256:29002 / 2256:29090)의 순수 로직.
//
// 시안은 기존 2단계(WorktreeAgentDialog로 디렉터리 → AddAgentDialog로 나머지)를
// 한 화면으로 합친다. 왼쪽 레일에서 호스트를 고르고, 오른쪽에서 위치·워크트리·
// 에이전트를 한 번에 정한다. 여기 있는 것은 그 화면이 쓰는 계산뿐이고 React·
// Tauri에 의존하지 않는다.

import {
  canonicalAgentNameCandidate,
  uniqueAgentName,
} from "@/lib/agents/agentName";
import { t } from "@/lib/i18n";
import type { WorktreeModeChoice } from "@/lib/scm/worktrees/worktreePlan";
import type { Project, SshHostConfig } from "@/types";

/** 왼쪽 레일 한 줄. id가 null이면 로컬. */
export interface HostOption {
  /** SSH 호스트 id — 로컬은 null */
  id: string | null;
  name: string;
  /** 시안의 배지 숫자 — 그 호스트에 등록된 프로젝트 수(소유자 확인 2026-08-02) */
  projectCount: number;
}

/** 레일 목록: 로컬이 항상 먼저, 그 뒤로 SSH 호스트가 등록 순서대로.
 *
 *  로컬을 목록에서 빼지 않는다 — 시안에는 SSH 호스트만 보이지만 그건 그 프레임의
 *  예시 데이터일 뿐이고, 로컬이 없으면 로컬 프로젝트를 고를 방법이 사라진다. */
export function hostOptions(
  projects: readonly Project[],
  sshHosts: readonly SshHostConfig[],
): HostOption[] {
  const countFor = (hostId: string | null) =>
    projects.filter((project) =>
      hostId === null
        ? project.kind === "local"
        : project.kind === "ssh" && project.sshHostId === hostId,
    ).length;
  return [
    // English literal, not a t() key: HostRail renders the local row with its
    // own t("common.local") literal and never shows this name; SSH names are user data.
    { id: null, name: "Local", projectCount: countFor(null) },
    ...sshHosts.map((host) => ({
      id: host.id,
      name: host.name,
      projectCount: countFor(host.id),
    })),
  ];
}

/** 고른 호스트에 속한 프로젝트만. */
export function projectsForHost(
  projects: readonly Project[],
  hostId: string | null,
): Project[] {
  return projects.filter((project) =>
    hostId === null
      ? project.kind === "local"
      : project.kind === "ssh" && project.sshHostId === hostId,
  );
}

/** 시안의 워크트리 탭. Github만 새 기능이고 나머지 셋은 기존
 *  WorktreeModeChoice에 그대로 대응한다. */
export type WorktreeTab = "smart" | "github" | "branch" | "name";

/** 탭 → 기존 계획 모드.
 *
 *  스마트는 auto다: 입력한 이름이 기존 브랜치면 이어서, 아니면 새로 만든다.
 *  Github 탭은 이슈·PR에서 브랜치 이름을 만들어 내는 것이라, 만들어진 뒤에는
 *  '새 브랜치'와 같다. */
export function modeChoiceForTab(tab: WorktreeTab): WorktreeModeChoice {
  switch (tab) {
    case "branch":
      return "existing-branch";
    case "name":
    case "github":
      return "new-branch";
    default:
      return "auto";
  }
}

/** 탭 라벨 — resolved through t() at call time (never module scope). The
 *  Korean literals are lookup keys; addAgentForm.test.ts keeps them in the
 *  en catalog, since t(변수) call sites escape the i18nCoverage scanner. */
export function worktreeTabLabel(tab: WorktreeTab): string {
  switch (tab) {
    case "smart":
      return t("agents.branch.smart");
    case "github":
      return "Github";
    case "branch":
      return t("common.branch");
    default:
      return t("common.name");
  }
}

/** 탭별 검색 입력 placeholder — 시안은 스마트 탭 문구만 보여 준다.
 *  Resolved through t() at call time, same contract as worktreeTabLabel. */
export function searchPlaceholderForTab(tab: WorktreeTab): string {
  switch (tab) {
    case "github":
      return "#1234 · GitHub URL";
    case "branch":
      return t("agents.branch.namePlaceholder");
    case "name":
      return t("agents.branch.newNamePlaceholder");
    default:
      return t("agents.branch.githubSearchPlaceholder");
  }
}

/** 워크트리를 담을 디렉터리(레포 기준 상대). 시안 고급의 '워크트리 위치'.
 *
 *  기존 동작은 `.worktrees/` 하나뿐이었고 그 값이 worktreePlan.joinPath에
 *  박혀 있었다. 선택지를 열되 기본값은 그대로 둔다 — 이미 만들어진 워크트리가
 *  전부 그 아래 있으므로 기본을 바꾸면 기존 레포에서 목록이 갈린다. */
export const WORKTREE_ROOTS = [".worktrees/", ".claude/worktrees/", "../"] as const;
export type WorktreeRoot = (typeof WORKTREE_ROOTS)[number];
export const DEFAULT_WORKTREE_ROOT: WorktreeRoot = ".worktrees/";

/** Omission inherits the revisioned backend default; the other choices are
 * explicit one-run overrides. */
export type AgentPermission = "inherit" | "ask" | "write";

export type AgentPermissionOverride =
  | "require_approvals"
  | "bypass_approvals";

export function permissionToOverride(
  permission: AgentPermission,
): AgentPermissionOverride | undefined {
  if (permission === "ask") return "require_approvals";
  if (permission === "write") return "bypass_approvals";
  return undefined;
}

export function permissionToSkipPermissions(
  permission: AgentPermission,
  inherited = false,
): boolean {
  return permission === "inherit" ? inherited : permission === "write";
}

/** 최근 위치 칩 — 시안의 '최근' 줄.
 *
 *  프로젝트를 최근 쓴 순서로 주되, 지금 고른 호스트의 것만 남기고 상한을 둔다.
 *  usedAt이 없는 저장본(구버전 persist)은 뒤로 민다. */
export function recentProjectChips(
  projects: readonly Project[],
  hostId: string | null,
  usedAtById: Readonly<Record<string, number | undefined>>,
  limit = 4,
): Project[] {
  return projectsForHost(projects, hostId)
    .slice()
    .sort((a, b) => (usedAtById[b.id] ?? 0) - (usedAtById[a.id] ?? 0))
    .slice(0, limit);
}

/** Agent display name for a worktree-isolated add.
 *
 *  When the user typed an explicit branch/worktree name in the dialog, that
 *  is the name they think of the agent by — naming the registration
 *  "claude-26" while the pane and worktree say "darwin" splits one agent
 *  into two identities in the sidebar (2026-08-04 report). Slashes are
 *  flattened because CLI addressing uses "project/name", and collisions get
 *  a numeric suffix so registry names stay unambiguous. */
export function deriveAgentName(input: {
  autoName: string;
  branch: string | undefined;
  branchWasTyped: boolean;
  takenNames: readonly string[];
}): string {
  if (!input.branchWasTyped || !input.branch) return input.autoName;
  const base = canonicalAgentNameCandidate(input.branch);
  return base ? uniqueAgentName(base, input.takenNames) : input.autoName;
}

/** The form only gates values that it owns synchronously. Runtime admission
 * belongs to the launch boundary. */
export function canSubmit(input: {
  project: Project | null;
  name: string;
  worktreePlanReady: boolean;
  busy: boolean;
}): boolean {
  if (input.busy) return false;
  if (!input.project) return false;
  if (!input.name.trim()) return false;
  return input.worktreePlanReady;
}

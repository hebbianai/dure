const DURE_INTERNAL_REF_NAMESPACES = [
  "dure-candidates",
  "dure-landing-control",
  "dure-landing-stacks",
] as const;

/** `git log --all`에서 제품 히스토리와 분리할 protocol/storage refs. */
const INTERNAL_GIT_LOG_REF_GLOBS = [
  ...DURE_INTERNAL_REF_NAMESPACES.flatMap((namespace) => [
    `refs/heads/${namespace}/**`,
    `refs/remotes/*/${namespace}/**`,
  ]),
  "refs/heads/__dolt_remote_info__",
  "refs/remotes/*/__dolt_remote_info__",
  "refs/dolt/**",
  "refs/hebbian-wip/**",
] as const;

export interface ProductGitBranches {
  current: string;
  local: string[];
  remote: string[];
}

export interface GitRefBadgeGroup {
  visible: string[];
  hidden: string[];
}

const MAX_VISIBLE_GIT_REF_BADGES = 3;

/** CommitGraph 한 행의 ref 순서를 보존하면서 남는 badge를 `+N`으로 접는다. */
export function groupGitRefBadges(
  refs: readonly string[],
  visibleLimit = MAX_VISIBLE_GIT_REF_BADGES,
): GitRefBadgeGroup {
  const limit = Math.max(0, Math.floor(visibleLimit));
  return {
    visible: refs.slice(0, limit),
    hidden: refs.slice(limit),
  };
}

interface GitGraphCommit {
  hash: string;
  subject: string;
  refs: string[];
  parents: string[];
}

const LANDING_CONTROL_TRANSITION_SUBJECT = /^Dure landing control transition \d+$/;

function isDureInternalBranchPath(path: string): boolean {
  return DURE_INTERNAL_REF_NAMESPACES.some(
    (namespace) => path === namespace || path.startsWith(`${namespace}/`),
  );
}

/** Full ref 이름 기준. 일반 사용자 branch의 우연한 중간 문자열은 숨기지 않는다. */
export function isInternalGitRef(ref: string): boolean {
  if (ref === "refs/heads/__dolt_remote_info__") return true;
  if (ref.startsWith("refs/dolt/") || ref.startsWith("refs/hebbian-wip/")) return true;

  const local = ref.match(/^refs\/heads\/(.+)$/)?.[1];
  if (local) return isDureInternalBranchPath(local);

  const remote = ref.match(/^refs\/remotes\/[^/]+\/(.+)$/)?.[1];
  if (!remote) return false;
  return remote === "__dolt_remote_info__" || isDureInternalBranchPath(remote);
}

/** `--decorate=full`의 `%D` 항목을 사용자 표시 이름으로 정규화한다. */
export function productGitDecoration(name: string): string | null {
  const normalized = name.trim().replace(/^HEAD -> /, "").replace(/^tag: /, "");
  if (!normalized || isInternalGitRef(normalized)) return null;
  if (normalized.startsWith("refs/heads/")) return normalized.slice("refs/heads/".length);
  if (normalized.startsWith("refs/remotes/")) return normalized.slice("refs/remotes/".length);
  if (normalized.startsWith("refs/tags/")) return normalized.slice("refs/tags/".length);
  return normalized;
}

/** Exclusion은 다음 `--all`에만 적용된다. 순서를 바꾸면 내부 refs가 다시 노출된다. */
export function productGitLogRevisionArgs(): string[] {
  return [
    ...INTERNAL_GIT_LOG_REF_GLOBS.map((pattern) => `--exclude=${pattern}`),
    "--all",
  ];
}

/** 내부 history가 raw row budget을 채워도 요청한 제품 commit 수를 확보한다. */
export function productGitLogReadLimit(limit: number): number {
  const requested = Math.max(0, Math.floor(limit));
  return Math.min(requested * 5, 2_000);
}

/**
 * 과거 control-ref 오병합이 main의 추가 부모로 남긴 metadata subgraph를 끊는다.
 * 단일-parent 제품 history는 제목이 같아도 보존하므로 subject-only 필터가 아니다.
 */
export function productGitCommitGraph<T extends GitGraphCommit>(
  commits: T[],
  limit: number,
): T[] {
  if (limit <= 0) return [];
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const reachable = new Set<string>();
  const pending = commits.filter((commit) => commit.refs.length > 0).map((commit) => commit.hash);

  // Decoration 관측이 깨져도 그래프 전체를 비우지는 않는다.
  if (pending.length === 0) return commits.slice(0, limit);

  while (pending.length > 0) {
    const hash = pending.pop();
    if (!hash || reachable.has(hash)) continue;
    const commit = byHash.get(hash);
    if (!commit) continue;
    reachable.add(hash);

    for (const parentHash of commit.parents) {
      const parent = byHash.get(parentHash);
      const internalMergeParent =
        commit.parents.length > 1 &&
        parent !== undefined &&
        LANDING_CONTROL_TRANSITION_SUBJECT.test(parent.subject);
      if (!internalMergeParent) pending.push(parentHash);
    }
  }

  return commits
    .filter((commit) => reachable.has(commit.hash))
    .map((commit) => ({
      ...commit,
      parents: commit.parents.filter((parent) => !byHash.has(parent) || reachable.has(parent)),
    }))
    .slice(0, limit);
}

/** `git branch -a --format=%(HEAD)%(refname)` 결과를 제품 branch 목록으로 변환. */
export function parseProductGitBranches(stdout: string): ProductGitBranches {
  const result: ProductGitBranches = { current: "", local: [], remote: [] };

  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    const head = raw.startsWith("*");
    const ref = raw.slice(1).trim();
    if (!ref || isInternalGitRef(ref)) continue;

    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      result.local.push(name);
      if (head) result.current = name;
      continue;
    }

    if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (!name.endsWith("/HEAD")) result.remote.push(name);
    }
  }

  return result;
}

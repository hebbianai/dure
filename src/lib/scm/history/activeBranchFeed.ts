// SCM 창 "가장 활발한 브랜치" 피드의 순수 로직 (l36t v1).
// 멀티에이전트 trunk-push 구조에서 main의 실시간 전진을 보이게 한다.
// 기본 브랜치(origin/HEAD)를 디폴트로 하되, 최근 활동이 더 높은 원격
// 브랜치가 있으면 자동 전환하고 선택 기준을 라벨로 드러낸다(설계 합의).

export interface BranchActivity {
  /** 원격 ref 짧은 이름 (예: origin/main) */
  ref: string;
  /** 마지막 커밋 committerdate (unix 초) */
  lastCommitUnix: number;
  /** 최근 1시간 커밋 수 (조회한 후보만 채워진다) */
  recentCount?: number;
}

/** `for-each-ref --format=%(refname:short)%09%(committerdate:unix)` 출력 파싱.
 *  origin/HEAD(심볼릭)는 후보에서 제외한다. */
export function parseForEachRef(output: string): BranchActivity[] {
  const rows: BranchActivity[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [ref, unix] = line.split("\t");
    if (!ref || ref.endsWith("/HEAD")) continue;
    const lastCommitUnix = Number(unix);
    if (!Number.isFinite(lastCommitUnix)) continue;
    rows.push({ ref, lastCommitUnix });
  }
  return rows;
}

export interface ActiveBranchChoice {
  ref: string;
  /** default = origin/HEAD 브랜치, recent-activity = 최근 활동이 더 높아 전환 */
  reason: "default" | "recent-activity";
}

/**
 * 활성 브랜치 선택: 기본 브랜치가 있으면 그것을 쓰되, 최근 1h 커밋 수가
 * 기본보다 확실히 높은(>) 후보가 있으면 그쪽으로 전환한다. 동률은 기본 유지
 * — 라벨이 튀지 않게 보수적으로.
 */
export function pickActiveBranch(
  defaultRef: string | null,
  candidates: BranchActivity[],
): ActiveBranchChoice | null {
  if (candidates.length === 0) {
    return defaultRef ? { ref: defaultRef, reason: "default" } : null;
  }
  const defaultActivity = candidates.find((c) => c.ref === defaultRef);
  const best = [...candidates].sort(
    (a, b) =>
      (b.recentCount ?? 0) - (a.recentCount ?? 0) || b.lastCommitUnix - a.lastCommitUnix,
  )[0];
  if (!defaultRef) return { ref: best.ref, reason: "recent-activity" };
  if ((best.recentCount ?? 0) > (defaultActivity?.recentCount ?? 0)) {
    return best.ref === defaultRef
      ? { ref: defaultRef, reason: "default" }
      : { ref: best.ref, reason: "recent-activity" };
  }
  return { ref: defaultRef, reason: "default" };
}

export interface FeedCommit {
  hash: string;
  shortHash: string;
  author: string;
  relDate: string;
  subject: string;
}

/** `log --format=%H%x1f%h%x1f%an%x1f%ar%x1f%s` 출력 파싱. */
export function parseFeedCommits(output: string): FeedCommit[] {
  const commits: FeedCommit[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [hash, shortHash, author, relDate, ...rest] = line.split("\x1f");
    if (!hash || !shortHash) continue;
    commits.push({ hash, shortHash, author: author ?? "", relDate: relDate ?? "", subject: rest.join("\x1f") });
  }
  return commits;
}

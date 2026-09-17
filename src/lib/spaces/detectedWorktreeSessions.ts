import { pathBasename } from "@/lib/files/paths";
import type { DetectedWorktree, Provider } from "@/types";
import { matchesSpacesQuery } from "@/lib/spaces/spacesSearch";

export interface DetectedWorktreeProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: "local" | "ssh";
  readonly sshHostId?: string;
  readonly isRepo: boolean;
}

export interface DetectedWorktreeAgent {
  readonly projectId: string;
  readonly worktreePath: string;
}

export interface DetectedWorktreeSession {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectKind: "local" | "ssh";
  readonly sshHostId?: string;
  readonly name: string;
  readonly worktree: DetectedWorktree;
  readonly provider: Provider;
  readonly lastActivityAt?: number;
}

interface DetectedProviderEvidence {
  readonly provider: Provider;
  readonly count: (worktree: DetectedWorktree) => number;
  readonly lastActivity: (worktree: DetectedWorktree) => number | undefined;
  readonly searchTerms: string;
}

const DETECTED_PROVIDER_EVIDENCE: readonly DetectedProviderEvidence[] = [
  {
    provider: "claude",
    count: (worktree) => worktree.claudeSessions,
    lastActivity: (worktree) => worktree.claudeLastTs,
    searchTerms: "claude claude code",
  },
  {
    provider: "codex",
    count: (worktree) => worktree.codexSessions,
    lastActivity: (worktree) => worktree.codexLastTs,
    searchTerms: "codex",
  },
];

const EMPTY_PROVIDER_EVIDENCE: DetectedProviderEvidence = {
  provider: "claude",
  count: () => 0,
  lastActivity: () => undefined,
  searchTerms: "",
};

function providerEvidence(provider: Provider): DetectedProviderEvidence {
  return (
    DETECTED_PROVIDER_EVIDENCE.find(
      (evidence) => evidence.provider === provider,
    ) ?? EMPTY_PROVIDER_EVIDENCE
  );
}

export function detectedWorktreeSessionCount(
  worktree: DetectedWorktree,
  provider: Provider,
): number {
  return providerEvidence(provider).count(worktree);
}

export function detectedWorktreeLastActivity(
  worktree: DetectedWorktree,
  provider: Provider,
): number | undefined {
  return providerEvidence(provider).lastActivity(worktree);
}

/** 양쪽 흔적이 있으면 가장 최근 세션을 기본값으로 삼는다. */
export function detectedWorktreeProvider(worktree: DetectedWorktree): Provider {
  return (
    DETECTED_PROVIDER_EVIDENCE.filter(
      (evidence) => evidence.count(worktree) > 0,
    ).sort(
      (left, right) =>
        (right.lastActivity(worktree) ?? 0) -
        (left.lastActivity(worktree) ?? 0),
    )[0]?.provider ?? EMPTY_PROVIDER_EVIDENCE.provider
  );
}

/**
 * 아직 등록되지 않은 외부 worktree 세션을 location-first 목록으로 만든다.
 * path가 같아도 projectId(로컬/SSH 실행 위치)가 다르면 별개 세션이다.
 */
export function selectDetectedWorktreeSessions(input: {
  projects: readonly DetectedWorktreeProject[];
  detected: Readonly<Record<string, readonly DetectedWorktree[] | undefined>>;
  agents: readonly DetectedWorktreeAgent[];
  query?: string;
}): DetectedWorktreeSession[] {
  const normalizedQuery = input.query?.trim().toLocaleLowerCase() ?? "";
  const registered = new Set(
    input.agents.map(
      (agent) => `${agent.projectId}\0${agent.worktreePath}`,
    ),
  );
  const sessions: DetectedWorktreeSession[] = [];

  for (const project of input.projects) {
    for (const worktree of input.detected[project.id] ?? []) {
      if (
        worktree.isMain ||
        (worktree.claudeSessions <= 0 && worktree.codexSessions <= 0) ||
        registered.has(`${project.id}\0${worktree.path}`)
      ) {
        continue;
      }

      const provider = detectedWorktreeProvider(worktree);
      const candidate: DetectedWorktreeSession = {
        projectId: project.id,
        projectName: project.name,
        projectKind: project.kind,
        sshHostId: project.sshHostId,
        name: pathBasename(worktree.path),
        worktree,
        provider,
        lastActivityAt: detectedWorktreeLastActivity(worktree, provider),
      };
      if (
        !matchesSpacesQuery(normalizedQuery, [
          candidate.name,
          candidate.projectName,
          worktree.path,
          worktree.branch,
          DETECTED_PROVIDER_EVIDENCE.filter(
            (evidence) => evidence.count(worktree) > 0,
          )
            .map((evidence) => evidence.searchTerms)
            .join(" "),
        ])
      ) {
        continue;
      }
      sessions.push(candidate);
    }
  }

  return sessions.sort((left, right) => {
    const recent = (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);
    return recent || left.name.localeCompare(right.name);
  });
}

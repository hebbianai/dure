// SCM 창 "가장 활발한 브랜치" 요약 행 + 접이식 최근 커밋 피드 (l36t v1).
// 60초 주기 fetch(refreshSignal)와 함께 갱신되고, 커밋 클릭은 기존 상세
// 영역을 재사용한다. 원격이 없는 리포에서는 아무것도 그리지 않는다.
import { useEffect, useState } from "react";
import { GitBranch, Zap } from "lucide-react";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { Titled } from "@/components/ui/tooltip";
import { gitExec } from "@/lib/scm/history/git";
import {
  parseFeedCommits,
  parseForEachRef,
  pickActiveBranch,
  type ActiveBranchChoice,
  type FeedCommit,
} from "@/lib/scm/history/activeBranchFeed";
import type { Project } from "@/types";
import { t } from "@/lib/i18n";

interface FeedState {
  choice: ActiveBranchChoice;
  recentCount: number;
  behind: number;
  commits: FeedCommit[];
}

export function ActiveBranchFeed({
  project,
  refreshSignal,
  onSelectCommit,
}: {
  project: Project;
  refreshSignal: number;
  onSelectCommit: (project: Project, hash: string) => void;
}) {
  const [state, setState] = useState<FeedState | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 기본 브랜치(origin/HEAD). 미설정 리포면 null — 활동 기준으로만 고른다.
      const head = await gitExec(project, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      const defaultRef = head.code === 0 ? head.stdout.trim() || null : null;

      const refs = await gitExec(project, [
        "for-each-ref",
        "--sort=-committerdate",
        "--count=8",
        "--format=%(refname:short)\t%(committerdate:unix)",
        "refs/remotes/origin",
      ]);
      if (cancelled) return;
      const candidates = refs.code === 0 ? parseForEachRef(refs.stdout) : [];
      if (candidates.length === 0 && !defaultRef) {
        setState(null);
        return;
      }
      // 최근 1h 커밋 수는 상위 3개 + 기본 브랜치만 조회 (호출 수 상한).
      const probeRefs = [
        ...new Set(
          [defaultRef, ...candidates.slice(0, 3).map((c) => c.ref)].filter(
            (ref): ref is string => Boolean(ref),
          ),
        ),
      ];
      await Promise.all(
        probeRefs.map(async (ref) => {
          const count = await gitExec(project, [
            "rev-list",
            "--count",
            "--since=1.hour",
            ref,
            "--",
          ]);
          const row = candidates.find((c) => c.ref === ref);
          if (row && count.code === 0) row.recentCount = Number(count.stdout.trim()) || 0;
        }),
      );
      if (cancelled) return;
      const choice = pickActiveBranch(defaultRef, candidates);
      if (!choice) {
        setState(null);
        return;
      }
      const [behind, log] = await Promise.all([
        gitExec(project, ["rev-list", "--count", `HEAD..${choice.ref}`, "--"]),
        gitExec(project, [
          "log",
          "-5",
          "--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s",
          choice.ref,
          "--",
        ]),
      ]);
      if (cancelled) return;
      setState({
        choice,
        recentCount:
          candidates.find((c) => c.ref === choice.ref)?.recentCount ?? 0,
        behind: behind.code === 0 ? Number(behind.stdout.trim()) || 0 : 0,
        commits: log.code === 0 ? parseFeedCommits(log.stdout) : [],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [project, refreshSignal]);

  if (!state) return null;

  return (
    <div className="shrink-0 border-b border-glass-hairline">
      <Titled title={
          state.choice.reason === "recent-activity"
            ? t("scm.branchFeed.autoSelected")
            : t("scm.branchFeed.defaultBranch")
        }>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-glass-tint-hover"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <DisclosureChevron open={open} />
          <GitBranch className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-[11px] text-foreground">
            {state.choice.ref}
          </span>
          {state.choice.reason === "recent-activity" && (
            <Zap className="size-3 shrink-0 text-status-warn" aria-hidden="true" />
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
            <span>{t("scm.branchFeed.recentCommitCount", { n: state.recentCount })}</span>
            <span>
              {state.behind > 0
                ? t("scm.branchFeed.behindMine", { n: state.behind })
                : t("scm.branchFeed.upToDate")}
            </span>
          </span>
        </button>
      </Titled>
      {open && (
        <ul className="pb-1">
          {state.commits.map((commit) => (
            <li key={commit.hash}>
              <Titled title={`${commit.subject} — ${commit.author}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-0.5 text-left hover:bg-glass-tint-hover"
                  onClick={() => onSelectCommit(project, commit.hash)}
                >
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {commit.shortHash}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px]">{commit.subject}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {commit.relDate}
                  </span>
                </button>
              </Titled>
            </li>
          ))}
          {state.commits.length === 0 && (
            <li className="px-3 py-1 text-[11px] text-muted-foreground">
              {t("scm.branchFeed.noRecentCommits")}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

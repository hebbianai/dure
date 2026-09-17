import { useCallback, useEffect, useState } from "react";
import { DureLoader } from "@/components/ui/dure-loader";
import { GitAvailabilityNotice } from "@/components/scm/GitAvailabilityNotice";
import { useGitAvailability } from "@/components/scm/useGitAvailability";
import type { IDockviewPanelProps } from "dockview-react";
import {
  GitBranch,
  RefreshCw,
  ArrowDownToLine,
  ArrowUpFromLine,
  DownloadCloud,
  ExternalLink,
  GitPullRequestArrow,} from "lucide-react";
import { vcsStatusTone } from "@/lib/scm/status/vcsStatusTone";
import { useStore } from "@/store";
import { usePaneFirstReveal } from "@/components/workspace/usePaneFirstReveal";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { gitExec, gitInfo, gitRemoteUrl, type GitInfo } from "@/lib/scm/history/git";
import { openBrowserPanelOn } from "@/lib/workspace/dock/openBrowserPanel";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ExecResult } from "@/lib/ipc";

export function GitPanel(props: IDockviewPanelProps<{ projectId: string }>) {
  const project = useStore((s) => s.projects.find((p) => p.id === props.params.projectId));
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ ok: boolean; text: string } | null>(null);
  const [msg, setMsg] = useState("");
  const revealed = usePaneFirstReveal(props.api);
  const git = useGitAvailability(project?.kind === "ssh" ? project.sshHostId ?? "" : null, revealed && !!project);

  const refresh = useCallback(async () => {
    if (!project || git.state.status !== "available") return;
    setInfo(await gitInfo(project));
  }, [project, git.state.status]);

  // 숨은 탭·오프스크린 데스크탑에서 마운트만으로 git을 스폰하지 않는다 —
  // 첫 조회는 pane이 실제로 보일 때(콜드 리마운트 경량화, P0-c).
  useEffect(() => {
    if (revealed) refresh();
  }, [revealed, refresh]);

  if (!project) return <div className="p-3 text-xs text-muted-foreground">{t("common.projectNotFound")}</div>;
  if (git.state.status !== "available") return <div className="p-3"><GitAvailabilityNotice {...git} /></div>;

  const show = (r: ExecResult) => {
    setLog({ ok: r.code === 0, text: (`${r.stdout}\n${r.stderr}`).trim() || (r.code === 0 ? t("common.done") : t("common.failed")) });
  };

  const run = async (key: string, args: string[]) => {
    setBusy(key);
    setLog(null);
    try {
      show(await gitExec(project, args));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const commit = async (push: boolean) => {
    if (!msg.trim()) return;
    setBusy("commit");
    setLog(null);
    try {
      await gitExec(project, ["add", "-A"]);
      const c = await gitExec(project, ["commit", "-m", msg.trim()]);
      show(c);
      if (c.code === 0) {
        setMsg("");
        if (push) show(await gitExec(project, ["push"]));
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const openGitHub = async (compare: boolean) => {
    setBusy("github");
    try {
      const url = await gitRemoteUrl(project);
      if (url) {
        openBrowserPanelOn(
          props.containerApi,
          compare && info?.branch ? `${url}/compare/${info.branch}?expand=1` : url,
        );
        // 통계: PR 만들기(compare 페이지 열기)를 카운트
        if (compare && info?.branch) useStore.getState().bumpStats({ prsCreated: 1 });
      } else {
        setLog({ ok: false, text: t("panels.git.noOriginRemote") });
      }
    } finally {
      setBusy(null);
    }
  };

  const Btn = ({
    k,
    onClick,
    icon: Icon,
    label,
    disabled,
  }: {
    k: string;
    onClick: () => void;
    icon: typeof GitBranch;
    label: string;
    disabled?: boolean;
  }) => (
    <Button type="button" size="xs" variant="outline"
      onClick={onClick}
      disabled={!!busy || disabled}
    >
      {busy === k ? <DureLoader decorative /> : <Icon />}
      {label}
    </Button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs text-muted-foreground">{info?.branch || "…"}</span>
        {!!info?.ahead && <span className="text-xs text-vcs-added">↑{info.ahead}</span>}
        {!!info?.behind && <span className="text-xs text-vcs-modified">↓{info.behind}</span>}
        <IconButton
          className="ml-auto size-5 rounded hover:bg-accent"
          onClick={refresh}
          title={t("common.refresh")}
        >
          <RefreshCw className="size-3.5" />
        </IconButton>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
        <Btn k="fetch" onClick={() => run("fetch", ["fetch", "--all", "--prune"])} icon={DownloadCloud} label="Fetch" />
        <Btn k="pull" onClick={() => run("pull", ["pull"])} icon={ArrowDownToLine} label="Pull" />
        <Btn k="push" onClick={() => run("push", ["push"])} icon={ArrowUpFromLine} label="Push" />
        <Btn k="github" onClick={() => openGitHub(false)} icon={ExternalLink} label="GitHub" />
        <Btn k="pr" onClick={() => openGitHub(true)} icon={GitPullRequestArrow} label={t("panels.git.createPr")} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
          {t("panels.git.changes")} {info ? `(${info.files.length})` : ""}
        </div>
        {info?.files.length === 0 && <div className="text-xs text-muted-foreground">{t("panels.git.cleanWorkingTree")}</div>}
        {info?.files.map((f) => (
          <div key={f.path} className="flex items-center gap-2 py-0.5 font-mono text-xs">
            <span className={cn("w-6 shrink-0", vcsStatusTone(f.xy))}>{f.xy}</span>
            <span className="truncate">{f.path}</span>
          </div>
        ))}
      </div>

      <div className="border-t px-3 py-2">
        <Textarea
          className="mb-1.5 h-14 min-h-0 resize-none text-xs"
          placeholder={t("panels.git.commitMessagePlaceholder")}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
        />
        <div className="flex gap-1.5">
          <Button type="button" size="xs" variant="outline"
            className="flex-1"
            onClick={() => commit(false)}
            disabled={!!busy || !msg.trim()}
          >
            {t("common.commit")}
          </Button>
          <Button type="button" size="xs"
            className="flex-1"
            onClick={() => commit(true)}
            disabled={!!busy || !msg.trim()}
          >
            {t("panels.git.commitAndPush")}
          </Button>
        </div>
      </div>

      {log && (
        <pre
          className={cn(
            "max-h-28 shrink-0 overflow-auto border-t px-3 py-2 font-mono text-[11px] whitespace-pre-wrap",
            log.ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {log.text}
        </pre>
      )}
    </div>
  );
}

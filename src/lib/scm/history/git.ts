import { gitExecLocal, sshExecOnce, hostToOpts, type ExecResult } from "@/lib/ipc";
import { useStore } from "@/store";
import { t } from "@/lib/i18n";
import type { Project } from "@/types";
import { shellQuote } from "@/lib/platform/shell";
import {
  parseProductGitBranches,
  productGitCommitGraph,
  productGitDecoration,
  productGitLogReadLimit,
  productGitLogRevisionArgs,
  type ProductGitBranches,
} from "@/lib/scm/history/gitRefs";

/** 프로젝트의 repo에서 git 서브커맨드 실행. 로컬은 git_exec, 원격은 ssh. */
export async function gitExec(project: Project, args: string[]): Promise<ExecResult> {
  if (project.kind === "ssh") {
    const host = useStore.getState().sshHosts.find((h) => h.id === project.sshHostId);
    if (!host) return { stdout: "", stderr: t("common.sshHostNotFound"), code: -1 };
    const cmd = `git -C ${shellQuote(project.path)} ${args.map(shellQuote).join(" ")}`;
    return sshExecOnce(hostToOpts(host), cmd);
  }
  return gitExecLocal(project.path, args);
}

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  /** "M path", "?? path" 같은 짧은 상태 라인들 */
  files: { xy: string; path: string }[];
}

/** 브랜치/ahead·behind + 변경 파일 목록 */
export async function gitInfo(project: Project): Promise<GitInfo> {
  // Keep both local and SSH observations from refreshing the repository index.
  const r = await gitExec(project, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"]);
  const info: GitInfo = { branch: "", ahead: 0, behind: 0, files: [] };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) info.branch = line.slice(14).trim();
    else if (line.startsWith("# branch.ab ")) {
      for (const p of line.slice(12).split(/\s+/)) {
        if (p.startsWith("+")) info.ahead = parseInt(p.slice(1), 10) || 0;
        else if (p.startsWith("-")) info.behind = parseInt(p.slice(1), 10) || 0;
      }
    } else if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      info.files.push({ xy: parts[1], path: parts.slice(8).join(" ") });
    } else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      info.files.push({ xy: parts[1], path: parts.slice(9).join(" ").split("\t")[0] });
    } else if (line.startsWith("? ")) {
      info.files.push({ xy: "??", path: line.slice(2) });
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      info.files.push({ xy: parts[1], path: parts.slice(10).join(" ") });
    }
  }
  return info;
}

/** origin 리모트를 https 웹 URL로 변환 (없으면 null) */
export async function gitRemoteUrl(project: Project): Promise<string | null> {
  const r = await gitExec(project, ["remote", "get-url", "origin"]);
  if (r.code !== 0) return null;
  const raw = r.stdout.trim();
  let m = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = raw.match(/^(https?:\/\/.+?)(?:\.git)?$/);
  if (m) return m[1];
  return null;
}


export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** ref 이름들 (HEAD, origin/main 등) — 커밋 팁에만 존재 */
  refs: string[];
  /** 부모 커밋 해시들 (머지 커밋은 2개 이상) — 멀티레인 그래프용 */
  parents: string[];
}

const LOG_SEP = "\x1f"; // Unit Separator — 커밋 메시지에 안 나타남

/** 최근 커밋 로그 (그래프용). 위상순(--topo-order), 모든 브랜치 포함. */
export async function gitLog(project: Project, limit = 200): Promise<GitCommit[]> {
  const r = await gitExec(project, [
    "log",
    `--pretty=%H${LOG_SEP}%h${LOG_SEP}%an${LOG_SEP}%D${LOG_SEP}%P${LOG_SEP}%s`,
    "--decorate=full",
    ...productGitLogRevisionArgs(),
    "--topo-order",
    `-n${productGitLogReadLimit(limit)}`,
  ]);
  if (r.code !== 0) return [];
  const out: GitCommit[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [hash, shortHash, author, refsRaw, parentsRaw, subject] = line.split(LOG_SEP);
    if (!hash) continue;
    const refs = (refsRaw ?? "")
      .split(",")
      .map(productGitDecoration)
      .filter((name): name is string => Boolean(name));
    const parents = (parentsRaw ?? "").split(" ").map((x) => x.trim()).filter(Boolean);
    out.push({ hash, shortHash, author: author ?? "", subject: subject ?? "", refs, parents });
  }
  return productGitCommitGraph(out, limit);
}


/** 소스 제어 드롭다운용 공용 git 액션 (실패 시 stderr 반환) */
export async function gitAction(project: Project, args: string[]): Promise<string | null> {
  const r = await gitExec(project, args);
  return r.code === 0 ? null : (r.stderr || r.stdout).trim() || `exit ${r.code}`;
}


export type GitBranches = ProductGitBranches;

/** 로컬/원격 브랜치 목록 + 현재 브랜치 */
export async function gitBranches(project: Project): Promise<GitBranches> {
  const r = await gitExec(project, [
    "branch",
    "-a",
    "--format=%(HEAD)%(refname)",
  ]);
  if (r.code !== 0) return { current: "", local: [], remote: [] };
  return parseProductGitBranches(r.stdout);
}

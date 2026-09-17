// 워크트리 생성 직후 실행할 setup 명령 결정 (시안 2256:29181 "생성 후 setup 실행").
//
// 시안의 설명 문구는 "pnpm install · .dure/setup.sh" 두 개를 나열하지만,
// 둘을 늘 돌리면 안 된다: 저장소마다 패키지 매니저가 다르고, setup 스크립트가
// 있는 저장소가 오히려 드물다. 그래서 "무엇이 있는지 보고 고른다".
//
// 실행 자체는 하지 않는다 — 순수 결정만. 실행은 호출부가 터미널/PTY로 돌려서
// 사용자가 진행과 실패를 눈으로 볼 수 있게 한다. 조용히 백그라운드로 돌리면
// 실패했을 때 에이전트가 왜 깨졌는지 알 방법이 없다.

import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";

/** 워크트리에 존재하는 것으로 확인된 파일들(레포 기준 상대 경로). */
export interface SetupProbe {
  files: readonly string[];
}

export interface SetupCommand {
  /** 사용자에게 보여 줄 명령 문자열 */
  command: string;
  /** 왜 이 명령을 골랐는지 — UI 툴팁·로그용 */
  reason: string;
}

/** 프로젝트 커스텀 스크립트가 있으면 그것 하나만 돌린다.
 *
 *  이유: 그 스크립트가 이미 install을 포함할 수 있고, 우리가 install을 먼저
 *  돌리면 중복이거나(느림) 잘못된 매니저로 락파일을 건드린다(위험). 저장소가
 *  자기 setup을 정의했으면 그게 권위다. */
const CUSTOM_SETUP = ".dure/setup.sh";

/** 락파일 → 설치 명령. 순서가 우선순위다 — 여러 개가 있으면 앞의 것을 쓴다. */
const INSTALL_BY_LOCKFILE: readonly (readonly [string, string])[] = [
  ["pnpm-lock.yaml", "pnpm install"],
  ["bun.lockb", "bun install"],
  ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm install"],
  // 락파일이 없어도 package.json만 있으면 npm이 최소 공통분모다.
  ["package.json", "npm install"],
  ["Cargo.toml", "cargo fetch"],
  ["go.mod", "go mod download"],
  ["requirements.txt", "pip install -r requirements.txt"],
  ["uv.lock", "uv sync"],
];

/**
 * 무엇을 돌릴지 결정한다. 돌릴 것이 없으면 null — 스위치가 켜져 있어도
 * 아무 일도 하지 않는 게 맞다(빈 명령을 돌려 터미널만 여는 것보다 낫다).
 */
export function resolveSetupCommand(probe: SetupProbe): SetupCommand | null {
  const has = (file: string) => probe.files.includes(file);
  if (has(CUSTOM_SETUP)) {
    return {
      command: `sh ${CUSTOM_SETUP}`,
      reason: `${CUSTOM_SETUP} exists, so the repository-defined setup runs`,
    };
  }
  if (has(LEGACY_PRODUCT_COMPATIBILITY.setupScriptPath)) {
    return {
      command: `sh ${LEGACY_PRODUCT_COMPATIBILITY.setupScriptPath}`,
      reason: `${LEGACY_PRODUCT_COMPATIBILITY.setupScriptPath} exists, so the legacy repository setup runs`,
    };
  }
  for (const [file, command] of INSTALL_BY_LOCKFILE) {
    if (has(file)) {
      return { command, reason: `chosen from ${file}` };
    }
  }
  return null;
}

/** 탐색해야 할 파일 목록 — 호출부가 이 목록만 확인하면 된다. */
export function setupProbePaths(): string[] {
  return [
    CUSTOM_SETUP,
    LEGACY_PRODUCT_COMPATIBILITY.setupScriptPath,
    ...INSTALL_BY_LOCKFILE.map(([file]) => file),
  ];
}

/** Root-relative directories that contain supported setup files. */
export function setupProbeDirectories(): string[] {
  return [
    ...new Set(
      setupProbePaths().flatMap((path) => {
        const separator = path.indexOf("/");
        return separator > 0 ? [path.slice(0, separator)] : [];
      }),
    ),
  ];
}

/** 실제로 열 setup 터미널 한 개. */
export interface SetupLaunch {
  command: string;
  /** 명령을 돌릴 디렉터리 — 새로 만든 워크트리(없으면 프로젝트 루트) */
  cwd: string;
  /** 원격 프로젝트면 그 SSH 호스트, 로컬이면 null */
  host: { id: string; name: string } | null;
}

/**
 * 워크트리 생성 직후 setup 터미널을 열지 결정한다.
 *
 * 스위치가 꺼져 있거나, 돌릴 명령이 없거나, 작업 디렉터리를 모르면 열지 않는다 —
 * 빈 명령으로 터미널만 띄우면 사용자는 "뭔가 실패했나" 하고 남은 창을 보게 된다.
 *
 * 새 워크트리를 만들지 않았으면 열지 않는다. 이 기능은 "빈 워크트리를 쓸 수 있게
 * 만든다"는 것이고, 워크트리를 끄면 cwd가 사용자의 본 체크아웃이라 요청하지도
 * 않은 install이 거기서 돌게 된다. 스위치는 접힌 고급 섹션 안이라 사용자가 그걸
 * 봤으리라고 가정할 수도 없다.
 */
export function planSetupLaunch(input: {
  runSetup: boolean;
  /** 이번 생성으로 전용 워크트리가 확보됐는가 */
  createdWorktree: boolean;
  command: string | null;
  cwd: string;
  host: { id: string; name: string } | null;
}): SetupLaunch | null {
  if (!input.runSetup || !input.createdWorktree) return null;
  const command = input.command?.trim();
  if (!command) return null;
  const cwd = input.cwd.trim();
  if (!cwd) return null;
  return { command, cwd, host: input.host };
}

/** One directory entry — both local list_dir and remote listRemoteDir give at
 *  least this shape. */
export interface ProbeDirEntry {
  name: string;
}

/**
 * Decides the setup command to actually run for a worktree (or project root)
 * from a directory listing alone. Judges by directory listing rather than
 * stat-ing each candidate file — the round trip count stays at most 3
 * regardless of candidate count (root + canonical/compatibility setup
 * directories).
 *
 * `listDirectory` is injected so the caller picks local (list_dir) vs remote
 * (listRemoteDir) — this function is agnostic to that difference. Any listing
 * failure (permission, dropped remote connection) degrades to null instead of
 * throwing: a caller that lets this reject would fail to open its dialog.
 */
export async function probeSetupCommand(
  listDirectory: (path: string) => Promise<readonly ProbeDirEntry[]>,
  basePath: string,
): Promise<string | null> {
  try {
    const top = await listDirectory(basePath);
    const names = new Set(top.map((entry) => entry.name));
    const files = setupProbePaths().filter(
      (relative) => !relative.includes("/") && names.has(relative),
    );
    // The Dure path is authoritative; the compatibility path is exposed only
    // as a read input at the setupRun boundary.
    for (const directory of setupProbeDirectories()) {
      if (!names.has(directory)) continue;
      const nested = await listDirectory(`${basePath}/${directory}`);
      if (nested.some((entry) => entry.name === "setup.sh")) {
        files.push(`${directory}/setup.sh`);
      }
    }
    return resolveSetupCommand({ files })?.command ?? null;
  } catch {
    return null;
  }
}

/** node 버전 핀(.node-version/.nvmrc)이 있는 워크트리에서 setup이 ambient
 *  node로 죽지 않게, 실행 시점에 로컬 설치본(nvm·mise)을 찾아 PATH 앞에
 *  세우는 셸 프리앰블을 붙인다. 매칭 설치본이 없으면 그대로 진행돼 오늘과
 *  같은 엔진 오류가 보인다 — 정확한 실패가 조용한 우회보다 낫다.
 *  Why: 2026-08-03 setup pane ERR_PNPM_UNSUPPORTED_ENGINE — 로그인 셸 기본
 *  node 24.1.0이 engines(>=24.15.0)를 못 넘겨 새 워크트리 setup이 죽었다. */
export function setupShellCommand(command: string): string {
  const resolveNodePin =
    'v=""; [ -f .node-version ] && v=$(cat .node-version); ' +
    '[ -z "$v" ] && [ -f .nvmrc ] && v=$(cat .nvmrc); ' +
    'v=$(printf %s "$v" | tr -d "v[:space:]"); ' +
    'if [ -n "$v" ]; then ' +
    'for b in "$HOME/.nvm/versions/node/v$v/bin" "$HOME/.local/share/mise/installs/node/$v/bin"; do ' +
    'if [ -x "$b/node" ]; then PATH="$b:$PATH"; export PATH; break; fi; ' +
    "done; fi; ";
  return resolveNodePin + resolvePackageManager(command) + command;
}

/** The backend that launches setup inherits a bare login-shell PATH, which on
 *  many machines has node but no pnpm (PNPM_HOME and Homebrew live in .zshrc).
 *  Look in the standalone pnpm homes first, then let corepack serve the version
 *  pinned by package.json. A pnpm already on PATH is left alone.
 *  Why: 2026-09-11 quick dispatch claude-19 died in prompt_delivery with
 *  "/bin/sh: pnpm: command not found" before Claude ever launched (#733). */
function resolvePackageManager(command: string): string {
  if (!/^pnpm(\s|$)/.test(command)) return "";
  return (
    "if ! command -v pnpm >/dev/null 2>&1; then " +
    'for d in "$PNPM_HOME" "$HOME/Library/pnpm" "$HOME/.local/share/pnpm"; do ' +
    'if [ -n "$d" ] && [ -x "$d/pnpm" ]; then PATH="$d:$PATH"; export PATH; break; fi; ' +
    "done; fi; " +
    "if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then " +
    'pnpm() { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"; }; fi; '
  );
}

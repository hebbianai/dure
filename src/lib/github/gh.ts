// `gh` CLI 출력 파싱 — 순수 함수만 둔다(실행은 Rust ghx.rs, invoke는 ipc/github.ts).
//
// 인증을 우리가 만들지 않는 결정(소유자, 2026-08-02)에 따라 상태 판정도 gh가
// 말하는 것을 읽어서 한다. `gh auth status`는 자유 형식 텍스트지만 라벨은
// 안정적이라 그 라벨만 붙잡고 파싱한다.

import { t } from "@/lib/i18n";

/** 시안 Github 탭이 요구하는 스코프. repo는 이슈·PR 조회, read:org는 조직
 *  레포에서 그 조회가 통과하는 데 필요하다. */
const REQUIRED_SCOPES = ["repo", "read:org"] as const;

export interface GhAccount {
  host: string;
  user: string;
  active: boolean;
  /** keyring이면 gh가 보관, env면 셸의 GITHUB_TOKEN/GH_TOKEN이 덮고 있다 */
  source: "keyring" | "env";
  /** env를 덮고 있는 변수 이름 — 안내 문구에 그대로 쓴다 */
  envToken: string | null;
  scopes: string[];
}

/**
 * `gh auth status` 출력 파서.
 *
 * gh는 기본적으로 stderr에 쓰지만 버전에 따라 stdout을 쓴 적도 있어 호출부가
 * 둘을 합쳐 넣는다. 호스트별 형식:
 *
 *   github.com
 *     ✓ Logged in to github.com account NAME (keyring)
 *     - Active account: true
 *     - Token scopes: 'gist', 'read:org', 'repo'
 */
export function parseAuthStatus(text: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  let current: GhAccount | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const loggedIn = line.match(
      /Logged in to (\S+) account (\S+)(?:\s+\(([^)]+)\))?/i,
    );
    if (loggedIn) {
      if (current) accounts.push(current);
      const label = (loggedIn[3] ?? "").trim();
      // gh는 보관된 자격증명에 "(keyring)", 셸 변수가 덮고 있으면
      // "(GITHUB_TOKEN)" / "(GH_TOKEN)"을 찍는다.
      const envToken =
        label === "GITHUB_TOKEN" || label === "GH_TOKEN" ? label : null;
      current = {
        host: loggedIn[1],
        user: loggedIn[2],
        active: false,
        source: envToken ? "env" : "keyring",
        envToken,
        scopes: [],
      };
      continue;
    }
    if (!current) continue;
    const active = line.match(/Active account:\s*(true|false)/i);
    if (active) {
      current.active = active[1].toLowerCase() === "true";
      continue;
    }
    const scopes = line.match(/Token scopes:\s*(.+)$/i);
    if (scopes) {
      current.scopes = scopes[1]
        .split(",")
        .map((scope) => scope.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
  }
  if (current) accounts.push(current);
  return accounts;
}

export type GhAuthState =
  | { kind: "missing" }
  | { kind: "logged-out" }
  | { kind: "missing-scopes"; account: GhAccount; missing: string[] }
  /** 셸의 env 토큰이 keyring을 덮고 있어 `gh auth refresh`가 조용히 무시된다 */
  | { kind: "env-shadowed"; account: GhAccount; missing: string[] }
  | { kind: "ready"; account: GhAccount };

/**
 * 계정 목록 → 화면이 쓸 상태 하나.
 *
 * env-shadowed를 따로 두는 이유가 이 함수의 존재 이유다. 스코프가 모자란데
 * 셸에 GITHUB_TOKEN이 있으면, 흔한 안내인 `gh auth refresh -s ...`가 **성공한
 * 것처럼 끝나고 아무것도 안 바뀐다** — gh가 env 토큰을 keyring보다 우선하고
 * env 토큰은 refresh를 거부하기 때문이다. 사용자는 시킨 대로 했는데 계속 막힌다.
 * (다른 gh 클라이언트의 인증 진단 코드도 같은 함정을 문서화해 두었다.)
 */
export function authState(
  accounts: readonly GhAccount[],
  ghMissing: boolean,
  required: readonly string[] = REQUIRED_SCOPES,
): GhAuthState {
  if (ghMissing) return { kind: "missing" };
  if (accounts.length === 0) return { kind: "logged-out" };
  const account = accounts.find((candidate) => candidate.active) ?? accounts[0];
  const missing = required.filter((scope) => !account.scopes.includes(scope));
  if (missing.length === 0) return { kind: "ready", account };
  return account.source === "env"
    ? { kind: "env-shadowed", account, missing }
    : { kind: "missing-scopes", account, missing };
}

/** Recovery guidance — localized template (`key`) plus interpolation values.
 *
 *  `key` is resolved through t() here at call time (runtime, never module
 *  scope), so the literal keys below are visible to the i18nCoverage gate and
 *  the caller may safely pass the result through t() again — a lookup miss
 *  returns the text unchanged while still interpolating `params`. */
export interface AuthRemediation {
  key: string;
  params?: Record<string, string>;
}

/** 상태별 복구 안내 — env-shadowed만 다른 말을 해야 한다. */
export function authRemediation(state: GhAuthState): AuthRemediation | null {
  switch (state.kind) {
    case "missing":
      return { key: t("github.auth.cliMissing") };
    case "logged-out":
      return { key: t("github.auth.loginRequired") };
    case "missing-scopes":
      return {
        key: t("github.auth.missingScopes"),
        params: { scopes: state.missing.join(",") },
      };
    case "env-shadowed":
      return {
        key: t("github.auth.envTokenOverride"),
        params: {
          envToken: state.account.envToken ?? "GITHUB_TOKEN",
          scopes: state.missing.join(", "),
        },
      };
    default:
      return null;
  }
}

/** `#1234`, `1234`, GitHub 이슈/PR URL에서 번호를 뽑는다. */
export function parseWorkItemRef(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const url = trimmed.match(
    /github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)/i,
  );
  if (url) return Number(url[1]);
  const hash = trimmed.match(/^#?(\d+)$/);
  return hash ? Number(hash[1]) : null;
}

export interface GhWorkItem {
  number: number;
  title: string;
  /** issue인지 pull request인지 — 브랜치 기준이 달라지지 않지만 아이콘이 다르다 */
  kind: "issue" | "pr";
  /** PR이면 그 head 브랜치 — 있으면 새로 만들지 않고 그 브랜치를 쓴다 */
  headRefName?: string;
}

/** `gh issue list --json number,title` / `gh pr list --json ...` 출력 파서.
 *  깨진 JSON은 빈 목록으로 — 조회 실패가 다이얼로그를 죽이면 안 된다. */
export function parseWorkItems(json: string, kind: "issue" | "pr"): GhWorkItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const number = typeof item.number === "number" ? item.number : null;
    if (number === null) return [];
    const headRefName =
      typeof item.headRefName === "string" && item.headRefName
        ? item.headRefName
        : undefined;
    return [
      {
        number,
        title: typeof item.title === "string" ? item.title : "",
        kind,
        headRefName,
      },
    ];
  });
}

/**
 * 작업 항목 → 브랜치 이름.
 *
 * PR은 이미 head 브랜치가 있으므로 그걸 그대로 쓴다 — 새로 만들면 그 PR과
 * 무관한 브랜치가 생겨 사용자가 기대한 "그 PR을 이어서 작업"이 안 된다.
 * 이슈는 `issue-<번호>-<제목 슬러그>`로 만든다.
 */
export function branchNameForWorkItem(item: GhWorkItem, maxSlug = 32): string {
  if (item.kind === "pr" && item.headRefName) return item.headRefName;
  const slug = item.title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxSlug)
    .replace(/-+$/g, "");
  return slug ? `issue-${item.number}-${slug}` : `issue-${item.number}`;
}

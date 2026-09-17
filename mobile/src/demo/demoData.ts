/**
 * What the demo build's paired computers, servers, and repositories contain.
 *
 * Every name here is invented. The shapes are the wire shapes `ipc.ts`
 * declares, because the screens are the real screens — a demo that fed them
 * a private shape would start passing while the app was broken.
 *
 * Times are relative (`agoMinutes`) and resolved when a probe is answered, so
 * "3분 전" stays "3분 전" however long the phone sits on a table.
 */

import type { SessionPresentation } from "@/lib/hub/sessionPresentation";
import type { ServerReport } from "../census";
import type {
  FolderBrowserEntry,
  HubLayout,
  HubProbeSession,
  HubRow,
  LaunchOffer,
  ServerRow,
  SourceControlBranch,
  SourceControlCommit,
  SourceControlFile,
  SourceControlReview,
  SourceControlReviewer,
} from "../ipc";
import type { RemoteSession } from "../sessions";

const MINUTE = 60_000;

export type DemoDisplayState = NonNullable<SessionPresentation["displayState"]>;

export interface DemoSession {
  readonly id: string;
  readonly name: string;
  readonly desktop: string;
  readonly project: string;
  readonly branch?: string;
  readonly provider: string;
  readonly launchProgram?: string;
  readonly kind: "agent" | "term" | "ssh";
  readonly lifecycle: "running" | "starting" | "exited";
  readonly display: DemoDisplayState;
  readonly detail?: string;
  readonly agoMinutes: number;
  readonly cwd: string;
  readonly git?: { ahead: number; behind: number; committed: number; worktree: number };
}

export interface DemoHub {
  readonly row: HubRow;
  readonly deviceLabel: string;
  readonly box: { readonly id: string; readonly label: string };
  readonly sessions: readonly DemoSession[];
  readonly desktopOrder: readonly string[];
}

// ── Paired computers ───────────────────────────────────────────────────────

const STUDIO_SESSIONS: readonly DemoSession[] = [
  {
    id: "s-pay-retry",
    name: "결제 API 리트라이 로직 수정",
    desktop: "Main",
    project: "Payments",
    branch: "fix/payment-retry",
    provider: "claude-code",
    kind: "agent",
    lifecycle: "running",
    display: "blocked",
    detail: "git commit 승인 대기",
    agoMinutes: 2,
    cwd: "/Users/seung/Dev/Payments",
    git: { ahead: 2, behind: 0, committed: 0, worktree: 14 },
  },
  {
    id: "s-card-tokens",
    name: "카드 토큰 정리",
    desktop: "Main",
    project: "HebbianIDE",
    branch: "worktree/card-tokens",
    provider: "codex",
    kind: "agent",
    lifecycle: "running",
    display: "working",
    detail: "src/components/card 를 읽는 중",
    agoMinutes: 0,
    cwd: "/Users/seung/Dev/HebbianIDE",
    git: { ahead: 0, behind: 6, committed: 3, worktree: 5 },
  },
  {
    id: "s-term",
    name: "zsh",
    desktop: "Main",
    project: "HebbianIDE",
    branch: "main",
    provider: "local-shell",
    launchProgram: "zsh",
    kind: "term",
    lifecycle: "running",
    display: "waiting",
    agoMinutes: 41,
    cwd: "/Users/seung/Dev/HebbianIDE",
  },
  {
    id: "s-mobile-folder",
    name: "Figma 디자인대로 폴더 화면 구현",
    desktop: "Main",
    project: "Dure",
    branch: "agent/mobile-folder",
    provider: "claude-code",
    kind: "agent",
    lifecycle: "running",
    display: "working",
    detail: "folderBrowserView.ts 수정 중",
    agoMinutes: 1,
    cwd: "/Users/seung/Dev/Dure",
    git: { ahead: 1, behind: 0, committed: 1, worktree: 3 },
  },
  {
    id: "s-toast",
    name: "토스트 통일",
    desktop: "Main",
    project: "Dure",
    branch: "main",
    provider: "gemini",
    kind: "agent",
    lifecycle: "running",
    display: "input",
    detail: "다음 지시를 기다리는 중",
    agoMinutes: 18,
    cwd: "/Users/seung/Dev/Dure",
    git: { ahead: 0, behind: 0, committed: 0, worktree: 0 },
  },
  {
    id: "s-landing",
    name: "랜딩 카피 다듬기",
    desktop: "Main",
    project: "Website",
    branch: "main",
    provider: "claude-code",
    kind: "agent",
    lifecycle: "exited",
    display: "exited",
    agoMinutes: 190,
    cwd: "/Users/seung/Dev/Website",
    git: { ahead: 0, behind: 0, committed: 2, worktree: 0 },
  },
  {
    id: "s-onboarding",
    name: "온보딩 조사 정리",
    desktop: "Personal",
    project: "Notes",
    branch: "main",
    provider: "codex",
    kind: "agent",
    lifecycle: "running",
    display: "error",
    detail: "네트워크 오류로 멈춤",
    agoMinutes: 65,
    cwd: "/Users/seung/Notes",
    git: { ahead: 0, behind: 0, committed: 0, worktree: 1 },
  },
  {
    id: "s-ssh-sdd",
    name: "sdd",
    desktop: "Personal",
    project: "sdd",
    provider: "local-shell",
    launchProgram: "ssh",
    kind: "ssh",
    lifecycle: "running",
    display: "waiting",
    agoMinutes: 12,
    cwd: "/Users/seung",
  },
];

const MACBOOK_SESSIONS: readonly DemoSession[] = [
  {
    id: "m-deck",
    name: "발표 자료 정리",
    desktop: "Main",
    project: "Slides",
    branch: "main",
    provider: "claude-code",
    kind: "agent",
    lifecycle: "running",
    display: "input",
    detail: "다음 지시를 기다리는 중",
    agoMinutes: 35,
    cwd: "/Users/seung/Dev/Slides",
    git: { ahead: 0, behind: 0, committed: 0, worktree: 2 },
  },
  {
    id: "m-browser-cli",
    name: "브라우저 CLI 연결하기",
    desktop: "Main",
    project: "Playground",
    branch: "spike/browser-cli",
    provider: "codex",
    kind: "agent",
    lifecycle: "running",
    display: "working",
    agoMinutes: 4,
    cwd: "/Users/seung/Dev/Playground",
    git: { ahead: 0, behind: 0, committed: 0, worktree: 9 },
  },
];

export const STUDIO_HUB_ID = "SHA256:7GpQxwD1mR0cYkq3aHsT9uVbNe2Lf8jKzC4oWi6EyXA";
export const MACBOOK_HUB_ID = "SHA256:Kd3nR8vB2mZq7yTcL1sHf5wXe9gJp4aUo6iN0tVbMrE";

export const DEMO_HUBS: readonly DemoHub[] = [
  {
    row: {
      id: STUDIO_HUB_ID,
      box_label: "mac-studio",
      endpoint: "mac-studio.local:7423",
      relay_offered: true,
    },
    deviceLabel: "승연의 폰",
    box: { id: "box-studio", label: "mac-studio" },
    sessions: STUDIO_SESSIONS,
    desktopOrder: ["Main", "Personal"],
  },
  {
    row: {
      id: MACBOOK_HUB_ID,
      box_label: "seung-macbook",
      endpoint: "192.168.0.24:7423",
      relay_offered: false,
    },
    deviceLabel: "승연의 폰",
    box: { id: "box-macbook", label: "seung-macbook" },
    sessions: MACBOOK_SESSIONS,
    desktopOrder: ["Main"],
  },
];

/** The wire row for one session, with its activity time resolved against `now`. */
export function toProbeSession(hub: DemoHub, session: DemoSession, now: number): HubProbeSession {
  const ready = session.lifecycle === "running";
  return {
    session_id: session.id,
    session_name: session.name,
    workspace_id: session.project,
    session_class: "standalone",
    lifecycle: session.lifecycle,
    provider_id: session.provider,
    launch_program: session.launchProgram ?? null,
    runner_principal: "seung",
    runner_instance: "i-1",
    channel_epoch: "e-1",
    host_instance_id: hub.box.id,
    terminal_epoch: `epoch-${session.id}`,
    capabilities: ready ? ["terminal_viewport_wheel_v1"] : [],
    ready,
    box_id: hub.box.id,
    box_label: hub.box.label,
    presentation: {
      projectId: session.project.toLowerCase(),
      projectName: session.project,
      kind: session.kind,
      provider: session.provider,
      cwd: session.cwd,
      hostId: hub.box.id,
      hostLabel: hub.box.label,
      detail: session.detail,
      activityAt: now - session.agoMinutes * MINUTE,
      displayState: session.display,
      ...(session.git ? { git: session.git } : {}),
    },
  };
}

export function toLayout(hub: DemoHub, sessions: readonly DemoSession[]): HubLayout {
  return {
    desktop_order: [...hub.desktopOrder],
    placements: Object.fromEntries(
      sessions.map((session, order) => [
        session.id,
        {
          desktop: session.desktop,
          project: session.project,
          order,
          ...(session.branch === undefined ? {} : { branch: session.branch }),
        },
      ]),
    ),
  };
}

// ── Direct SSH ─────────────────────────────────────────────────────────────

export const SDD_SERVER: ServerRow = {
  id: "srv-sdd",
  label: "sdd",
  host: "sdd.internal",
  port: 22,
  username: "seung",
  host_key_fingerprint: "SHA256:Qm4vE8tYh2LkS0dPc6nRw9zXa1BfJg7iUo3eCbHtNyM",
  paired: true,
  attach_key_confinement: "forced_command",
  has_attach_key: true,
  has_list_key: true,
};

export function sshSessions(serverId: string): RemoteSession[] {
  const base = {
    workspace_id: "sdd",
    session_class: "standalone",
    lifecycle: "running",
    runner_principal: "seung",
    runner_instance: "i-1",
    channel_epoch: "e-1",
    host_instance_id: serverId,
    capabilities: [],
    ready: true,
  };
  return [
    {
      ...base,
      session_id: `${serverId}-deploy`,
      session_name: "배포 스크립트 점검",
      provider_id: "claude-code",
      launch_program: null,
      terminal_epoch: `epoch-${serverId}-deploy`,
    },
    {
      ...base,
      session_id: `${serverId}-logs`,
      session_name: "로그 tail",
      provider_id: "local-shell",
      launch_program: "zsh",
      terminal_epoch: `epoch-${serverId}-logs`,
    },
  ];
}

export function censusReport(server: ServerRow): ServerReport {
  return {
    server_id: server.id,
    server_label: server.label,
    outcome: { state: "listed", sessions: sshSessions(server.id) },
  };
}

// ── New agent ──────────────────────────────────────────────────────────────

export const LAUNCH_OFFER: LaunchOffer = {
  published: true,
  targets: [
    {
      id: "main hebbian",
      space_label: "Main",
      folder_label: "HebbianIDE",
      box_label: "",
      path_hint: "~/Dev/HebbianIDE",
      startable: true,
      worktree_supported: true,
    },
    {
      id: "main payments",
      space_label: "Main",
      folder_label: "Payments",
      box_label: "",
      path_hint: "~/Dev/Payments",
      startable: true,
      worktree_supported: true,
    },
    {
      id: "main dure",
      space_label: "Main",
      folder_label: "Dure",
      box_label: "",
      path_hint: "~/Dev/Dure",
      startable: true,
      worktree_supported: true,
    },
    {
      id: "main website",
      space_label: "Main",
      folder_label: "Website",
      box_label: "",
      path_hint: "~/Dev/Website",
      startable: true,
      worktree_supported: true,
    },
    {
      id: "personal notes",
      space_label: "Personal",
      folder_label: "Notes",
      box_label: "",
      path_hint: "~/Notes",
      startable: true,
      worktree_supported: false,
    },
  ],
  kinds: [
    { id: "claude", label: "Claude Code", installed: true },
    { id: "codex", label: "Codex", installed: true },
    { id: "gemini", label: "Gemini", installed: false },
  ],
};

export const FOLDER_ROOT = "/Users/seung";

/** Directory → its children. Anything not listed is empty. */
export const FOLDERS: Record<string, FolderBrowserEntry[]> = {
  [FOLDER_ROOT]: [
    { name: "Dev", path: `${FOLDER_ROOT}/Dev` },
    { name: "Documents", path: `${FOLDER_ROOT}/Documents` },
    { name: "Downloads", path: `${FOLDER_ROOT}/Downloads` },
    { name: "Notes", path: `${FOLDER_ROOT}/Notes` },
  ],
  [`${FOLDER_ROOT}/Dev`]: [
    { name: "HebbianIDE", path: `${FOLDER_ROOT}/Dev/HebbianIDE` },
    { name: "Payments", path: `${FOLDER_ROOT}/Dev/Payments` },
    { name: "Dure", path: `${FOLDER_ROOT}/Dev/Dure` },
    { name: "Website", path: `${FOLDER_ROOT}/Dev/Website` },
    { name: "Playground", path: `${FOLDER_ROOT}/Dev/Playground` },
  ],
  [`${FOLDER_ROOT}/Documents`]: [
    { name: "Figma exports", path: `${FOLDER_ROOT}/Documents/Figma exports` },
    { name: "회의록", path: `${FOLDER_ROOT}/Documents/회의록` },
  ],
  [`${FOLDER_ROOT}/Notes`]: [{ name: "2026-09", path: `${FOLDER_ROOT}/Notes/2026-09` }],
};

// ── Source control ─────────────────────────────────────────────────────────

function changed(
  path: string,
  status: string,
  added: number | null,
  deleted: number | null,
  uncommitted = true,
): SourceControlFile {
  return { path, status, old_path: null, added, deleted, uncommitted };
}

const PAYMENTS_FILES: SourceControlFile[] = [
  changed(".gitignore", "M", 6, 0),
  changed("src/payments/retry.ts", "M", 84, 12),
  changed("src/payments/backoff.ts", "A", 41, 0),
  changed("src/payments/retry.test.ts", "M", 120, 8),
  changed("src/payments/index.ts", "M", 2, 2),
  changed("src/http/client.ts", "M", 18, 4),
  changed("src/http/timeout.ts", "A", 33, 0),
  changed("docs/architecture/payments.md", "M", 46, 11),
  changed("db/migrations/004_compat.sql", "A", 41, 0),
  changed("db/migrations/005_retry.sql", "A", 27, 0),
  changed("package.json", "M", 1, 1),
  changed("pnpm-lock.yaml", "M", 214, 96),
  changed("src/legacy/poller.ts", "D", 0, 148),
  changed("README.md", "M", 3, 1),
];

const DEFAULT_FILES: SourceControlFile[] = [
  changed("src/app.ts", "M", 22, 9),
  changed("src/styles.css", "M", 14, 3),
  changed("src/assets/icon-folder.svg", "A", null, null),
  changed("docs/design.md", "M", 5, 5, false),
];

const CARD_TOKEN_FILES: SourceControlFile[] = [
  changed("src/components/card/Card.tsx", "M", 31, 27),
  changed("src/components/card/tokens.ts", "A", 58, 0),
  changed("src/components/card/Card.test.tsx", "M", 12, 4),
  changed("design/DESIGN.md", "M", 9, 2),
  changed("src/theme/legacyCard.css", "D", 0, 73),
];

export function filesFor(sessionId: string): SourceControlFile[] {
  if (sessionId === "s-pay-retry") return PAYMENTS_FILES.map((file) => ({ ...file }));
  if (sessionId === "s-card-tokens") return CARD_TOKEN_FILES.map((file) => ({ ...file }));
  if (sessionId === "s-toast" || sessionId === "s-landing") return [];
  return DEFAULT_FILES.map((file) => ({ ...file }));
}

export const COMMITS: SourceControlCommit[] = [
  { short_sha: "a91f3c2", subject: "결제 재시도를 지수 백오프로 교체", author: "seung", when: "12분 전" },
  { short_sha: "5d07b1e", subject: "타임아웃을 클라이언트 옵션으로 분리", author: "seung", when: "1시간 전" },
];

export const COMMIT_BODY = "최대 5회, 상한 30초. 4xx는 재시도 대상에서 제외.\n\n기존 poller 는 더 이상 쓰지 않아 지웠다.";

export const BRANCHES: SourceControlBranch[] = [
  { name: "fix/payment-retry", current: true, checked_out_at: null, when: "12분 전" },
  { name: "main", current: false, checked_out_at: "/Users/seung/Dev/Payments", when: "어제" },
  { name: "feat/refund-flow", current: false, checked_out_at: null, when: "3일 전" },
  { name: "chore/deps-2026-09", current: false, checked_out_at: null, when: "지난주" },
];

export const REVIEWERS: SourceControlReviewer[] = [
  { login: "joon", name: "Joon Park" },
  { login: "minji", name: "Minji Kim" },
  { login: "kattpish", name: "" },
];

export const REVIEW: SourceControlReview = {
  number: 812,
  title: "결제 재시도를 지수 백오프로 교체",
  state: "OPEN",
  url: "https://github.com/example/payments/pull/812",
  is_draft: false,
  base_ref: "main",
  requested_reviewers: ["joon"],
  review_decision: "",
  checks: { total: 2, passed: 2, failed: 0, pending: 0 },
};

const PATCHES: Record<string, string> = {
  ".gitignore": [
    "@@ -12,6 +12,12 @@",
    " build/",
    " .gradle/",
    " ",
    "+# 빌드 산출물 임시 파일",
    "+.kotlin/errors/",
    "+.omo/tmp/",
    " ",
    " local.properties",
  ].join("\n"),
  "src/payments/backoff.ts": [
    "@@ -0,0 +1,41 @@",
    "+/** 지수 백오프. 상한 30초, 지터 ±20%. */",
    "+export interface BackoffOptions {",
    "+  readonly baseMs: number;",
    "+  readonly maxMs: number;",
    "+  readonly attempts: number;",
    "+}",
    "+",
    "+export function delayFor(attempt: number, options: BackoffOptions): number {",
    "+  const raw = Math.min(options.maxMs, options.baseMs * 2 ** attempt);",
    "+  const jitter = raw * 0.2 * (Math.random() * 2 - 1);",
    "+  return Math.round(raw + jitter);",
    "+}",
    "+",
    "+export function shouldRetry(status: number): boolean {",
    "+  // 4xx 는 다시 보내도 같은 답이 온다.",
    "+  return status >= 500 || status === 429;",
    "+}",
  ].join("\n"),
  "src/payments/retry.ts": [
    "@@ -1,9 +1,14 @@",
    "-import { sleep } from \"../util/sleep\";",
    "+import { delayFor, shouldRetry } from \"./backoff\";",
    "+import { sleep } from \"../util/sleep\";",
    " ",
    "-const MAX_ATTEMPTS = 3;",
    "+const OPTIONS = { baseMs: 500, maxMs: 30_000, attempts: 5 };",
    " ",
    " export async function charge(request: ChargeRequest): Promise<ChargeResult> {",
    "-  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {",
    "+  for (let attempt = 0; attempt < OPTIONS.attempts; attempt += 1) {",
    "     const response = await post(\"/charge\", request);",
    "     if (response.ok) return response.json();",
    "-    await sleep(1000);",
    "+    if (!shouldRetry(response.status)) throw new ChargeError(response);",
    "+    await sleep(delayFor(attempt, OPTIONS));",
    "   }",
    "   throw new ChargeError(\"exhausted\");",
    " }",
  ].join("\n"),
};

/** A unified diff for `path`, invented from its line counts when nobody wrote one. */
export function patchFor(path: string, file: SourceControlFile | undefined): string {
  const known = PATCHES[path];
  if (known) return known;
  const added = file?.added ?? 3;
  const deleted = file?.deleted ?? 1;
  const lines = [`@@ -1,${deleted + 2} +1,${added + 2} @@`, ` // ${path}`];
  for (let index = 0; index < Math.min(deleted, 12); index += 1) {
    lines.push(`-  const before${index + 1} = legacy(${index + 1});`);
  }
  for (let index = 0; index < Math.min(added, 12); index += 1) {
    lines.push(`+  const after${index + 1} = current(${index + 1});`);
  }
  lines.push(" export {};");
  return lines.join("\n");
}

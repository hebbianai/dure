/**
 * The demo build's answer to every Rust command.
 *
 * Keyed by command name, exactly as `ipc.ts` names them, so the handler table
 * is a mirror of the Rust command table and the test that compares the two
 * catches a command the demo forgot. Argument names are the ones `ipc.ts`
 * sends — camelCase, the way Tauri hands them to Rust.
 *
 * State lives for the process. Forgetting a computer, committing files, or
 * starting an agent is remembered until the app restarts, and no longer: a
 * demo that could be left in a strange state would need a way to reset it.
 */

import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import type { ServerReport } from "../census";
import type {
  AttachedSession,
  CommandError,
  CreatedSessionOutcome,
  FileDiffOutcome,
  FolderBrowserOutcome,
  HubLayout,
  HubOfferPreview,
  HubProbe,
  HubRow,
  LaunchOffer,
  PairingOutcome,
  ScmWriteAction,
  ServerListing,
  ServerRow,
  SourceControlCommit,
  SourceControlFile,
  SourceControlOutcome,
  SourceControlReview,
  SshHostAdded,
  StartAgentOutcome,
} from "../ipc";
import type { RemoteSession } from "../sessions";
import {
  BRANCHES,
  COMMITS,
  COMMIT_BODY,
  DEMO_HUBS,
  type DemoHub,
  type DemoSession,
  FOLDERS,
  FOLDER_ROOT,
  LAUNCH_OFFER,
  MACBOOK_HUB_ID,
  REVIEW,
  REVIEWERS,
  SDD_SERVER,
  STUDIO_HUB_ID,
  censusReport,
  filesFor,
  patchFor,
  sshSessions,
  toLayout,
  toProbeSession,
} from "./demoData";
import { createDemoTerminals } from "./demoTerminal";

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

interface HubState {
  readonly hub: DemoHub;
  sessions: DemoSession[];
  /** How often the phone has connected. The second computer answers once. */
  opens: number;
}

interface RepoState {
  files: SourceControlFile[];
  commits: SourceControlCommit[];
  branch: string;
  branches: { name: string; when: string | null }[];
  ahead: number;
  behind: number;
  review: SourceControlReview | null;
}

function fail(code: string, message: string): never {
  const error: CommandError = { code, message };
  throw error;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function record(args: Args, key: string): Args {
  const value = args[key];
  return typeof value === "object" && value !== null ? (value as Args) : {};
}

// ── State ──────────────────────────────────────────────────────────────────

let hubs: HubState[] = DEMO_HUBS.map((hub) => ({ hub, sessions: [...hub.sessions], opens: 0 }));
let servers: ServerRow[] = [{ ...SDD_SERVER }];
let serverVersion = 1;
const repos = new Map<string, RepoState>();
const folders: Record<string, { name: string; path: string }[]> = Object.fromEntries(
  Object.entries(FOLDERS).map(([path, entries]) => [path, entries.map((entry) => ({ ...entry }))]),
);
const terminals = createDemoTerminals();
let startedAgents = 0;
let commitsMade = 0;

function hubState(id: string): HubState {
  const state = hubs.find((candidate) => candidate.hub.row.id === id);
  return state ?? fail("hub_not_found", "저장된 컴퓨터 목록에 없는 id 입니다");
}

function sessionOf(sessionId: string): { hub: DemoHub; session: DemoSession } | undefined {
  for (const state of hubs) {
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (session) return { hub: state.hub, session };
  }
  return undefined;
}

function repoOf(sessionId: string): RepoState {
  let repo = repos.get(sessionId);
  if (!repo) {
    const found = sessionOf(sessionId);
    const git = found?.session.git;
    const current = found?.session.branch ?? "main";
    repo = {
      files: filesFor(sessionId),
      commits: sessionId === "s-pay-retry" ? COMMITS.map((commit) => ({ ...commit })) : [],
      branch: current,
      branches: BRANCHES.filter((branch) => branch.name !== current)
        .map((branch) => ({ name: branch.name, when: branch.when }))
        .concat([{ name: current, when: "방금" }]),
      ahead: git?.ahead ?? 0,
      behind: git?.behind ?? 0,
      review: sessionId === "s-pay-retry" ? { ...REVIEW } : null,
    };
    repos.set(sessionId, repo);
  }
  return repo;
}

function listing(): ServerListing {
  return { version: serverVersion, servers: servers.map((server) => ({ ...server })) };
}

function probe(state: HubState): HubProbe {
  const now = Date.now();
  return {
    id: state.hub.row.id,
    box_label: state.hub.row.box_label,
    device_label: state.hub.deviceLabel,
    relay_offered: state.hub.row.relay_offered,
    sessions: state.sessions.map((session) => toProbeSession(state.hub, session, now)),
    layout: toLayout(state.hub, state.sessions),
    layout_note: null,
    direct_pairing: null,
    direct_pairing_error: null,
    unreachable: [],
  };
}

function outcome(sessionId: string, want: string | null): SourceControlOutcome {
  const repo = repoOf(sessionId);
  const found = sessionOf(sessionId);
  const base: SourceControlOutcome = {
    read: true,
    branch: repo.branch,
    files: [],
    ahead: repo.ahead,
    behind: repo.behind,
    base_ref: "main",
    detail: null,
    comparison: "merge_base",
    root: found?.session.cwd ?? `${FOLDER_ROOT}/Dev`,
    code: null,
    files_read: false,
    reviewers: [],
    reviewers_read: false,
    commit_body: null,
    branches: [],
    branches_read: false,
    commits: [],
    commits_read: false,
    review: null,
    review_read: false,
  };
  switch (want) {
    case "commits":
      return { ...base, commits: repo.commits.map((commit) => ({ ...commit })), commits_read: true };
    case "pull_request":
      return { ...base, review: repo.review ? { ...repo.review } : null, review_read: true };
    case "branches":
      return {
        ...base,
        branches: repo.branches.map((branch) => ({
          name: branch.name,
          current: branch.name === repo.branch,
          checked_out_at: branch.name === "main" && repo.branch !== "main" ? base.root : null,
          when: branch.when,
        })),
        branches_read: true,
      };
    case "reviewers":
      return { ...base, reviewers: REVIEWERS.map((reviewer) => ({ ...reviewer })), reviewers_read: true };
    default:
      return { ...base, files: repo.files.map((file) => ({ ...file })), files_read: true };
  }
}

function diff(sessionId: string, path: string): FileDiffOutcome {
  const repo = repoOf(sessionId);
  const file = repo.files.find((candidate) => candidate.path === path);
  const binary = file !== undefined && file.added === null && file.deleted === null;
  return {
    read: true,
    path,
    patch: binary ? null : patchFor(path, file),
    truncated: false,
    binary,
    added: file?.added ?? 3,
    deleted: file?.deleted ?? 1,
    code: null,
    detail: null,
  };
}

function write(sessionId: string, action: ScmWriteAction): SourceControlOutcome {
  const repo = repoOf(sessionId);
  switch (action.kind) {
    case "commit": {
      const chosen = new Set(action.paths);
      repo.files = repo.files.filter((file) => !chosen.has(file.path));
      commitsMade += 1;
      repo.commits.unshift({
        short_sha: `d${(0x3e8f10 + commitsMade * 0x1531).toString(16).slice(0, 6)}`,
        subject: action.message.split("\n")[0] || "변경 사항",
        author: "seung",
        when: "방금",
      });
      repo.ahead += 1;
      break;
    }
    case "discard": {
      const chosen = new Set(action.paths);
      repo.files = repo.files.filter((file) => !chosen.has(file.path));
      break;
    }
    case "checkout":
      if (!repo.branches.some((branch) => branch.name === action.branch)) {
        return { ...outcome(sessionId, "changes"), read: false, code: "branch_not_found", detail: `브랜치가 없습니다: ${action.branch}` };
      }
      repo.branch = action.branch;
      break;
    case "create_branch":
      repo.branches.push({ name: action.name, when: "방금" });
      repo.branch = action.name;
      repo.ahead = 0;
      break;
    case "push":
      repo.ahead = 0;
      break;
  }
  return outcome(sessionId, "changes");
}

function providerFor(kindId: string): string {
  if (kindId === "claude") return "claude-code";
  return kindId;
}

function startAgent(hubId: string, input: Args): StartAgentOutcome {
  const state = hubState(hubId);
  const targetId = str(input, "targetId");
  const kindId = str(input, "kindId");
  const folderPath = typeof input.folderPath === "string" ? input.folderPath : undefined;
  const target = LAUNCH_OFFER.targets.find((candidate) => candidate.id === targetId);
  const kind = LAUNCH_OFFER.kinds.find((candidate) => candidate.id === kindId);
  if (!kind) return { started: false, agent_id: null, session_id: null, detail: "모르는 종류입니다", code: "unknown_kind" };
  if (!kind.installed) {
    return {
      started: false,
      agent_id: null,
      session_id: null,
      detail: `${kind.label} 이(가) 이 컴퓨터에 설치되어 있지 않습니다`,
      code: "provider_not_installed",
    };
  }
  const segments = folderPath ? folderPath.split("/").filter(Boolean) : [];
  const folder = folderPath ? segments[segments.length - 1] ?? "폴더" : target?.folder_label ?? "폴더";
  startedAgents += 1;
  const id = `s-new-${startedAgents}`;
  const useWorktree = input.useWorktree === true;
  const branch = typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : undefined;
  const session: DemoSession = {
    id,
    name: `${kind.label} · ${folder}`,
    desktop: target?.space_label ?? "Main",
    project: folder,
    branch: useWorktree ? branch ?? `agent/${kindId}-${startedAgents}` : "main",
    provider: providerFor(kindId),
    kind: "agent",
    lifecycle: "starting",
    display: "connecting",
    detail: "시작하는 중",
    agoMinutes: 0,
    cwd: folderPath ?? `${FOLDER_ROOT}/Dev/${folder}`,
    git: { ahead: 0, behind: 0, committed: 0, worktree: 0 },
  };
  state.sessions = [session, ...state.sessions];
  setTimeout(() => {
    state.sessions = state.sessions.map((candidate) =>
      candidate.id === id
        ? { ...candidate, lifecycle: "running", display: "working", detail: "관련 파일을 읽는 중" }
        : candidate,
    );
  }, 1_800);
  return { started: true, agent_id: `agent-${startedAgents}`, session_id: id, detail: null, code: null };
}

function browse(path: string | null): FolderBrowserOutcome {
  const target = path ?? FOLDER_ROOT;
  if (target !== FOLDER_ROOT && !target.startsWith(`${FOLDER_ROOT}/`)) {
    return { ok: false, path: null, entries: [], detail: "홈 밖의 경로는 열 수 없습니다", code: "outside_home" };
  }
  return {
    ok: true,
    path: target,
    entries: (folders[target] ?? []).map((entry) => ({ ...entry })),
    detail: null,
    code: null,
  };
}

function createFolder(parent: string, name: string): FolderBrowserOutcome {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/")) {
    return { ok: false, path: null, entries: [], detail: "폴더 이름에 쓸 수 없는 글자가 있습니다", code: "invalid_name" };
  }
  const path = `${parent}/${trimmed}`;
  if (!folders[parent]) folders[parent] = [];
  const siblings = folders[parent];
  if (siblings.some((entry) => entry.name === trimmed)) {
    return { ok: false, path: null, entries: [], detail: "같은 이름의 폴더가 이미 있습니다", code: "exists" };
  }
  siblings.push({ name: trimmed, path });
  siblings.sort((left, right) => left.name.localeCompare(right.name, "ko"));
  folders[path] = [];
  return { ok: true, path, entries: [], detail: null, code: null };
}

function adoptStudio(): HubState {
  const known = hubs.find((state) => state.hub.row.id === STUDIO_HUB_ID);
  if (known) return known;
  const studio = DEMO_HUBS[0];
  const state: HubState = { hub: studio, sessions: [...studio.sessions], opens: 0 };
  hubs = [state, ...hubs];
  return state;
}

function pairingOutcome(): PairingOutcome {
  if (!servers.some((server) => server.id === SDD_SERVER.id)) {
    servers = [{ ...SDD_SERVER }, ...servers];
    serverVersion += 1;
  }
  return {
    device_id: "phone-demo-7f3a",
    adopted: listing().servers,
    refused: [],
    key_algorithm: "ed25519",
  };
}

function remoteSession(session: unknown): RemoteSession {
  if (typeof session !== "object" || session === null || typeof (session as RemoteSession).session_id !== "string") {
    fail("invalid_session", "세션이 없습니다");
  }
  return session as RemoteSession;
}

// ── Commands ───────────────────────────────────────────────────────────────

const handlers: Record<string, Handler> = {
  list_servers: () => listing(),
  "plugin:notification|is_permission_granted": () => true,
  reset_device: () => {
    hubs = [];
    servers = [];
    serverVersion += 1;
    repos.clear();
  },
  save_server: (args) => {
    const entry = record(args, "entry");
    const id = str(entry, "id") || `srv-${Date.now()}`;
    const row: ServerRow = {
      id,
      label: str(entry, "label"),
      host: str(entry, "host"),
      port: typeof entry.port === "number" ? entry.port : 22,
      username: str(entry, "username"),
      host_key_fingerprint: str(entry, "host_key_fingerprint"),
      paired: entry.paired === true,
      attach_key_confinement: str(entry, "attach_key_confinement"),
      has_attach_key: true,
      has_list_key: true,
    };
    servers = servers.some((server) => server.id === id)
      ? servers.map((server) => (server.id === id ? { ...server, ...row } : server))
      : [...servers, row];
    serverVersion += 1;
    return listing();
  },
  add_ssh_host: (args): SshHostAdded => {
    const draft = record(args, "draft");
    const row: ServerRow = {
      id: str(draft, "id") || `srv-${Date.now()}`,
      label: str(draft, "label") || str(draft, "host"),
      host: str(draft, "host"),
      port: typeof draft.port === "number" ? draft.port : 22,
      username: str(draft, "username"),
      host_key_fingerprint: "SHA256:Zt8kQ1vN4mLp6yRc2wHs9aXe3bJf7gUo5iDn0tVbMqK",
      paired: false,
      attach_key_confinement: "account_wide",
      has_attach_key: true,
      has_list_key: true,
    };
    servers = [...servers.filter((server) => server.id !== row.id), row];
    serverVersion += 1;
    return { listing: listing() };
  },
  read_ssh_private_key: () =>
    "-----BEGIN OPENSSH PRIVATE KEY-----\nZGVtbyBrZXkgLSBub3QgYSByZWFsIGtleQ==\n-----END OPENSSH PRIVATE KEY-----\n",
  delete_server: (args) => {
    const id = str(args, "id");
    servers = servers.filter((server) => server.id !== id);
    serverVersion += 1;
    return listing();
  },
  server_public_key: (args) =>
    `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyForDurePhone${str(args, "id").replace(/[^a-z0-9]/gi, "")} dure-mobile@demo`,
  save_identity: (args) => {
    const id = str(args, "serverId");
    const role = str(args, "role");
    servers = servers.map((server) =>
      server.id === id
        ? { ...server, has_attach_key: role === "attach" || server.has_attach_key, has_list_key: role === "list" || server.has_list_key }
        : server,
    );
    serverVersion += 1;
    return listing();
  },
  discover_sessions: (args) => {
    const id = str(args, "serverId");
    if (!servers.some((server) => server.id === id)) fail("server_not_found", "저장된 서버가 아닙니다");
    return sshSessions(id);
  },
  take_session_census: (): ServerReport[] => servers.map((server) => censusReport(server)),
  pairing_flow_for: (args) => {
    const scanned = str(args, "scanned").trim();
    if (/^https?:\/\//i.test(scanned)) return "link";
    if (/^[A-Z0-9-]{6,8}$/i.test(scanned)) return "offline";
    return "hub";
  },
  hub_probe: () => {
    const state = adoptStudio();
    state.opens += 1;
    return probe(state);
  },
  hub_preview: (): HubOfferPreview => ({
    box_label: DEMO_HUBS[0].row.box_label,
    endpoint: DEMO_HUBS[0].row.endpoint,
    fingerprint: STUDIO_HUB_ID,
    relay_offered: true,
  }),
  hub_create_pull_request: (args) => {
    const sessionId = str(args, "sessionId");
    const repo = repoOf(sessionId);
    repo.review = {
      ...REVIEW,
      number: 813 + commitsMade,
      title: str(args, "title") || repo.commits[0]?.subject || "변경 사항",
      is_draft: args.draft === true,
      requested_reviewers: [],
      review_decision: "",
      checks: { total: 2, passed: 0, failed: 0, pending: 2 },
    };
    repo.ahead = 0;
    return outcome(sessionId, "pull_request");
  },
  hub_git_status: (args) => {
    hubState(str(args, "id"));
    return outcome(str(args, "sessionId"), typeof args.want === "string" ? args.want : null);
  },
  hub_launch_offer: (args): LaunchOffer => {
    hubState(str(args, "id"));
    return { ...LAUNCH_OFFER, targets: LAUNCH_OFFER.targets.map((target) => ({ ...target })) };
  },
  hub_browse_folder: (args) => {
    hubState(str(args, "id"));
    return browse(typeof args.path === "string" ? args.path : null);
  },
  hub_create_folder: (args) => {
    hubState(str(args, "id"));
    return createFolder(str(args, "parent"), str(args, "name"));
  },
  hub_start_agent: (args) => startAgent(str(args, "id"), record(args, "input")),
  ssh_git_status: (args) => outcome(str(args, "sessionId"), typeof args.want === "string" ? args.want : null),
  hub_file_diff: (args) => {
    hubState(str(args, "id"));
    return diff(str(args, "sessionId"), str(args, "path"));
  },
  ssh_create_session: (args): CreatedSessionOutcome => {
    const serverId = str(args, "serverId");
    if (!servers.some((server) => server.id === serverId)) fail("server_not_found", "저장된 서버가 아닙니다");
    return {
      started: false,
      session: null,
      code: "create_not_allowed",
      detail: "이 키로는 세션을 만들 수 없습니다. 서버의 authorized_keys 줄에 --allow-create 를 켜세요.",
    };
  },
  ssh_file_diff: (args) => diff(str(args, "sessionId"), str(args, "path")),
  hub_scm_write: (args) => {
    hubState(str(args, "id"));
    return write(str(args, "sessionId"), args.action as ScmWriteAction);
  },
  hub_commit_detail: (args) => {
    hubState(str(args, "id"));
    const sessionId = str(args, "sessionId");
    const commit = str(args, "commit");
    const repo = repoOf(sessionId);
    const known = repo.commits.find((candidate) => candidate.short_sha === commit);
    return {
      ...outcome(sessionId, "changes"),
      files: repo.files.slice(0, 3).map((file) => ({ ...file, uncommitted: false })),
      commit_body: known?.short_sha === COMMITS[0].short_sha ? COMMIT_BODY : null,
    };
  },
  hub_set_reviewers: (args) => {
    hubState(str(args, "id"));
    const sessionId = str(args, "sessionId");
    const repo = repoOf(sessionId);
    if (repo.review) {
      const add = Array.isArray(args.add) ? (args.add as string[]) : [];
      const remove = new Set(Array.isArray(args.remove) ? (args.remove as string[]) : []);
      repo.review = {
        ...repo.review,
        requested_reviewers: [...new Set([...repo.review.requested_reviewers, ...add])].filter((login) => !remove.has(login)),
      };
    }
    return outcome(sessionId, "pull_request");
  },
  hub_list: (): HubRow[] => hubs.map((state) => ({ ...state.hub.row })),
  hub_open: (args) => {
    const state = hubState(str(args, "id"));
    state.opens += 1;
    // The laptop answers once — it is in a bag, on another network — and the
    // list keeps its last answer dimmed, the way the real screen does.
    if (state.hub.row.id === MACBOOK_HUB_ID && state.opens > 1) {
      fail("hub_unreachable", "seung-macbook 에 닿지 못했습니다: 직결 2초 초과, 릴레이 없음");
    }
    return probe(state);
  },
  hub_layouts: (): Record<string, HubLayout> =>
    Object.fromEntries(hubs.map((state) => [state.hub.row.id, toLayout(state.hub, state.sessions)])),
  hub_forget: (args) => {
    const id = str(args, "id");
    const before = hubs.length;
    hubs = hubs.filter((state) => state.hub.row.id !== id);
    return hubs.length !== before;
  },
  pairing_code_normalize: (args) => {
    const typed = str(args, "typed").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return typed.length === 6 ? typed : null;
  },
  pairing_code_length: () => 6,
  pair_offline: () => pairingOutcome(),
  pair_from_scan: () => pairingOutcome(),
  attach_session: (args): AttachedSession => {
    const serverId = str(args, "serverId");
    if (!servers.some((server) => server.id === serverId)) fail("server_not_found", "저장된 서버가 아닙니다");
    return terminals.attach(remoteSession(args.session), args.writable === true);
  },
  attach_hub_session: (args): AttachedSession => {
    hubState(str(args, "hubId"));
    return terminals.attach(remoteSession(args.session), args.writable === true);
  },
  detach_session: (args) =>
    terminals.detach(typeof args.attachmentId === "string" ? args.attachmentId : undefined),
  next_terminal_record: (args) => terminals.next(str(args, "attachmentId")),
  send_terminal_record: (args) => {
    const raw = args.record;
    const bytes = Array.isArray(raw) ? Uint8Array.from(raw as number[]) : new Uint8Array(0);
    return terminals.send(str(args, "attachmentId"), bytes);
  },
  device_identity_status: () => ({
    state: "not_provisioned",
    reason: "데모 빌드에는 기기 키가 없습니다",
    planned_algorithm: "ed25519",
  }),
  client_runtime_info: () => ({
    protocol_major: 1,
    protocol_minor: 6,
    withheld_over_relay: [],
    limitations: [{ kind: "demo", message: "데모 빌드 — 모든 데이터는 지어낸 것입니다" }],
  }),
  // Commands main grew after the demo was scripted (#816, #842, #845). The
  // demo's sessions never rehost, so a session's successor is itself; there is
  // no push service to register with, and a pasted file is "staged" by name.
  resolve_session_successor: (args) => ({ state: "resolved", session: remoteSession(args.session) }),
  resolve_hub_session_successor: (args) => ({ state: "resolved", session: remoteSession(args.session) }),
  sync_push_notifications: () => ({ supported: false, outcomes: [] }),
  hub_stage_session_file: (args): string[] => [`/tmp/dure-demo/${str(record(args, "file"), "fileName")}`],
};

/** How long each command pretends to take, so the screens' waiting states show. */
const LATENCY_MS: Record<string, number> = {
  hub_open: 320,
  hub_probe: 900,
  hub_preview: 150,
  take_session_census: 600,
  discover_sessions: 400,
  hub_git_status: 380,
  ssh_git_status: 450,
  hub_file_diff: 260,
  ssh_file_diff: 320,
  hub_scm_write: 700,
  hub_create_pull_request: 1_100,
  hub_set_reviewers: 500,
  hub_commit_detail: 260,
  hub_launch_offer: 300,
  hub_browse_folder: 220,
  hub_create_folder: 300,
  hub_start_agent: 1_200,
  attach_session: 420,
  attach_hub_session: 380,
  add_ssh_host: 900,
  pair_offline: 800,
  pair_from_scan: 800,
  ssh_create_session: 500,
};

export const DEMO_COMMANDS: readonly string[] = Object.keys(handlers);

/** Drop-in for Tauri's `invoke`. Unknown commands are refused, never faked. */
export async function demoInvoke<T>(
  cmd: string,
  args?: InvokeArgs,
  _options?: InvokeOptions,
): Promise<T> {
  const handler = handlers[cmd];
  if (!handler) fail("demo_unsupported", `데모 빌드가 모르는 명령입니다: ${cmd}`);
  const latency = LATENCY_MS[cmd];
  if (latency) await wait(latency);
  const plain: Args = typeof args === "object" && args !== null && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array)
    ? (args as Args)
    : {};
  return (await handler(plain)) as T;
}

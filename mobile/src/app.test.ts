/** Mobile app wiring from a Tauri attach receipt to complete TerminalSurface records. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import packageMetadata from "../package.json";
import { HOLD_MS } from "./holdDrag";
import { t } from "./i18n";
import type { HubProbeSession, LaunchOffer, SessionResolution } from "./ipc";
import type { RemoteSession } from "./sessions";
import { HELP_URL } from "./openExternal";
import { HOLD_DELAY_MS } from "./pressHold";
import { PAD_COLS, PAD_TEXT } from "./spaceTrackpad";
import { TERMINAL_KEYS } from "./terminalKeys";
import {
  DEFAULT_SETTINGS_PREFERENCES,
  loadSettingsPreferences,
  saveSettingsPreferences,
} from "./settingsPreferences";

/** `invoke` 호출 기록. 명령 이름과 인자. */
const invocations: { command: string; args: Record<string, unknown> }[] = [];
/** `pair_offline` 이 받은 인자. 코드가 정규화돼 넘어가는지 본다. */
const offlineCalls: { scanned: string; code: string }[] = [];
/** 이 상자의 키가 생성까지 허용되지 않은 경우를 켠다. */
let createRefusal = false;
let pairFromScanError: unknown;
let rejectNextHubStart = false;
let hubLaunchOffer: LaunchOffer | undefined;
let hubStartedSessionId: string | null = null;
let hubCatalogSessions: HubProbeSession[] | undefined;
let discoveredSessions: RemoteSession[] | undefined;
let discoveryError: unknown;
let successorResolution: SessionResolution = { state: "unknown" };
let successorError: unknown;
let holdSuccessor = false;
let releaseSuccessor: (() => void) | undefined;
const sentTerminalRecords: Uint8Array[] = [];
let grantedTerminalCapabilities = ["terminal_surface_v1"];
const terminalReads = new Map<string, number>();
const pendingTerminalReads = new Map<string, {
  resolve: (record: ArrayBuffer) => void;
  reject: (error: unknown) => void;
}>();
let rejectNextTerminalSend = false;
/** Records the pump hands out after the first viewport frame, in order — the relay's control records. */
const queuedRecords: Uint8Array[] = [];
let holdServerList = false;
let releaseServerList: (() => void) | undefined;
let holdServerMutation: "save" | "delete" | undefined;
let releaseServerMutation: (() => void) | undefined;
let failServerMutation = false;
let sshHostUnreachable = false;
const sshHostDrafts: Record<string, unknown>[] = [];
let holdServerDiscovery = false;
let releaseServerDiscovery: ((reachable: boolean) => void) | undefined;
let holdCensus = false;
let releaseCensus: (() => void) | undefined;
let failReset = false;
/** What `list_servers` answers; unset means the one loopback lab. */
let serverRows: ReturnType<typeof serverRow>[] | undefined;
/** 참이면 `server_public_key` 가 저장된 키가 없다고 거부한다. */
let failPublicKey = false;
/** 참이면 `hub_forget` 이 저장소 오류로 거부한다. */
let rejectHubForget = false;
/** 참이면 쓰기 attach만 거부한다. 노트북이 리스를 쥐고 있는 상태를 흉내낸다. */
let refuseWritableAttach = false;
let holdNextWritableAttach = false;
let releaseHeldWritableAttach: ((outcome: "success" | "superseded") => void) | undefined;
let holdNextDetach = false;
let releaseHeldDetach: (() => void) | undefined;
let nextAttachment = 0;
let activeAttachmentId: string | undefined;
let finishScmWrite: ((failure?: string) => void) | undefined;
/** Branch returned by the live source-control read. */
let scmBranch = "main";

// Native plugin fakes. Plugin JS under node_modules is externalized by vitest,
// so a plugin's own `import { invoke } from "@tauri-apps/api/core"` resolves
// to the REAL core and bypasses the core mock above (`TypeError: Cannot read
// properties of undefined (reading 'invoke')`, zero invocations). Each plugin
// is therefore mocked by module id, which the dynamic `await import(...)` in
// app.ts does intercept. Never add `case "plugin:…"` branches to the core
// invoke switch for a command a plugin's JS sends — they would be dead. The
// one such case below is a command `ipc.ts` sends itself, on purpose.
/** URLs handed to the opener plugin, in order. */
const openedUrls: string[] = [];
/** 참이면 opener가 거부한다. 진짜 플러그인처럼 문자열로 reject한다. */
let failOpen = false;
/** Texts handed to the clipboard plugin, in order. */
const copiedTexts: string[] = [];
let failCopy = false;
/** Impact styles handed to the haptics plugin, in order. */
const impacts: string[] = [];
/** Biometric fakes default to "plugin not found" so the Face ID row stays inert. */
let biometricStatus: () => Promise<unknown> = () => Promise.reject(new Error("plugin not found"));
let biometricAuth: (reason: string, options?: unknown) => Promise<unknown> = () =>
  Promise.reject(new Error("plugin not found"));
/** Notifications handed to the notification plugin, in order. */
const sentNotifications: unknown[] = [];
/** What the system reports as the notification permission state, right now. */
let notificationPermission: "granted" | "denied" | "default" = "default";
let pushSupported = false;
let pushFailure: string | null = null;
/**
 * What the notification plugin's JS surface believes: the real plugin snapshots
 * the state once at page load and only refreshes it from `requestPermission`,
 * so a decision made in the system settings while the app runs never reaches
 * `isPermissionGranted()`. The direct `plugin:notification|is_permission_granted`
 * invoke is the read that does.
 */
let pluginPermissionCache: "granted" | "denied" | "default" = "default";
/** How many times the app asked the system for notification permission. */
let permissionRequests = 0;
/** What the person answers on the system sheet, the one time it is shown. */
let sheetAnswer: "granted" | "denied" = "granted";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => {
    openedUrls.push(url);
    return failOpen ? Promise.reject(`Not allowed to open url ${url}`) : Promise.resolve();
  },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => {
    copiedTexts.push(text);
    return failCopy ? Promise.reject("clipboard refused") : Promise.resolve();
  },
}));
vi.mock("@tauri-apps/plugin-haptics", () => ({
  impactFeedback: (style: string) => {
    impacts.push(style);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/plugin-biometric", () => ({
  checkStatus: () => biometricStatus(),
  authenticate: (reason: string, options?: unknown) => biometricAuth(reason, options),
}));
/** What the system file picker answers, or `undefined` when it is dismissed. */
let pickedPath: string | undefined;
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => Promise.resolve(pickedPath ?? null),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  // Mirrors the real plugin: `true` granted, `false` denied, `null` while the
  // system has not been asked — despite the `Promise<boolean>` it is typed as.
  isPermissionGranted: () => {
    if (pluginPermissionCache === "default") pluginPermissionCache = notificationPermission;
    return Promise.resolve(
      pluginPermissionCache === "granted"
        ? true
        : pluginPermissionCache === "denied"
          ? false
          : null,
    );
  },
  // Like the OS: the sheet decides once; every later request answers that decision.
  requestPermission: () => {
    permissionRequests += 1;
    if (notificationPermission === "default") notificationPermission = sheetAnswer;
    pluginPermissionCache = notificationPermission;
    return Promise.resolve(notificationPermission);
  },
  sendNotification: (options: unknown) => {
    sentNotifications.push(options);
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: Record<string, unknown> = {}) => {
    invocations.push({ command, args });
    switch (command) {
      case "list_servers":
        if (holdServerList) {
          holdServerList = false;
          return new Promise((resolve) => {
            releaseServerList = () => resolve({ version: 3, servers: serverRows ?? [serverRow()] });
          });
        }
        return Promise.resolve({ version: 3, servers: serverRows ?? [serverRow()] });
      case "reset_device":
        if (failReset) {
          failReset = false;
          return Promise.reject(new Error("reset failed"));
        }
        hubRows = [];
        return Promise.resolve();
      case "save_server":
        if (failServerMutation) {
          failServerMutation = false;
          return Promise.reject(new Error("save failed"));
        }
        if (holdServerMutation === "save") {
          holdServerMutation = undefined;
          return new Promise((resolve) => {
            releaseServerMutation = () => resolve({ version: 3, servers: [args.entry] });
          });
        }
        return Promise.resolve({ version: 3, servers: [args.entry] });
      case "add_ssh_host": {
        const draft = args.draft as Record<string, unknown> & {
          id: string;
          label: string;
          host: string;
          port: number;
          username: string;
        };
        sshHostDrafts.push(draft);
        if (sshHostUnreachable) {
          return Promise.reject({
            code: "hmux_ssh_connect_failed",
            message: "연결하지 못했습니다",
          });
        }
        return Promise.resolve({
          listing: {
            version: 3,
            servers: [
              {
                ...draft,
                // 지문은 호스트가 준 것이다 — 폼은 그것을 묻지 않는다.
                host_key_fingerprint: "SHA256:learned",
                paired: false,
                attach_key_confinement: "",
                has_attach_key: true,
                has_list_key: true,
              },
            ],
          },
        });
      }
      case "delete_server":
        if (holdServerMutation === "delete") {
          holdServerMutation = undefined;
          return new Promise((resolve) => {
            releaseServerMutation = () => resolve({ version: 3, servers: [] });
          });
        }
        return Promise.resolve({ version: 3, servers: [] });
      case "server_public_key":
        if (failPublicKey) {
          return Promise.reject({ code: "identity_missing", message: "저장된 키가 없습니다" });
        }
        return Promise.resolve(storedPublicKeyLine);
      case "read_ssh_private_key":
        return Promise.resolve(PICKED_PRIVATE_KEY_PEM);
      case "save_identity": {
        // The public half follows the stored key: a replaced attach key is a
        // different line from then on.
        if (args.role === "attach") storedPublicKeyLine = REPLACED_PUBLIC_KEY_LINE;
        const row = serverRow();
        return Promise.resolve({
          version: 3,
          servers: [
            {
              ...row,
              has_attach_key: true,
              has_list_key: args.role === "list" || row.has_list_key,
            },
          ],
        });
      }
      case "client_runtime_info":
        return Promise.resolve({
          protocol_major: 1,
          protocol_minor: 0,
          withheld_over_relay: ["shared_terminal_input"],
          limitations: [{ kind: "read_only", message: "읽기 전용" }],
        });
      case "device_identity_status":
        return Promise.resolve({
          state: "not_provisioned",
          reason: "하드웨어 키 없음",
          planned_algorithm: "ecdsa-sha2-nistp256",
        });
      case "discover_sessions":
        if (discoveryError !== undefined) return Promise.reject(discoveryError);
        if (holdServerDiscovery) {
          holdServerDiscovery = false;
          return new Promise((resolve, reject) => {
            releaseServerDiscovery = (reachable) =>
              reachable
                ? resolve(discoveredSessions ?? [remoteSession()])
                : reject(new Error("old endpoint unavailable"));
          });
        }
        return Promise.resolve(discoveredSessions ?? [remoteSession()]);
      case "resolve_session_successor":
      case "resolve_hub_session_successor":
        if (holdSuccessor) return new Promise((resolve, reject) => {
          releaseSuccessor = () => successorError ? reject(successorError) : resolve(successorResolution);
        });
        if (successorError) return Promise.reject(successorError);
        return Promise.resolve(successorResolution);
      case "take_session_census":
        if (holdCensus) {
          holdCensus = false;
          return new Promise((resolve) => {
            releaseCensus = () => resolve(censusReports);
          });
        }
        return Promise.resolve(censusReports);
      case "pairing_flow_for": {
        // 스캔한 텍스트로 흐름을 가른다. 접두사 판별은 Rust 가 하므로 여기서는
        // 그 계약만 흉내낸다.
        const scanned = String((args as { scanned?: string }).scanned ?? "");
        if (scanned.startsWith("dure-hub:")) return Promise.resolve("hub");
        if (scanned.startsWith("https://") || scanned.startsWith("http://")) {
          return Promise.resolve("link");
        }
        return Promise.resolve(scanned.startsWith("hmux-pair:2") ? "offline" : "online");
      }
      case "hub_list":
        return Promise.resolve(hubRows);
      case "hub_layouts":
        return Promise.resolve(hubLayouts);
      case "hub_preview":
        // Decoded, not connected: the confirm screen runs before any socket
        // opens, so this answers from the payload alone.
        return Promise.resolve({
          box_label: "맥북",
          endpoint: "192.168.0.12:47821",
          fingerprint: HUB_ID,
          relay_offered: true,
        });
      case "hub_probe":
        return Promise.resolve(hubProbe());
      case "hub_open":
        // 노트북이 꺼져 있는 상태. 이 폰은 그 컴퓨터의 로컬 세션을 못 본다.
        if (hubUnreachable) return Promise.reject(new Error("연결하지 못했습니다"));
        // 느린 연결을 흉내낸다. 참이면 `releaseHubOpen()`을 부를 때까지 답이
        // 오지 않는다 — 실제로 12초까지 걸리는 호출이다.
        if (!holdHubOpen) return Promise.resolve(hubProbe());
        return new Promise((resolve) => {
          releaseHubOpen = () => resolve(hubProbe());
        });
      case "hub_forget": {
        if (rejectHubForget) return Promise.reject(new Error("store locked"));
        const id = String((args as { id?: string }).id ?? "");
        const before = hubRows.length;
        hubRows = hubRows.filter((row) => row.id !== id);
        return Promise.resolve(hubRows.length !== before);
      }
      case "pairing_code_length":
        return Promise.resolve(6);
      case "pairing_code_normalize": {
        const typed = String((args as { typed?: string }).typed ?? "")
          .replace(/[\s-]/g, "")
          .toUpperCase();
        return Promise.resolve(typed.length === 6 ? typed : null);
      }
      case "pair_offline":
        offlineCalls.push(args as { scanned: string; code: string });
        return Promise.resolve({
          device_id: "",
          adopted: [serverRow()],
          refused: [],
          key_algorithm: "ssh-ed25519",
        });
      case "pair_from_scan":
        if (pairFromScanError !== undefined) return Promise.reject(pairFromScanError);
        return Promise.resolve({
          device_id: "device-1",
          adopted: [serverRow()],
          refused: [
            {
              label: "오래된 서버",
              host: "old.example",
              port: 22,
              detail: "hmux 설치 실패",
            },
          ],
          key_algorithm: "ssh-ed25519",
        });
      case "attach_session":
      case "attach_hub_session": {
        const attachmentId = `test-attach-${++nextAttachment}`;
        const attached = {
          session_id:
            (args.session as { session_id?: string } | undefined)?.session_id ?? SESSION_ID,
          attestation: "relayed (no colocation witness)",
          granted_capabilities: grantedTerminalCapabilities,
          withheld_over_relay: [
            "shared_terminal_input",
            "standalone_termination_v1",
            "agent_state_report_v1",
          ],
          role: args.writable ? "controller" : "observer",
          terminal: {
            attachment_id: attachmentId,
            terminal_epoch: "epoch-1",
            through_output_seq: "1",
            state_revision: "1",
            initial_delivery_record_count: 1,
          },
        };
        const activate = () => {
          activeAttachmentId = attachmentId;
          return attached;
        };
        if (holdNextWritableAttach && args.writable) {
          holdNextWritableAttach = false;
          return new Promise((resolve, reject) => {
            releaseHeldWritableAttach = (outcome) => {
              if (outcome === "success") {
                resolve(activate());
                return;
              }
              reject({
                code: "terminal_attach_superseded",
                message: "A newer terminal attach started",
              });
            };
          });
        }
        if (refuseWritableAttach && args.writable) {
          return Promise.reject({
            code: "hmux_controller_conflict",
            message: "Another client controls this Hmux session",
          });
        }
        return Promise.resolve(activate());
      }
      case "next_terminal_record": {
        const attachmentId = String(args.attachmentId ?? "");
        const reads = terminalReads.get(attachmentId) ?? 0;
        terminalReads.set(attachmentId, reads + 1);
        if (reads > 0) {
          const queued = queuedRecords[reads - 1];
          if (!queued) return new Promise<ArrayBuffer>((resolve, reject) => {
            pendingTerminalReads.set(attachmentId, { resolve, reject });
          });
          return Promise.resolve(
            queued.buffer.slice(queued.byteOffset, queued.byteOffset + queued.byteLength),
          );
        }
        const record = viewportFrameRecord({
          terminalEpoch: "epoch-1",
          stateRevision: 1n,
          throughOutputSeq: 1n,
          texts: ["ready"],
        });
        return Promise.resolve(
          record.buffer.slice(record.byteOffset, record.byteOffset + record.byteLength),
        );
      }
      case "send_terminal_record":
        sentTerminalRecords.push(Uint8Array.from(args.record as number[]));
        if (rejectNextTerminalSend) {
          rejectNextTerminalSend = false;
          return Promise.reject({ code: "hmux_transport_interrupted", message: "Write interrupted" });
        }
        return Promise.resolve("ok");
      case "detach_session": {
        const detach = () => {
          const attachmentId = args.attachmentId;
          if (
            attachmentId === null ||
            attachmentId === undefined ||
            attachmentId === activeAttachmentId
          ) {
            const detached = activeAttachmentId;
            activeAttachmentId = undefined;
            return detached ?? null;
          }
          return null;
        };
        if (!holdNextDetach) return Promise.resolve(detach());
        holdNextDetach = false;
        return new Promise((resolve) => {
          releaseHeldDetach = () => resolve(detach());
        });
      }
      case "ssh_create_session":
        // 상자가 세션을 하나 만들고 그것을 돌려준다. 켜지 않은 키였다면
        // `started:false` 와 상자의 문장이 온다 — 그 갈래는 아래 시험이 본다.
        return Promise.resolve(
          createRefusal
            ? {
                started: false,
                session: null,
                code: "authorization_denied",
                detail:
                  "a forced-command gateway cannot create remote processes without --allow-create",
              }
            : {
                started: true,
                session: remoteSession(),
                code: null,
                detail: null,
              },
        );
      case "hub_launch_offer":
        // 노트북이 내려보낸 자리와 종류. 폼이 그려지려면 이 답이 있어야 한다.
        return Promise.resolve(hubLaunchOffer ?? {
          published: true,
          targets: [
            {
              id: "t1",
              space_label: "Main",
              folder_label: "dure",
              box_label: "",
              path_hint: "~/dure",
              startable: true,
            },
          ],
          kinds: [{ id: "claude", label: "Claude Code", installed: true }],
        });
      case "hub_git_status":
        return Promise.resolve(scmStatus());
      case "hub_scm_write":
        return new Promise((resolve) => {
          finishScmWrite = (failure) => resolve({
            ...scmStatus(),
            read: failure === undefined,
            detail: failure ?? null,
          });
        });
      case "hub_browse_folder":
        return Promise.resolve({
          ok: true,
          path: (args.path as string | null) ?? "/Users/me",
          entries: [
            { name: "dev", path: "/Users/me/dev" },
            { name: "Projects", path: "/Users/me/Projects" },
          ],
          detail: null,
          code: null,
        });
      case "hub_create_folder":
        return Promise.resolve({
          ok: true,
          path: `${args.parent as string}/${args.name as string}`,
          entries: [],
          detail: null,
          code: null,
        });
      case "hub_start_agent":
        if (rejectNextHubStart) {
          rejectNextHubStart = false;
          return Promise.reject(new Error("response lost"));
        }
        return Promise.resolve({
          started: true,
          agent_id: "a1",
          session_id: hubStartedSessionId,
          detail: null,
          code: null,
        });
      case "sync_push_notifications":
        return Promise.resolve({ supported: pushSupported, outcomes: [{ id: "hub-1", error: pushFailure }] });
      case "plugin:notification|is_permission_granted":
        return Promise.resolve(
          notificationPermission === "granted"
            ? true
            : notificationPermission === "denied"
              ? false
              : null,
        );
      default:
        return Promise.reject(new Error(`unexpected command ${command}`));
    }
  },
}));

const SESSION_ID = "standalone_e55ac90d5fa4";
/** The `authorized_keys` line the fake phone derives from its stored key. */
const PUBLIC_KEY_LINE = "ssh-ed25519 AAAA… dure-mobile";
/** The public half of a key saved over the generated one. */
const REPLACED_PUBLIC_KEY_LINE = "ssh-ed25519 BBBB… pasted-key";
/** What `server_public_key` answers right now — the generated line until a save replaces it. */
let storedPublicKeyLine = PUBLIC_KEY_LINE;
/** What `read_ssh_private_key` answers for the picked file. */
const PICKED_PRIVATE_KEY_PEM =
  "-----BEGIN OPENSSH PRIVATE KEY-----\npicked\n-----END OPENSSH PRIVATE KEY-----";

function serverRow(overrides: Partial<ReturnType<typeof baseServerRow>> = {}) {
  return { ...baseServerRow(), ...overrides };
}

function baseServerRow() {
  return {
    id: "lab",
    label: "Loopback lab",
    host: "127.0.0.1",
    port: 22237,
    username: "kattpish",
    host_key_fingerprint: "SHA256:krpKSjgWfSmiaJCRvXm2jSibE95Y4/hDhN2FJDsr3Wk",
    paired: true,
    attach_key_confinement: "account_wide",
    has_attach_key: true,
    has_list_key: true,
  };
}

/** 첫 화면이 곧 여러 서버를 합친 세션 목록이다. */
let censusReports: unknown[] = [];

const HUB_ID = "SHA256:krpKSjgWfSmiaJCRvXm2jSibE95Y4/hDhN2FJDsr3Wk";

/**
 * 저장된 컴퓨터. 기본은 **비어 있다**.
 *
 * 비워 두는 것이 기본인 이유: 홈의 첫 `.card__row`를 서버 줄로 알고 누르는
 * 시험들이 이미 있고, 컴퓨터가 있으면 그 줄이 위로 온다. 컴퓨터를 보는 시험만
 * 자기 것을 채운다.
 */
let hubRows: {
  id: string;
  box_label: string;
  endpoint: string;
  relay_offered: boolean;
}[] = [];

/** 폰이 기억하고 있는 묶음. 비어 있으면 화면은 묶지 않고 한 줄씩 그린다. */
let hubLayouts: Record<
  string,
  {
    placements: Record<
      string,
      { desktop: string; project: string; order: number; branch?: string }
    >;
    desktop_order: string[];
  }
> = {};

/** 참이면 `hub_open`이 실패한다 — 노트북이 꺼진 상태다. */
let hubUnreachable = false;

/** 참이면 `hub_open`이 `releaseHubOpen()`을 부를 때까지 답하지 않는다. */
let holdHubOpen = false;
let releaseHubOpen: (() => void) | undefined;

function hubRow() {
  return {
    id: HUB_ID,
    box_label: "맥북",
    endpoint: "192.168.0.12:47821",
    relay_offered: true,
  };
}

/** 허브에 붙어 받은 목록. 세션 하나는 살아 있고 하나는 끝나 있다. */
function hubProbe() {
  return {
    id: HUB_ID,
    box_label: "맥북",
    device_label: "내 폰",
    relay_offered: true,
    layout: hubLayouts[HUB_ID] ?? null,
    layout_note: null,
    direct_pairing: null,
    direct_pairing_error: null,
    sessions: hubCatalogSessions ?? [
      {
        ...remoteSession(),
        session_id: "hub-live",
        session_name: "배선",
        workspace_id: "agent-ide",
        provider_id: "claude-code",
        launch_program: null,
        box_id: "this-laptop",
        box_label: "맥북",
      },
      {
        ...remoteSession(),
        session_id: "hub-done",
        session_name: "끝난 것",
        workspace_id: "agent-ide",
        provider_id: "local-shell",
        launch_program: "ssh",
        lifecycle: "exited",
        ready: false,
        box_id: "this-laptop",
        box_label: "맥북",
      },
    ],
    unreachable: [],
  };
}

function remoteSession() {
  return {
    session_id: SESSION_ID,
    session_name: "lab",
    workspace_id: "workspace_64532e59deecf7bb",
    session_class: "standalone",
    lifecycle: "ready",
    provider_id: "shell",
    runner_principal: "local-user",
    runner_instance: "runner_0bed43765b3f47b38e957f9aa9837e79",
    channel_epoch: "1",
    host_instance_id: "host_5dd6168dbe204e5e88a116a7cf66e0f8",
    terminal_epoch: "terminal_68a626fe60be4c069dd3337c4be98535",
    capabilities: ["terminal_surface_v1"],
    ready: true,
  };
}

function scmStatus() {
  return {
    read: true,
    branch: scmBranch,
    files_read: true,
    files: [{ path: "mobile-qa.txt", status: "?", added: 1, deleted: 0, old_path: null, uncommitted: true }],
    ahead: 0,
    behind: 0,
    base_ref: "main",
    code: null,
    detail: null,
  };
}

/**
 * 버튼을 구조로 찾는다. 라벨로 찾지 않는 이유: `t()`가 jsdom의
 * `navigator.language`("en-US")를 보고 영어를 돌려주기 때문에, 한국어 원문으로
 * 찾으면 시험이 로케일에 묶인다. 번역을 하나 고칠 때마다 시험이 깨지는 것은
 * 배선이 깨진 것과 구별되지 않는다.
 */
function pick(root: HTMLElement, selector: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(selector);
  if (!found) throw new Error(`no ${selector} in: ${root.textContent}`);
  return found;
}

/** 설정 화면의 행을 순서가 아니라 id로 찾는다 — 행이 끼어들어도 시험이 그 행을 가리킨다. */
function settingsRow(root: HTMLElement, id: string): HTMLButtonElement {
  return pick(root, `.settings__row[data-row="${id}"]`);
}

/**
 * 손가락 하나로 목록을 끌어내리는 제스처.
 *
 * jsdom 에는 `TouchEvent` 생성자가 없어서 `touches` 를 직접 얹는다. 핸들러가
 * 읽는 것은 `touches[0].clientY` 하나뿐이라 이걸로 충분하고, 진짜 이벤트 경로를
 * 지나므로 배선이 끊기면 이 시험이 먼저 깨진다.
 */
/**
 * 손가락을 줄 위에 얹고 기다린다.
 *
 * jsdom 은 배치를 하지 않으므로 `getBoundingClientRect` 는 전부 0을 준다 — 메뉴가
 * 어디 그려지는지는 `sessionRowMenuPlacement.test.ts` 가 순수 산술로 잡고, 여기서
 * 보는 것은 배선이다.
 */
async function holdRow(row: HTMLElement | undefined): Promise<void> {
  if (!row) throw new Error("no row to hold");
  row.dispatchEvent(
    new PointerEvent("pointerdown", { clientX: 0, clientY: 0, pointerId: 1, bubbles: true }),
  );
  // 진짜 시계로 기다린다. 이 파일은 가짜 타이머를 쓰지 않고, 여기서 켜면 앱이
  // 스스로 걸어 둔 타이머들까지 함께 멈춘다.
  await new Promise((resolve) => setTimeout(resolve, HOLD_DELAY_MS + 20));
}

async function pullDown(root: HTMLElement, distance = 200): Promise<void> {
  const home = root.querySelector<HTMLElement>(".home__body");
  if (!home) throw new Error(`no .home in: ${root.textContent}`);
  const send = (type: string, clientY?: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "touches", {
      value: clientY === undefined ? [] : [{ clientY }],
    });
    home.dispatchEvent(event);
  };
  send("touchstart", 0);
  send("touchmove", distance);
  send("touchend");
  await settle();
}

/** 대기 중인 마이크로태스크와 `queueMicrotask` 렌더를 흘려보낸다. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function openTerminal(): Promise<HTMLElement> {
  const root = await launch();
  pick(root, ".list__open").click();
  await settle();
  return root;
}

/** Native Return reaches the keyboard adapter through beforeinput after keydown. */
function pressReturn(field: HTMLElement): void {
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  field.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "insertLineBreak", bubbles: true, cancelable: true,
  }));
}

interface SentInputSummary {
  case: string;
  text?: string;
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
}

function sentInputIntents(): SentInputSummary[] {
  const summaries: SentInputSummary[] = [];
  for (const encoded of sentTerminalRecords) {
    const body = decodeTerminalStateRecord(encoded).record.body;
    if (body.case !== "inputIntent") continue;
    const intent = body.value.intent;
    if (intent.case === "text") {
      summaries.push({
        case: "text",
        text: new TextDecoder().decode(intent.value.utf8),
      });
    } else if (intent.case === "key") {
      summaries.push({
        case: "key",
        key: intent.value.key,
        code: intent.value.code,
        ctrlKey: (intent.value.modifiers & (1 << 2)) !== 0,
        altKey: (intent.value.modifiers & (1 << 1)) !== 0,
      });
    } else {
      summaries.push({ case: intent.case ?? "unknown" });
    }
  }
  return summaries;
}

function terminalInput(root: HTMLElement): HTMLTextAreaElement {
  const input = root.querySelector<HTMLTextAreaElement>(".structured-terminal__input");
  if (!input) throw new Error(`no terminal input in: ${root.textContent}`);
  return input;
}

/**
 * The paste screen, reached the way a person reaches it.
 *
 * Through 설정 › 컴퓨터 › 컴퓨터 연결: the tab strip's "+" stands only when the
 * strip has a tab (2026-09-15), and these tests start with an empty session
 * list, so the settings door is the one that is always there.
 *
 * The scan button opens the camera screen first; jsdom has no barcode plugin,
 * so the scan reports itself unavailable and the screen offers the paste route
 * — the same door the mockup puts there for a phone whose camera is refused.
 */
async function openPairing(): Promise<HTMLElement> {
  const root = await launch();
  pick(root, ".home__settings").click();
  await settle();
  pick(root, '.settings__row[data-row="computers"]').click();
  await settle();
  pick(root, ".host-settings__add").click();
  await settle();
  pick(root, ".scan__paste").click();
  await settle();
  return root;
}

async function openAllSessions(): Promise<HTMLElement> {
  return launch();
}

// 파일 전체에 건다. describe 마다 손으로 되돌리면, 새로 추가된 describe 하나가
// 앞선 시험이 채워 둔 컴퓨터 목록을 물려받아 홈의 첫 줄이 서버가 아니게 된다 —
// 그 증상은 이 파일 어디에서도 컴퓨터를 언급하지 않는 시험이 깨지는 모양으로
// 나타난다.
beforeEach(() => {
  hubRows = [];
  rejectNextHubStart = false;
  hubLaunchOffer = undefined;
  hubStartedSessionId = null;
  hubCatalogSessions = undefined;
  discoveredSessions = undefined;
  discoveryError = undefined;
  successorResolution = { state: "unknown" };
  successorError = undefined;
  holdSuccessor = false;
  releaseSuccessor = undefined;
  hubLayouts = {};
  hubUnreachable = false;
  holdHubOpen = false;
  releaseHubOpen = undefined;
  holdNextWritableAttach = false;
  releaseHeldWritableAttach = undefined;
  holdNextDetach = false;
  releaseHeldDetach = undefined;
  document.documentElement.removeAttribute("data-keyboard");
  sentTerminalRecords.length = 0;
  grantedTerminalCapabilities = ["terminal_surface_v1"];
  queuedRecords.length = 0;
  terminalReads.clear();
  pendingTerminalReads.clear();
  rejectNextTerminalSend = false;
  holdServerList = false;
  releaseServerList = undefined;
  holdServerMutation = undefined;
  releaseServerMutation = undefined;
  failServerMutation = false;
  holdServerDiscovery = false;
  releaseServerDiscovery = undefined;
  holdCensus = false;
  releaseCensus = undefined;
  failReset = false;
  serverRows = undefined;
  failPublicKey = false;
  rejectHubForget = false;
  nextAttachment = 0;
  activeAttachmentId = undefined;
  finishScmWrite = undefined;
  scmBranch = "main";
  openedUrls.length = 0;
  failOpen = false;
  copiedTexts.length = 0;
  failCopy = false;
  impacts.length = 0;
  biometricStatus = () => Promise.reject(new Error("plugin not found"));
  biometricAuth = () => Promise.reject(new Error("plugin not found"));
  pickedPath = undefined;
  storedPublicKeyLine = PUBLIC_KEY_LINE;
  sentNotifications.length = 0;
  notificationPermission = "default";
  pushSupported = false;
  pushFailure = null;
  pluginPermissionCache = "default";
  permissionRequests = 0;
  sheetAnswer = "granted";
  localStorage.clear();
});

describe("네이티브 플러그인 흉내", () => {
  it("플러그인 모듈은 모듈 단위로 흉내낸다", async () => {
    invocations.length = 0;
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl("https://x/");
    expect(openedUrls).toEqual(["https://x/"]);
    expect(invocations).toEqual([]);
  });

  it("알림 플러그인도 모듈 단위로 흉내낸다", async () => {
    invocations.length = 0;
    const { isPermissionGranted, sendNotification } = await import("@tauri-apps/plugin-notification");
    expect(await isPermissionGranted()).toBeNull();
    sendNotification({ title: "x" });
    expect(sentNotifications).toEqual([{ title: "x" }]);
    expect(invocations).toEqual([]);
  });
});

let disposeApp: (() => void) | undefined;
afterEach(() => {
  disposeApp?.();
  disposeApp = undefined;
});

async function launch(): Promise<HTMLElement> {
  disposeApp?.();
  const { startApp } = await import("./app");
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  disposeApp = startApp(root);
  await settle();
  return root;
}

/**
 * 키보드가 화면 아래를 `covered` 만큼 덮은 것으로 뷰포트를 세우고 알린다.
 *
 * 앱은 포커스가 아니라 **레이아웃 뷰포트와 보이는 뷰포트의 차이**로 키보드를
 * 읽는다(`publishViewport`). 0 을 주면 키보드가 내려간 것이다.
 */
function coverViewport(covered: number): void {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      height: window.innerHeight - covered,
      offsetTop: 0,
      scale: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  window.dispatchEvent(new Event("resize"));
}

function clearViewport(): void {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: undefined,
  });
}

describe("세션 출력 배선", () => {
  beforeEach(() => {
    invocations.length = 0;
    refuseWritableAttach = false;
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
    vi.resetModules();
  });

  it("attach까지 도달하면 터미널이 서버가 말한 크기로 열린다", async () => {
    const root = await openTerminal();

    expect(invocations.map((entry) => entry.command)).toContain("attach_session");
    expect(root.querySelector(".terminal")).not.toBeNull();
    await vi.waitFor(() => expect(root.textContent).toContain("ready"));
    // 쓰기로 붙는 것이 기본이므로 읽기 전용 경고는 없어야 한다.
    expect(root.textContent).not.toContain(
      t("읽기 전용({role}) — 입력은 전달되지 않습니다", { role: "observer" }),
    );
  });

  it("passes the attached Host's wheel capability through to mobile finger scrolling", async () => {
    grantedTerminalCapabilities = ["terminal_surface_v1", "terminal_viewport_wheel_v1"];
    const root = await openTerminal();
    await vi.waitFor(() => expect(root.textContent).toContain("ready"));
    const input = terminalInput(root);
    const host = input.parentElement!;
    for (const [type, clientY] of [["touchstart", 100], ["touchmove", 180], ["touchend", 180]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientX: 100, clientY }] });
      host.dispatchEvent(event);
    }
    await vi.waitFor(() => expect(sentTerminalRecords.some(bytes => {
      const body = decodeTerminalStateRecord(bytes).record.body;
      return body.case === "viewportIntent" && body.value.intent.case === "wheel" && body.value.intent.value.wheelDeltaY < 0;
    })).toBe(true));
  });

  it("레이아웃 없는 직접 SSH 목록에서도 다른 세션으로 전환한다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: {
          state: "listed",
          sessions: [
            remoteSession(),
            {
              ...remoteSession(),
              session_id: "other-session",
              session_name: "other",
            },
          ],
        },
      },
    ];
    const root = await openTerminal();

    pick(root, ".session__icon--sessions").click();
    await settle();

    expect(
      [...root.querySelectorAll(".tray__panel--sessions .session-row__title")].map((row) => row.textContent),
    ).toEqual(["lab", "other"]);
  });

  it("늦은 attach 실패가 더 최근에 연 세션을 관찰 attach로 덮지 않는다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: {
          state: "listed",
          sessions: [
            remoteSession(),
            {
              ...remoteSession(),
              session_id: "newer-session",
              session_name: "newer",
            },
          ],
        },
      },
    ];
    holdNextWritableAttach = true;
    const root = await launch();

    root.querySelectorAll<HTMLButtonElement>(".list__open")[0]?.click();
    await Promise.resolve();
    root.querySelectorAll<HTMLButtonElement>(".list__open")[1]?.click();
    await settle();
    expect(root.textContent).toContain("newer");

    releaseHeldWritableAttach?.("superseded");
    await settle();

    const attaches = invocations.filter((entry) => entry.command === "attach_session");
    expect(attaches.map((entry) => entry.args.writable)).toEqual([true, true]);
    expect(root.textContent).toContain("newer");
    expect(root.querySelector(".terminal")).not.toBeNull();
  });

  /**
   * 붙는 데는 네트워크 너머 노트북이 필요하고 몇 초가 걸린다. 그동안 화면이
   * 전혀 변하지 않으면 느린 연결과 빗나간 터치를 구별할 수 없다.
   *
   * 눌린 그 줄이 말한다 — 상태 점 자리에 로더가 선다.
   */
  it("붙는 동안 그 줄이 로더로 답한다", async () => {
    holdNextWritableAttach = true;
    const root = await launch();

    expect(root.querySelector(".dure-loader:not(.session__state)")).toBeNull();

    pick(root, ".list__open").click();
    await settle();

    const spinning = root.querySelector(".list__open .dure-loader");
    expect(spinning).not.toBeNull();
    // 시안 스펙: 점 여섯 개, 12시부터 60°씩.
    expect(spinning?.querySelectorAll("i")).toHaveLength(6);
    // 로더는 상태 점을 **대신한다** — 둘 다 서면 한 줄이 두 가지를 주장한다.
    expect(root.querySelector(".list__open .dot")).toBeNull();

    releaseHeldWritableAttach?.("success");
    await settle();

    expect(root.querySelector(".dure-loader:not(.session__state)")).toBeNull();
  });

  /**
   * 실패해도 로더는 내려가야 한다. 영원히 도는 점은 앱이 멈춘 것으로 읽힌다.
   */
  it("붙지 못해도 로더는 내려간다", async () => {
    refuseWritableAttach = true;
    holdNextWritableAttach = true;
    const root = await launch();

    pick(root, ".list__open").click();
    await settle();
    releaseHeldWritableAttach?.("success");
    await settle();

    expect(root.querySelector(".dure-loader:not(.session__state)")).toBeNull();
  });

  it("attach 중 뒤로 가면 늦게 성공한 controller 연결을 즉시 놓는다", async () => {
    holdNextWritableAttach = true;
    const root = await launch();

    pick(root, ".list__open").click();
    await Promise.resolve();
    pick(root, ".home__settings").click();
    await settle();
    releaseHeldWritableAttach?.("success");
    await settle();

    expect(root.querySelector(".terminal")).toBeNull();
    expect(invocations.map((entry) => entry.command)).toContain("detach_session");
    const attaches = invocations.filter((entry) => entry.command === "attach_session");
    expect(attaches.map((entry) => entry.args.writable)).toEqual([true]);
  });

  it("늦은 attach 정리가 그 뒤에 열린 세션을 끊지 않는다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: {
          state: "listed",
          sessions: [
            remoteSession(),
            {
              ...remoteSession(),
              session_id: "newer-session",
              session_name: "newer",
            },
          ],
        },
      },
    ];
    holdNextWritableAttach = true;
    const root = await launch();
    root.querySelectorAll<HTMLButtonElement>(".list__open")[0]?.click();
    await Promise.resolve();
    pick(root, ".home__settings").click();
    await settle();

    holdNextDetach = true;
    releaseHeldWritableAttach?.("success");
    await settle();

    // Back out of the 설정 screen the header button opened.
    pick(root, ".settings .icon-tap").click();
    await settle();
    root.querySelectorAll<HTMLButtonElement>(".list__open")[1]?.click();
    await settle();
    const newerAttachmentId = activeAttachmentId;

    releaseHeldDetach?.();
    await settle();

    expect(activeAttachmentId).toBe(newerAttachmentId);
    expect(root.textContent).toContain("newer");
    const detach = invocations.find(
      (entry) => entry.command === "detach_session" && entry.args.attachmentId !== null,
    );
    expect(detach?.args.attachmentId).not.toBe(newerAttachmentId);
  });

  it("지연된 Back 정리가 다시 연 세션을 끊지 않는다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: {
          state: "listed",
          sessions: [
            remoteSession(),
            {
              ...remoteSession(),
              session_id: "newer-session",
              session_name: "newer",
            },
          ],
        },
      },
    ];
    const root = await launch();
    root.querySelectorAll<HTMLButtonElement>(".list__open")[0]?.click();
    await settle();

    holdNextDetach = true;
    // 세션 화면의 뒤로 가기. 시안의 유리 헤더로 바뀌면서 선택자가 옮겨졌다.
    const back = pick(root, ".session__header .icon-tap");
    back.click();
    back.click();
    await settle();

    root.querySelectorAll<HTMLButtonElement>(".list__open")[1]?.click();
    await settle();
    const newerAttachmentId = activeAttachmentId;

    releaseHeldDetach?.();
    await settle();

    expect(activeAttachmentId).toBe(newerAttachmentId);
    expect(root.textContent).toContain("newer");
  });

  /**
   * 관찰로 떨어진 attach는 키를 보내지 않는다.
   *
   * 보내고 서버에서 거부당하는 것과, 아예 보내지 않는 것은 다르다. 앞의 것은
   * 사용자가 고칠 수 없는 오류를 터미널에 찍는다. 그리고 관찰 attach는 리스를
   * 쥐지 않는다는 것이 이 앱이 노트북에게 하는 약속이라, 그 약속을 코드가
   * 아니라 시험이 지켜야 한다.
   */
  it("관찰로 떨어지면 키 입력 경로가 아예 걸리지 않는다", async () => {
    refuseWritableAttach = true;

    const root = await openTerminal();
    const input = terminalInput(root);
    expect(input.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape" }));
    await settle();

    expect(sentInputIntents().some((intent) => intent.case === "key")).toBe(false);
  });

  it("기본 attach에서 텍스트와 Enter가 semantic intent로 간다", async () => {
    const root = await openTerminal();
    const input = terminalInput(root);
    input.value = "안녕";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    pressReturn(input);
    await settle();

    expect(sentInputIntents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ case: "text", text: "안녕" }),
        expect.objectContaining({ case: "key", key: "Enter", code: "Enter" }),
      ]),
    );
    expect(invocations.map((entry) => entry.command)).not.toContain("send_session_input");
  });

  /**
   * 거부된 "입력 켜기"가 화면을 죽은 attach 위에 남기지 않는다.
   *
   * 이 시험이 잡는 실패: 승격 실패를 직전 화면으로 되돌리는 것. `attach_session`은
   * 실패할 수 있는 어떤 일보다 *먼저* 기존 attach를 끊으므로, 터미널 화면에서
   * 거부되면 직전 화면 = 이미 죽은 attach를 가리키는 터미널이다. 사용자에게는
   * 읽기 전용 배너와 다시는 바이트가 오지 않는 빈 터미널로 보인다.
   *
   * 그리고 이건 드문 거부가 아니다 — 노트북 소유자가 그 세션의 리스를 쥐고
   * 있으면 ControllerConflict가 나고, 그게 이 버튼의 가장 흔한 실패다.
   */
  it("입력 켜기가 거부되면 관찰로 되돌아가고 이유를 남긴다", async () => {
    refuseWritableAttach = true;
    const root = await openTerminal();

    pick(root, ".banner__action").click();
    await settle();

    const attaches = invocations.filter((entry) => entry.command === "attach_session");
    // 최초 attach(쓰기 시도 → 거부 → 관찰), 그리고 버튼이 같은 일을 한 번 더.
    expect(attaches.map((entry) => entry.args.writable)).toEqual([true, false, true, false]);
    // 화면이 살아있는 attach 위에 있어야 한다.
    expect(root.querySelector(".terminal")).not.toBeNull();
    // 그리고 왜 켤 수 없었는지가 남아야 한다 — 사람이 읽는 말로.
    expect(root.textContent).toContain(t("읽기 전용 — 다른 곳에서 입력 중입니다"));
    // 프로토콜 문장은 화면에 나오지 않는다. 예전에는 위쪽 빨간 배너에
    // `Hmux Host refused attach (ControllerConflict): … (hmux_controller_conflict)`
    // 가 그대로 떴고, 세션이 **열렸는데도** 열리지 않은 것처럼 읽혔다.
    expect(root.textContent).not.toContain("hmux_controller_conflict");
    expect(root.querySelector(".toast--destructive")).toBeNull();
  });
});

/**
 * 첫 화면이 무엇을 말하는가.
 *
 * 이 앱의 핵심 약속은 "노트북이 꺼져 있어도 폰이 서버에 직접 물어본다"이고,
 * 그 약속이 깨지는 방식은 조용하다 — 한 서버가 대답하지 못하면 목록이 짧아질
 * 뿐이고, 사용자는 없는 세션을 죽은 세션으로 읽는다.
 */
describe("전체 세션 화면", () => {
  beforeEach(() => {
    invocations.length = 0;
    censusReports = [];
    vi.resetModules();
  });

  it("앱을 열면 버튼을 누르지 않아도 모든 서버에 물어본다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];

    const root = await launch();

    expect(invocations.map((entry) => entry.command)).toContain("take_session_census");
    expect(root.querySelector(".session-row__title")?.textContent).toBe("lab");
  });

  /** 다른 기계의 같은 이름 세션을 구분할 수 있어야 한다. */
  it("shows each session machine when Machine is enabled", async () => {
    censusReports = [
      {
        server_id: "a",
        server_label: "가 서버",
        outcome: { state: "listed", sessions: [{ ...remoteSession(), session_id: "session-a" }] },
      },
      {
        server_id: "b",
        server_label: "나 서버",
        outcome: { state: "listed", sessions: [{ ...remoteSession(), session_id: "session-b" }] },
      },
    ];

    localStorage.setItem("dure.homeView.v1", JSON.stringify({ groupBy: "space", visibleFields: ["machine"] }));
    const root = await openAllSessions();

    // 기계 이름은 줄 안의 mono 칸에 있다. 이 화면이 다른 두 목록 화면과 같은
    // 줄 모양을 쓰게 되면서 자리가 바뀌었다 — 말하는 것은 그대로다.
    const labels = [...root.querySelectorAll(".list__open .session-row__mono")].map(
      (node) => node.textContent,
    );
    expect(labels.some((text) => text?.startsWith("가 서버"))).toBe(true);
    expect(labels.some((text) => text?.startsWith("나 서버"))).toBe(true);
  });

  // QA606: Home no longer duplicates connection failures as server cards.
  it("keeps sessions without rendering unanswered-server cards", async () => {
    censusReports = [
      {
        server_id: "a",
        server_label: "가 서버",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
      {
        server_id: "b",
        server_label: "죽은 서버",
        outcome: {
          state: "not_provisioned",
          detail: "bash: hmux: command not found",
        },
      },
      {
        server_id: "c",
        server_label: "느린 서버",
        outcome: { state: "timed_out", seconds: 12 },
      },
    ];

    const root = await openAllSessions();

    const failures = root.querySelector(".failures");
    expect(failures).toBeNull();
    expect(root.textContent).not.toContain("죽은 서버");
    expect(root.textContent).not.toContain("느린 서버");
    expect(root.textContent).not.toContain("command not found");
    // 그래도 살아 있는 세션은 목록에 남아 있어야 한다.
    expect(root.querySelectorAll(".list__open").length).toBe(1);
  });

  it("아무도 대답하지 않은 것을 세션이 없는 것으로 말하지 않는다", async () => {
    censusReports = [
      {
        server_id: "a",
        server_label: "가 서버",
        outcome: { state: "unreachable", code: "x", detail: "y" },
      },
    ];

    const root = await openAllSessions();

    expect(root.textContent).toContain(t("연결하지 못했습니다"));
    expect(root.textContent).not.toContain(t("실행 중인 세션이 없습니다"));
  });
});

describe("페어링", () => {
  beforeEach(() => {
    invocations.length = 0;
    censusReports = [];
    pairFromScanError = undefined;
    vi.resetModules();
  });

  /**
   * 카메라 없이 같은 경로를 끝까지 태운다. 페어링 명령이 스캔한 *문자열*만 받기
   * 때문에 가능한 일이고, 그것이 이 흐름을 폰 없이 검증할 수 있게 하는 설계다.
   */
  it("붙여넣은 코드로 페어링하면 서버 목록과 실패한 서버가 함께 나온다", async () => {
    const root = await openPairing();

    const area = root.querySelector("textarea");
    if (!area) throw new Error("no paste field");
    // `hmux pair start --print-payload`가 실제로 찍는 문자열 모양. JSON이 아니다.
    area.value = "hmux-pair:1?a=192.168.0.12&p=47821&t=dG9rZW4&k=ssh-ed25519&f=Zg&e=1800000000000";
    pick(root, ".paste__submit").click();
    await settle();

    const call = invocations.find((entry) => entry.command === "pair_from_scan");
    expect(call?.args.scanned).toContain("hmux-pair:1?");
    expect(root.textContent).toContain("Loopback lab");
    // 노트북이 등록하지 못한 서버는 반드시 이름을 부른다.
    expect(root.textContent).toContain("오래된 서버");
    expect(root.textContent).toContain("hmux 설치 실패");
  });

  it("영어 화면은 잘못된 페어링 코드의 백엔드 한국어를 노출하지 않는다", async () => {
    pairFromScanError = {
      code: "pairing_not_a_code",
      message: "hmux 페어링 코드가 아닙니다",
    };
    const root = await openPairing();
    const area = root.querySelector("textarea");
    if (!area) throw new Error("no paste field");
    area.value = "not-a-pairing-code";

    pick(root, ".paste__submit").click();
    await settle();

    expect(root.querySelector(".toast")?.textContent).toBe(
      "This is not an hmux pairing code (pairing_not_a_code)",
    );
  });

  /**
   * 스캔은 windowed 모드라 화면을 떠난 뒤에도 카메라가 계속 읽는다. 떠난
   * 화면의 답이 도착해 지금 화면을 갈아끼우면, 폰이 제멋대로 움직이는 것으로
   * 보인다 — 방금 붙여넣던 칸이 사라지는 식이다.
   */
  it("떠난 스캔의 늦은 답이 화면을 빼앗지 않는다", async () => {
    const root = await launch();

    pick(root, ".home__settings").click();
    await settle();
    pick(root, '.settings__row[data-row="computers"]').click();
    await settle();
    pick(root, ".host-settings__add").click();
    // 답이 오기 전에 닫는다. 스캔 화면은 카메라를 열기 전에 이미 떠 있다.
    pick(root, ".scan .icon-tap").click();
    await settle();

    expect(root.querySelector(".scan")).toBeNull();
  });

  /** 개인키가 기기를 떠나지 않는다는 사실과, 그럼에도 평문이라는 사실 둘 다. */
  it("페어링 화면이 키가 평문으로 저장된다는 것을 숨기지 않는다", async () => {
    const root = await openPairing();

    expect(root.querySelector(".pair-warning")?.textContent).toContain(
      t(
        "개인키는 이 기기를 떠나지 않지만, 앱 저장소에 평문 파일로 저장됩니다. Secure Enclave/Keystore가 아닙니다.",
      ),
    );
  });
});

/**
 * 폰이 터미널을 실제로 몰 수 있는가.
 *
 * 소프트 키보드에는 Ctrl 도 Esc 도 방향키도 없다. 시안의 트레이가 그것들을
 * 보내는 자리이고, 여기서 고정하는 것은 **무엇이 전선에 나가는가**다.
 */
describe("세션 화면의 키 트레이", () => {
  beforeEach(() => {
    invocations.length = 0;
    refuseWritableAttach = false;
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
  });

  it("칩을 누르면 그 키의 semantic intent가 세션으로 간다", async () => {
    const root = await openTerminal();

    const esc = [...root.querySelectorAll<HTMLButtonElement>(".tray__key")].find(
      (chip) => chip.textContent === "Esc",
    );
    esc?.click();
    await settle();

    expect(sentInputIntents()).toContainEqual(
      expect.objectContaining({ case: "key", key: "Escape", code: "Escape" }),
    );
    expect(invocations.map((entry) => entry.command)).not.toContain("send_session_input");
  });

  /**
   * 손가락은 Ctrl 을 누른 채 다른 키를 못 누른다. Ctrl 은 걸어 두고 다음
   * 누름에만 붙으며, 그 자체로는 아무것도 보내지 않는다.
   */
  /**
   * 손가락은 Ctrl 을 누른 채 다른 키를 못 누른다. Ctrl 은 걸어 두고 다음
   * 누름에만 붙으며, 그 자체로는 아무것도 보내지 않는다.
   *
   * 바이트가 어떻게 변하는지는 `terminalKeys.test.ts` 가 단위로 고정한다.
   * 여기서 보는 것은 배선이다 — 눌렀을 때 화면이 걸린 상태가 되는가, 그리고
   * 그때 전선으로 아무것도 나가지 않는가.
   */
  it("Ctrl은 아무것도 보내지 않고 다음 키를 기다린다", async () => {
    const root = await openTerminal();

    const ctrl = () =>
      [...root.querySelectorAll<HTMLButtonElement>(".tray__key")].find(
        (chip) => chip.textContent === "Ctrl",
      );
    ctrl()?.click();
    await settle();

    expect(sentInputIntents().filter((intent) => intent.case === "key")).toEqual([]);
    expect(ctrl()?.getAttribute("aria-pressed")).toBe("true");

    // 다시 누르면 걸어 둔 것을 되돌린다 — 마음을 바꾼 사람이 취소할 방법.
    ctrl()?.click();
    await settle();
    expect(ctrl()?.getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * 대화창을 눌러서 치기 시작하는 것이 프롬프트를 넣는 자연스러운 몸짓이다.
   * 그런데 그 탭은 터미널이 제 안에 들고 있는 칸에 포커스를 줬고, 그래서 줄이
   * **두 군데**에서 쓰였다 — 트레이는 그 줄을 몰랐다. 그 결과 프롬프트는 최근
   * 목록에 남지 않았고 보내기 단추도 나타나지 않았다(2026-09-04 사용자 보고).
   * 세션에 치는 칸은 하나다.
   */
  it("대화창을 눌러도 트레이의 칸이 올라온다", async () => {
    const root = await openTerminal();
    const box = root.querySelector<HTMLTextAreaElement>(".tray__box");
    if (!box) throw new Error("no input");

    pick(root, ".session__terminal").click();
    await settle();

    expect(document.activeElement).toBe(box);
  });

  /**
   * 엔터는 키를 치는 손이 누르는 것이다. 그 줄을 기록하느라 화면을 다시 그리면
   * 방금 친 칸이 사라지고 키보드가 명령 사이마다 내려간다.
   */
  it("엔터로 남긴 줄이 최근 목록에 들어가고 키보드는 그대로다", async () => {
    const root = await openTerminal();
    const box = root.querySelector<HTMLTextAreaElement>(".tray__box");
    if (!box) throw new Error("no input");
    box.focus();

    box.value = "git status";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    pressReturn(box);
    await settle();

    expect(document.activeElement).toBe(box);
    expect(root.querySelector(".tray__box")).toBe(box);

    pick(root, ".tray__toggle--history").click();
    await settle();
    expect(root.querySelector(".history-item__text")?.textContent).toBe("git status");
  });

  it.each(["Send click", "native Enter"])(
    "clears Send visibility after %s and restores it only for new input",
    async (method) => {
      const root = await openTerminal();
      const box = root.querySelector<HTMLTextAreaElement>(".tray__box");
      if (!box) throw new Error("no input");
      const row = pick(root, ".tray__row");
      const send = pick(root, ".tray__send");
      const saves = vi.spyOn(Storage.prototype, "setItem");
      try {
        box.focus();
        expect(row.classList.contains("tray__row--sending")).toBe(false);
        for (const [index, text] of ["git status", "echo 한글"].entries()) {
          box.value = text;
          box.dispatchEvent(new Event("input", { bubbles: true }));
          expect(row.classList.contains("tray__row--sending")).toBe(true);
          if (method === "Send click") {
            send.click();
            expect(row.classList.contains("tray__row--sending")).toBe(false);
          } else {
            pressReturn(box);
          }
          await settle();
          expect(row.classList.contains("tray__row--sending")).toBe(false);
          expect(root.querySelector(".tray__box")).toBe(box);
          expect(document.activeElement).toBe(box);
          expect(saves.mock.calls.filter(([key]) => key === "hebbian.commands.v1")).toHaveLength(index + 1);
        }
        const intents = sentInputIntents();
        expect(intents.filter((intent) => intent.case === "text").map((intent) => intent.text))
          .toEqual(["git status", "echo 한글"]);
        expect(intents.filter((intent) => intent.case === "key").map((intent) => intent.key))
          .toEqual(["Enter", "Enter"]);
        pick(root, ".tray__toggle--history").click();
        expect([...root.querySelectorAll(".history-item__text")].map((item) => item.textContent))
          .toEqual(["echo 한글", "git status"]);
      } finally {
        saves.mockRestore();
      }
    },
  );

  it.each(["", "echo QA606"])("does not retain a lone surrogate after %j plus emoji Backspace", async (prefix) => {
    const root = await openTerminal();
    const box = root.querySelector<HTMLTextAreaElement>(".tray__box");
    if (!box) throw new Error("no input");
    box.focus();
    const typed = [prefix, "😀"].filter(Boolean);
    for (const text of typed) {
      box.setRangeText(text, box.selectionStart, box.selectionEnd, "end");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    box.setRangeText("", box.selectionStart - 2, box.selectionEnd, "end");
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    await settle();
    expect.soft(pick(root, ".tray__row").classList.contains("tray__row--sending")).toBe(prefix.length > 0);
    pressReturn(box);
    await settle();

    const intents = sentInputIntents();
    expect(intents.filter((intent) => intent.case === "text").map((intent) => intent.text))
      .toEqual(typed);
    expect(intents.filter((intent) => intent.case === "key").map((intent) => intent.key))
      .toEqual(["Backspace", "Enter"]);
    pick(root, ".tray__toggle--history").click();
    expect.soft(root.querySelector(".history-item__text")?.textContent).toBe(prefix || undefined);
    const saved = JSON.parse(localStorage.getItem("hebbian.commands.v1") ?? "[]");
    expect(saved.map((entry: { text: string }) => entry.text)).toEqual(prefix ? [prefix] : []);
  });

  /**
   * 알약의 단축키는 **치는 도중에** 누르는 것이다. 그 누름이 키보드를 내리면
   * 다음 글자를 치려고 매번 다시 올려야 한다(2026-09-04 사용자 보고).
   *
   * 두 가지가 내렸다. 하나는 단추가 기본 동작으로 포커스를 가져가는 것 —
   * 키보드는 그 포커스 때문에 올라와 있으므로 그게 내려가라는 신호다. 다른
   * 하나는 Ctrl 을 걸 때의 다시 그리기 — 트리를 통째로 갈면 키보드를 들고 있던
   * 칸도 같이 사라진다.
   */
  it("단축키를 눌러도 키보드가 내려가지 않는다", async () => {
    const root = await openTerminal();
    const box = root.querySelector<HTMLInputElement>(".tray__box");
    if (!box) throw new Error("no input");
    box.focus();

    const chips = [...root.querySelectorAll<HTMLButtonElement>(".tray__pill .tray__key")];
    const ctrl = () =>
      [...root.querySelectorAll<HTMLButtonElement>(".tray__key")].find(
        (chip) => chip.textContent === "Ctrl",
      );

    // 누르는 순간 포커스를 가져가지 않는다.
    for (const chip of chips) {
      const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      chip.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
    }

    // Ctrl 은 트레이가 하는 말을 바꾸는 유일한 누름이다. 그 말은 제자리에서
    // 바뀌어야 한다 — 다시 그리면 이 칸이 사라지고 키보드가 따라 내려간다.
    ctrl()?.click();
    await settle();

    expect(ctrl()?.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(box);
    expect(root.querySelector(".tray__box")).toBe(box);

    ctrl()?.click();
    await settle();
    expect(ctrl()?.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(box);
  });

  /**
   * 친 글자는 그 자리에서 세션으로 간다 — 줄은 터미널에만 있고 트레이는
   * 사본을 들고 있지 않다. 엔터는 개행 하나이고, 그때 비로소 그 줄이 최근
   * 목록에 이름으로 남는다.
   */
  it("친 글자가 바로 나가고, 엔터가 그 줄을 최근 목록에 남긴다", async () => {
    const root = await openTerminal();

    const box = root.querySelector<HTMLTextAreaElement>(".tray__box");
    if (!box) throw new Error("no input");
    const type = (text: string): void => {
      box.setRangeText(text, box.selectionStart, box.selectionEnd, "end");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    };
    type("git ");
    type("status");
    await settle();

    expect(
      sentInputIntents()
        .filter((intent) => intent.case === "text")
        .map((intent) => intent.text),
    ).toEqual(["git ", "status"]);
    // Preserve the native text-service context until a terminal action ends it.
    expect(box.value).toContain("git status");

    pressReturn(box);
    await settle();

    expect(box.value).toBe(PAD_TEXT);
    const intents = sentInputIntents();
    expect(intents[intents.length - 1]).toMatchObject({
      case: "key",
      key: "Enter",
    });

    pick(root, ".tray__toggle--history").click();
    await settle();
    expect(root.querySelector(".history-item__text")?.textContent).toBe("git status");
  });

  /**
   * 조합 중인 한글을 그대로 흘려보내면 세션이 반쪽 글자를 받고, 그걸 지우는
   * 바이트까지 뒤따라야 한다. 조합이 끝난 뒤에 한 번만 나간다.
   */
  it("preserves iOS Korean replacement input without composition events", async () => {
    const root = await openTerminal();
    const box = root.querySelector<HTMLTextAreaElement>(".tray__box")!;
    box.focus();
    const edit = (inputType: string, text: string, remove = 0) => {
      box.dispatchEvent(new InputEvent("beforeinput", {bubbles: true, inputType, data: text}));
      box.setRangeText(text, box.selectionStart - remove, box.selectionEnd, "end");
      box.dispatchEvent(new InputEvent("input", {bubbles: true, inputType, data: text}));
    };
    edit("insertText", "ㅎ");
    // Clearing or recentering this native field ends Korean composition on iOS.
    expect(box.value).toContain("ㅎ");
    edit("deleteContentBackward", "", 1);
    edit("insertText", "하");
    edit("deleteContentBackward", "", 1);
    edit("insertText", "한");
    edit("insertText", "ㄱ");
    edit("deleteContentBackward", "", 1);
    edit("insertText", "그");
    edit("deleteContentBackward", "", 1);
    edit("insertText", "글");
    await settle();
    let prompt = "";
    for (const intent of sentInputIntents()) {
      if (intent.case === "text") prompt += intent.text;
      else if (intent.case === "key" && intent.key === "Backspace") prompt = [...prompt].slice(0, -1).join("");
    }
    expect(prompt).toBe("한글");
    expect(document.activeElement).toBe(box);
    expect(root.querySelector(".tray__box")).toBe(box);
  });

  it("조합 중인 글자는 끝나기 전에 나가지 않는다", async () => {
    const root = await openTerminal();

    const box = root.querySelector<HTMLInputElement>(".tray__box");
    if (!box) throw new Error("no input");
    box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    box.value = "ㅎ";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.value = "하";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    expect(sentInputIntents().filter((intent) => intent.case === "text")).toEqual([]);

    box.value = "한";
    box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await settle();

    expect(sentInputIntents().filter((intent) => intent.case === "text")).toEqual([
      expect.objectContaining({ text: "한" }),
    ]);
  });

  /**
   * 키보드가 올라오면 줄은 터미널에 있다. 입력줄이 사본을 들고 남아 있으면 볼
   * 곳이 두 군데가 되고, 그만큼 터미널이 줄어든다. 시안 2820:73956 이 키보드가
   * 올라온 프레임에 없는 이유다.
   *
   * 접히는 근거는 **키보드가 올라왔다는 사실**이지 우리 입력칸의 포커스가
   * 아니다 — 클로드 대화창을 눌러도 키보드는 올라오고, 그때 그 포커스는
   * 터미널 것이다. 포커스로 판단하면 바로 그 경우에 입력줄이 키 앞을 막는다.
   */
  it("키보드가 올라오면 누가 띄웠든 입력줄이 접힌다", async () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        // 레이아웃 뷰포트는 키보드에 줄지 않는다. 그 차이가 키보드다.
        height: window.innerHeight - 336,
        offsetTop: 0,
        scale: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    try {
      await openTerminal();
      expect(document.documentElement.getAttribute("data-keyboard")).toBe("on");
    } finally {
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: undefined,
      });
    }
  });

  it("키보드가 없으면 입력줄은 그대로 선다", async () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: window.innerHeight,
        offsetTop: 0,
        scale: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    try {
      const root = await openTerminal();
      expect(document.documentElement.getAttribute("data-keyboard")).toBeNull();
      // 접는 것이지 지우는 것이 아니다 — 포커스를 잃으면 키보드가 같이 내려간다.
      expect(root.querySelector(".tray__input .tray__box")).not.toBeNull();
    } finally {
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: undefined,
      });
    }
  });

  /**
   * 키보드가 올라오면 iOS 는 스크롤할 수 없는 페이지 대신 **보이는 영역
   * 자체**를 위로 민다. 문서 안의 무엇도 움직이지 않고 `scrollY` 도 0 이라,
   * 높이만 맞추면 화면이 그 밀린 만큼 키보드에 못 닿는다 — 트레이와 키보드
   * 사이의 간격이 정확히 그 값이다.
   */
  it("보이는 영역의 높이와 시작점을 둘 다 알린다", async () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 538,
        offsetTop: 88,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    try {
      await openTerminal();
      const root = document.documentElement.style;
      expect(root.getPropertyValue("--app-viewport-height")).toBe("538px");
      expect(root.getPropertyValue("--app-viewport-top")).toBe("88px");
    } finally {
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: undefined,
      });
    }
  });

  /**
   * 세션 화면은 보이는 높이에 딱 맞춰야 한다. 문서가 그보다 길면 iOS 가
   * 손가락에 페이지를 끌려 보내고, 읽던 줄이 화면 밖으로 나간다.
   */
  it("세션 화면일 때만 문서 스크롤을 잠근다", async () => {
    const root = await openTerminal();
    expect(document.documentElement.getAttribute("data-screen")).toBe("session");

    pick(root, ".session__header .icon-tap").click();
    await settle();
    expect(document.documentElement.getAttribute("data-screen")).toBeNull();
  });

  /**
   * 관찰자로 붙은 화면에서 입력을 받아 놓고 삼키면, 사용자는 보냈다고 믿는다.
   */
  it("읽기 전용이면 입력을 아예 받지 않는다", async () => {
    refuseWritableAttach = true;

    const root = await openTerminal();

    expect(root.querySelector<HTMLInputElement>(".tray__box")?.disabled).toBe(true);
    // 3022:81487 의 send 는 "보낼 게 있으면" 나타난다. 쓸 수 없는 연결에서는
    // 보낼 것이 생길 수 없으므로, 비활성 버튼이 아니라 아예 서지 않는다.
    expect(root.querySelector(".tray__row--sending")).toBeNull();
  });
});

describe("terminal unavailability", () => {
  beforeAll(async () => { await import("./app"); });
  beforeEach(() => {
    invocations.length = 0;
    refuseWritableAttach = false;
    censusReports = [{ server_id: "lab", server_label: "Loopback lab",
      outcome: { state: "listed", sessions: [remoteSession()] } }];
  });
  const type = (root: HTMLElement, value: string) => {
    const field = root.querySelector<HTMLTextAreaElement>(".tray__box");
    if (!field) throw new Error("no input field");
    field.value = value;
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  };

  const attachCalls = () => invocations.filter(({ command }) =>
    command === "attach_session" || command === "attach_hub_session");
  async function interruptTerminal() {
    pendingTerminalReads.get(activeAttachmentId!)?.reject({
      code: "hmux_transport_interrupted", message: "Read interrupted",
    });
    await settle();
  }

  it.each(["ssh", "hub-local", "hub-remote"])("reconnects to the authoritative %s rehost successor", async (transport) => {
    const selected = { ...remoteSession(), box_id: transport, box_label: "QA host" };
    if (transport !== "ssh") {
      hubRows = [hubRow()];
      hubCatalogSessions = [selected];
      censusReports = [];
    }
    const root = await openTerminal();
    await interruptTerminal();
    const successor = { ...selected, session_id: "successor-runtime", session_name: "Renamed successor",
      terminal_epoch: "successor-terminal", host_instance_id: "successor-host" };
    discoveredSessions = [successor];
    hubCatalogSessions = [successor];
    successorResolution = { state: "resolved", session: successor };
    pick(root, ".session .banner__action").click();
    await settle();
    const calls = attachCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].args.session).toMatchObject(successor);
    const lookup = invocations.find(({ command }) => command === (transport === "ssh"
      ? "resolve_session_successor" : "resolve_hub_session_successor"));
    expect(lookup?.args).toMatchObject(transport === "ssh"
      ? { serverId: "lab", session: remoteSession() }
      : { hubId: HUB_ID, boxId: transport, session: selected });
    expect(root.querySelector(".session .banner")).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>(".tray__box")?.disabled).toBe(false);
  });

  it.each(["pending", "unknown", "unsupported", "lost answer"])("preserves the transcript when successor resolution is %s", async (state) => {
    const root = await openTerminal();
    const grid = root.querySelector(".structured-terminal__grid");
    await interruptTerminal();
    discoveredSessions = [];
    if (state === "pending" || state === "unknown") successorResolution = { state };
    else successorError = { code: state === "unsupported" ? "hmux_protocol_version_unsupported" : "relay_timed_out", message: state };
    pick(root, ".session .banner__action").click();
    await settle();
    expect(attachCalls()).toHaveLength(1);
    expect(root.querySelector(".structured-terminal__grid")).toBe(grid);
    expect(root.querySelector<HTMLButtonElement>(".session .banner__action")?.disabled).toBe(false);
    if (state === "pending") expect(root.textContent).toContain(t("terminal.reconnect.rehostPending"));
    if (state === "unsupported") expect(root.textContent).toContain(t("terminal.reconnect.updateRequired"));
    expect(invocations.filter(({ command }) => command === "resolve_session_successor")).toHaveLength(1);
  });

  it.each(["new selection", "late error", "dispose"])("discards a delayed successor after %s", async (reason) => {
    const root = await openTerminal();
    await interruptTerminal();
    discoveredSessions = [];
    holdSuccessor = true;
    successorResolution = { state: "resolved", session: { ...remoteSession(), session_id: "successor-runtime" } };
    pick(root, ".session .banner__action").click();
    await settle();
    expect(releaseSuccessor).toBeDefined();
    // Repeated intent while this query owns opening must not dial another channel.
    pick(root, ".session .banner__action").click();
    expect(invocations.filter(({ command }) => command === "resolve_session_successor")).toHaveLength(1);
    if (reason === "dispose") disposeApp?.();
    else {
      pick(root, ".session__header .icon-tap").click();
      await settle();
      expect(root.querySelector('.list__open [role="status"]')).toBeNull();
      pick(root, ".list__open").click();
      await settle();
    }
    const active = activeAttachmentId;
    const before = attachCalls().length;
    if (reason === "late error") successorError = { code: "offline", message: "Old query failed" };
    releaseSuccessor?.();
    await settle();
    expect(attachCalls()).toHaveLength(before);
    expect(activeAttachmentId).toBe(active);
    expect(root.querySelector(".toast--destructive")).toBeNull();
  });

  it.each(["ssh", "hub-local", "hub-remote"])(
    "refreshes the exact %s target before explicit reconnect",
    async (transport) => {
      const selected = { ...remoteSession(), box_id: transport, box_label: "QA host" };
      if (transport !== "ssh") {
        hubRows = [hubRow()];
        hubCatalogSessions = [selected];
        censusReports = [];
      }
      const root = await openTerminal();
      expect(invocations.filter(({ command }) => command === "discover_sessions")).toHaveLength(0);
      await interruptTerminal();
      const current = {
        ...selected, runner_instance: "current-runner", channel_epoch: "2",
        host_instance_id: "current-host", terminal_epoch: "current-terminal",
      };
      discoveredSessions = [current];
      hubCatalogSessions = [
        { ...current, box_id: "unrelated-box", terminal_epoch: "wrong-box-terminal" }, current,
      ];
      pick(root, ".session .banner__action").click();
      await settle();
      const calls = attachCalls();
      const call = calls[calls.length - 1];
      expect(call.args.session).toMatchObject(current);
      expect(call.args).toMatchObject(transport === "ssh"
        ? { serverId: "lab" } : { hubId: HUB_ID, boxId: transport });
      expect(root.querySelector(".session .banner")).toBeNull();
      expect(root.querySelector<HTMLTextAreaElement>(".tray__box")?.disabled).toBe(false);
    },
  );

  it.each(["missing", "unready", "other workspace", "other principal", "different runtime", "lookup error"])(
    "does not attach a cached target after reconnect finds %s",
    async (reason) => {
      const root = await openTerminal();
      const previous = activeAttachmentId;
      const grid = root.querySelector(".structured-terminal__grid");
      await interruptTerminal();
      const current = remoteSession();
      if (reason === "unready") current.ready = false;
      if (reason === "other workspace") current.workspace_id = "other-workspace";
      if (reason === "other principal") current.runner_principal = "another-user";
      if (reason === "different runtime") current.session_id = "new-runtime-same-title";
      discoveredSessions = reason === "missing" ? [] : [current];
      if (reason === "lookup error") discoveryError = { code: "offline", message: "Lookup failed" };
      const before = attachCalls().length;
      pick(root, ".session .banner__action").click();
      await settle();
      expect(attachCalls()).toHaveLength(before);
      expect(activeAttachmentId).toBe(previous);
      expect(root.querySelector(".structured-terminal__grid")).toBe(grid);
      expect(root.querySelector<HTMLTextAreaElement>(".tray__box")?.disabled).toBe(true);
      expect(root.querySelector(".toast--destructive")).not.toBeNull();
      expect(root.querySelector<HTMLButtonElement>(".session .banner__action")?.disabled).toBe(false);
    },
  );

  it.each([true, false])("discards a late reconnect lookup (%s) after the user opens another session", async (succeeds) => {
    const root = await openTerminal();
    await interruptTerminal();
    holdServerDiscovery = true;
    pick(root, ".session .banner__action").click();
    await settle();
    expect(attachCalls()).toHaveLength(1);
    expect(root.querySelector<HTMLButtonElement>(".session .banner__action")?.disabled).toBe(true);
    pick(root, ".session__header .icon-tap").click();
    await settle();
    pick(root, ".list__open").click();
    await settle();
    const current = activeAttachmentId;
    const before = attachCalls().length;
    releaseServerDiscovery?.(succeeds);
    await settle();
    expect(activeAttachmentId).toBe(current);
    expect(attachCalls()).toHaveLength(before);
    expect(root.querySelector(".toast--destructive")).toBeNull();
  });

  it.each(["offline", "another box"])("preserves the old Hub transcript when the fresh lookup returns %s", async (reason) => {
    hubRows = [hubRow()];
    censusReports = [];
    const root = await openTerminal();
    const previous = activeAttachmentId;
    const grid = root.querySelector(".structured-terminal__grid");
    await interruptTerminal();
    if (reason === "offline") hubUnreachable = true;
    else hubCatalogSessions = hubProbe().sessions.map((session) => ({ ...session, box_id: "another-box" }));
    const before = attachCalls().length;
    pick(root, ".session .banner__action").click();
    await settle();
    expect(attachCalls()).toHaveLength(before);
    expect(activeAttachmentId).toBe(previous);
    expect(root.querySelector(".structured-terminal__grid")).toBe(grid);
    expect(root.querySelector(".toast--destructive")).not.toBeNull();
  });

  it("does not attach after the app is disposed during reconnect discovery", async () => {
    const root = await openTerminal();
    await interruptTerminal();
    holdServerDiscovery = true;
    pick(root, ".session .banner__action").click();
    await settle();
    const before = attachCalls().length;
    disposeApp?.();
    releaseServerDiscovery?.(true);
    await settle();
    expect(attachCalls()).toHaveLength(before);
  });

  it("clears reconnect progress when Back abandons the pending lookup", async () => {
    const root = await openTerminal();
    await interruptTerminal();
    holdServerDiscovery = true;
    pick(root, ".session .banner__action").click();
    await settle();
    pick(root, ".session__header .icon-tap").click();
    await settle();
    expect(root.querySelector('.list__open [role="status"]')).toBeNull();
    releaseServerDiscovery?.(true);
    await settle();
    expect(attachCalls()).toHaveLength(1);
    expect(root.querySelector('.list__open [role="status"]')).toBeNull();
  });

  it("uses the same exact refresh for an unavailable row's Attach action", async () => {
    hubRows = [hubRow()];
    censusReports = [];
    const root = await launch();
    await holdRow(pick(root, ".list__open"));
    hubUnreachable = true;
    await pullDown(root);
    const attach = [...root.querySelectorAll<HTMLButtonElement>(".row-menu button")]
      .find((button) => button.textContent?.includes(t("세션 연결")));
    expect(attach).toBeDefined();
    hubUnreachable = false;
    hubCatalogSessions = hubProbe().sessions.map((session) => ({ ...session, terminal_epoch: "row-current" }));
    const beforeCensus = invocations.filter(({ command }) => command === "take_session_census").length;
    attach?.click();
    await settle();
    const calls = attachCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.session).toMatchObject({ session_id: "hub-live", terminal_epoch: "row-current" });
    expect(invocations.filter(({ command }) => command === "take_session_census")).toHaveLength(beforeCensus);
  });

  it.each(["closed", "read error", "send error", "send error then rehost"])(
    "keeps %s unavailable until an explicit successful new attachment",
    async (failure) => {
      const root = await openTerminal();
      const previous = activeAttachmentId!;
      const grid = root.querySelector(".structured-terminal__grid");
      expect(root.querySelector(".session__header .session__state")?.getAttribute("aria-label")).toBe("실행 중");
      type(root, "already sent");
      const oldField = root.querySelector<HTMLTextAreaElement>(".tray__box")!;
      pressReturn(oldField);
      await settle();
      if (failure.startsWith("send error")) {
        rejectNextTerminalSend = true;
        type(root, "uncertain input");
        pressReturn(oldField);
      } else if (failure === "read error") {
        pendingTerminalReads.get(previous)?.reject({
          code: "hmux_transport_interrupted", message: "Read interrupted",
        });
      } else {
        activeAttachmentId = undefined;
        pendingTerminalReads.get(previous)?.resolve(new TextEncoder().encode(JSON.stringify({
          kind: "closed", code: "hmux_transport_closed", message: "The transport closed",
        })).buffer as ArrayBuffer);
      }
      await settle();
      expect(root.querySelector<HTMLTextAreaElement>(".tray__box")?.disabled).toBe(true);
      expect(root.querySelector(".session__header .session__state")?.getAttribute("aria-label")).toBe("상태를 알 수 없음");
      expect(root.querySelector(".structured-terminal__grid")).toBe(grid);
      expect(grid?.textContent).toContain("ready");
      expect(root.querySelector(".session .banner")?.textContent).toContain(
        failure === "closed" ? "hmux_transport_closed" : "hmux_transport_interrupted",
      );
      const sent = sentTerminalRecords.length;
      type(root, "must not be sent");
      oldField.value = "stale field must not send";
      oldField.dispatchEvent(new InputEvent("input", { bubbles: true }));
      pressReturn(oldField);
      pick(root, ".tray__toggle--keys").click();
      for (const key of root.querySelectorAll<HTMLButtonElement>(".tray__key, .keys-grid__key, .dpad__key")) {
        expect(key.disabled).toBe(true);
        key.click();
      }
      pick(root, ".tray__send").click();
      await settle();
      expect(sentTerminalRecords).toHaveLength(sent);
      pick(root, ".tray__toggle--history").click();
      const history = root.querySelectorAll<HTMLButtonElement>(".history-item");
      // A rejected send is uncertain, not proof the attempted command did not run.
      expect(history).toHaveLength(failure.startsWith("send error") ? 2 : 1);
      expect([...history].map((row) => row.textContent)).toContain("already sent");
      for (const row of history) {
        expect(row.disabled).toBe(true);
        row.click();
      }
      await settle();
      expect(sentTerminalRecords).toHaveLength(sent);

      const beforeReconnect = sentInputIntents().filter((intent) => intent.case !== "resize");
      if (failure === "send error then rehost") {
        const successor = { ...remoteSession(), session_id: "new-runtime", terminal_epoch: "new-terminal" };
        discoveredSessions = [successor];
        successorResolution = { state: "resolved", session: successor };
      }
      holdNextWritableAttach = true;
      pick(root, ".session .banner__action").click();
      await settle();
      expect(root.querySelector<HTMLTextAreaElement>(".tray__box")?.disabled).toBe(true);
      expect(root.querySelector(".session .banner")).not.toBeNull();
      expect(root.querySelector<HTMLButtonElement>(".session .banner__action")?.disabled).toBe(true);
      expect(root.querySelector(".session__header .session__state")?.getAttribute("aria-label")).toBe("상태를 알 수 없음");
      releaseHeldWritableAttach?.("success");
      await settle();
      expect(activeAttachmentId).not.toBe(previous);
      expect(root.querySelector(".session .banner")).toBeNull();
      expect(root.querySelector(".session__header .session__state")?.getAttribute("aria-label")).toBe("실행 중");
      expect(root.querySelector<HTMLTextAreaElement>(".tray__box")?.disabled).toBe(false);
      expect(sentInputIntents().filter((intent) => intent.case !== "resize")).toEqual(beforeReconnect);
      type(root, "new input after explicit reconnect");
      await settle();
      expect(sentInputIntents()).toContainEqual({ case: "text", text: "new input after explicit reconnect" });
    },
  );

  it("ignores a retired attachment's late read failure after a new session opens", async () => {
    const root = await openTerminal();
    const previous = activeAttachmentId!;
    const oldField = root.querySelector<HTMLTextAreaElement>(".tray__box")!;
    pick(root, ".session__header .icon-tap").click();
    await settle();
    pick(root, ".list__open").click();
    await settle();
    expect(activeAttachmentId).not.toBe(previous);
    pendingTerminalReads.get(previous)?.reject({ code: "old_failure", message: "Old read failed" });
    await settle();
    expect(root.querySelector(".session .banner")).toBeNull();
    expect(root.querySelector(".session__header .session__state")?.getAttribute("aria-label")).toBe("실행 중");
    oldField.value = "retired attachment input";
    oldField.dispatchEvent(new InputEvent("input", { bubbles: true }));
    pressReturn(oldField);
    type(root, "current attachment");
    await settle();
    expect(sentInputIntents()).toContainEqual({ case: "text", text: "current attachment" });
    expect(sentInputIntents()).not.toContainEqual({ case: "text", text: "retired attachment input" });
  });
});

describe("commit message input", () => {
  // App module loading is setup, not part of the input interaction's deadline.
  beforeAll(async () => { await import("./app"); });
  async function openCommit() {
    invocations.length = 0;
    hubRows = [hubRow()];
    censusReports = [];
    const root = await openTerminal();
    pick(root, ".session__icon--connection").click();
    await settle();
    pick(root, '.scm__file input[type="checkbox"]').click();
    pick(root, ".scm .prform__footer button").click();
    return root;
  }
  const messageField = (root: HTMLElement) => {
    const field = root.querySelector<HTMLTextAreaElement>(".sheet textarea");
    if (!field) throw new Error("no commit message field");
    return field;
  };
  const writes = () => invocations.filter((entry) => entry.command === "hub_scm_write");
  const type = (field: HTMLTextAreaElement, text: string) => {
    field.value = text;
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  };

  it("keeps the focused field through typing and submits the complete current draft", async () => {
    const root = await openCommit();
    const field = messageField(root);
    field.focus();
    for (const text of ["t", "test: verify ", "test: verify 한", "test: verify 한글 QA commit"]) {
      type(field, text);
      await settle();
      expect(messageField(root)).toBe(field);
      expect(document.activeElement).toBe(field);
    }
    pick(root, ".sheet .pair-button--solid").click();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.args.action).toEqual({
      kind: "commit", paths: ["mobile-qa.txt"], message: "test: verify 한글 QA commit",
    });
    expect(messageField(root).disabled).toBe(true);
    pick(root, ".sheet .pair-button--solid").click();
    pick(root, ".sheet .pair-button--ghost").click();
    expect(writes()).toHaveLength(1);
    expect(root.querySelector(".sheet")).not.toBeNull();

    finishScmWrite?.("commit rejected");
    await settle();
    const retryField = messageField(root);
    expect(retryField.value).toBe("test: verify 한글 QA commit");
    expect(root.querySelector(".prform__error")?.textContent).toBe("commit rejected");
    retryField.focus();
    type(retryField, "test: corrected commit");
    expect(messageField(root)).toBe(retryField);
    expect(document.activeElement).toBe(retryField);
    expect(root.querySelector(".prform__error")).toBeNull();
    pick(root, ".sheet .pair-button--solid").click();
    expect(writes()[1]?.args.action).toMatchObject({ message: "test: corrected commit" });
    finishScmWrite?.();
    await settle();
    expect(root.querySelector(".sheet")).toBeNull();
  });

  it("names the live branch in the commit sheet when the catalog branch is stale", async () => {
    scmBranch = "qa606-mobile-switch";
    hubLayouts = {
      [HUB_ID]: {
        placements: {
          "hub-live": { desktop: "Main", project: "agent-ide", order: 0, branch: "main" },
        },
        desktop_order: ["Main"],
      },
    };

    const root = await openCommit();

    expect(root.querySelector(".sheet__note")?.textContent).toBe(
      "1 files · qa606-mobile-switch",
    );
  });

  it("clears cancelled drafts and keeps blank input from submitting after reopening", async () => {
    const root = await openCommit();
    type(messageField(root), "cancel this draft");
    pick(root, ".sheet .pair-button--ghost").click();
    expect(writes()).toHaveLength(0);
    pick(root, ".scm .prform__footer button").click();
    const field = messageField(root);
    expect(field.value).toBe("");
    type(field, "new draft");
    expect(pick(root, ".sheet .pair-button--solid").disabled).toBe(false);
    type(field, " \n ");
    expect(pick(root, ".sheet .pair-button--solid").disabled).toBe(true);
    pick(root, ".sheet .pair-button--solid").click();
    expect(writes()).toHaveLength(0);
  });
});

/**
 * 떠 있는 방향키 패드.
 *
 * 트레이가 아니라 화면 위에 뜨는 이유: OS 키보드가 올라오면 트레이는 키보드
 * 위로 밀리는데, 타이핑 중에 필요한 것이 바로 방향키다(이력·메뉴·완성).
 */
describe("방향키 패드", () => {
  beforeEach(() => {
    invocations.length = 0;
    refuseWritableAttach = false;
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
  });

  /**
   * 세션 화면은 Ctrl 을 걸 때도, 서랍을 열 때도, 방향키 패드를 켤 때도 다시
   * 그려진다. 그때마다 터미널을 버리고 새로 붙이면 읽고 있던 트랜스크립트가
   * 눈앞에서 비워졌다 다시 채워진다 — 그리고 그건 재부착이라 공짜도 아니다.
   *
   * 수명의 주인은 렌더가 아니라 **attach** 다.
   */
  it("상태가 바뀌어도 터미널을 다시 만들지 않는다", async () => {
    const root = await openTerminal();
    const transcript = root.querySelector(".session__terminal");
    expect(transcript).not.toBeNull();

    // 트레이 칩(Ctrl 걸기), 서랍 — 전부 setState 를 지나간다.
    [...root.querySelectorAll<HTMLButtonElement>(".tray__key")]
      .find((chip) => chip.textContent === "Ctrl")
      ?.click();
    await settle();
    pick(root, ".tray__toggle--history").click();
    await settle();
    pick(root, ".tray__toggle--keys").click();
    await settle();

    expect(root.querySelector(".session__terminal")).toBe(transcript);
    expect(transcript?.isConnected).toBe(true);
  });

  it("알약은 늘 트리에 있고, 드래그 중에만 켜진다", async () => {
    const root = await openTerminal();
    // 트리에는 늘 있다 — 스페이스바 드래그가 어느 방향인지 이 알약이 말한다.
    // 트레이가 아니라 터미널과 같은 층에 있다 — 키보드가 올라와도 남는다.
    expect(root.querySelector(".session__stage .dpad")).not.toBeNull();
    expect(root.querySelector(".dpad--dragging")).toBeNull();
  });

  /**
   * 스페이스바를 꾹 누르고 끌면 iOS 가 입력칸의 캐럿을 옮긴다. 그 캐럿이 지나는
   * 칸 하나가 화살표 한 번이고, 알약은 지금 가는 방향을 켠다(2026-09-03 사용자
   * 요청).
   */
  it("스페이스바 드래그는 화살표를 보내고, 알약이 그 방향을 켠다", async () => {
    const root = await openTerminal();
    pick(root, ".tray__toggle--keyboard").click();
    await settle();
    const box = root.querySelector<HTMLTextAreaElement>(".tray__box");
    if (!box) throw new Error("no input");
    expect(document.activeElement).toBe(box);

    // 두 줄 위로.
    const at = box.selectionStart - 2 * (PAD_COLS + 1);
    box.setSelectionRange(at, at);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();

    expect(sentInputIntents().filter((intent) => intent.key === "ArrowUp")).toHaveLength(2);
    expect(root.querySelector(".dpad--dragging")).not.toBeNull();
    expect(pick(root, '.dpad__key[aria-label="↑"]').classList.contains("dpad__key--active")).toBe(
      true,
    );
    expect(pick(root, '.dpad__key[aria-label="↓"]').classList.contains("dpad__key--active")).toBe(
      false,
    );

    // 한 칸 오른쪽으로 — 같은 드래그는 세로에 잠겨 있으니 아무것도 안 나간다.
    box.setSelectionRange(at + 1, at + 1);
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    expect(sentInputIntents().filter((intent) => intent.key === "ArrowUp")).toHaveLength(2);
  });

  /**
   * 트레이 아이콘 세 개가 무엇을 여는지. 두 번 틀렸으므로 시안을 그대로 박아
   * 둔다.
   *
   * - list  → 다른 세션 (2863:75522 에서 이 첫 단추가 켜져 있다)
   * - move  → 방향키 패드 (2835:77049 가 그 자리를 가리킨다)
   * - grid  → 명령/키 서랍. 2829:75893(최근 명령)과 2823:75265(키 그리드)가
   *   **같은 세 번째 단추**를 켠다 — 둘을 가르는 것은 아래 바의 명령/키 탭이지
   *   토글이 아니다.
   */
  /**
   * 알약의 세 자리는 History / Command / Keyboard 다(3017:81400, 81505, 81555).
   * 다른 세션은 그 셋에 자리가 없어서 헤더의 두 번째 아이콘으로 올라갔다 —
   * 시안이 그 자리를 채우는 곳이다. 문은 여전히 하나다.
   */
  /**
   * 헤더의 깃 버튼은 Source control 을 연다(3042:80841). 전에는 권한 패널을
   * 열었는데, 깃 모양 아이콘이 권한을 여는 것은 아이콘이 거짓말을 하는 것이다.
   */
  it("깃 버튼이 Source control 을 연다", async () => {
    const root = await openTerminal();

    pick(root, ".session__icon--connection").click();
    await settle();

    expect(root.querySelector(".scm")).not.toBeNull();
    // 탭이 없다. 변경 목록과 커밋뿐이다(2026-09-04) — 커밋 탭도, PR 탭도,
    // 브랜치 전환도 빠졌다.
    expect(root.querySelector(".scm__tab")).toBeNull();
    expect(root.querySelector(".scm__card")).not.toBeNull();

    // 뒤로 가면 세션이 그대로 있다.
    pick(root, ".session__header .icon-tap").click();
    await settle();
    expect(root.querySelector(".tray__pill")).not.toBeNull();
  });

  /**
   * 알약 안은 이력·⌘ 두 자리, 키보드는 알약 옆의 좌석(2026-09-15 B안): 보낼 게
   * 생기면 그 좌석이 전송 원이 되므로 알약의 폭은 두 상태에서 같다.
   */
  it("시안대로: 알약은 두 자리, 키보드는 옆 좌석, 세션 스위처는 헤더", async () => {
    const root = await openTerminal();

    expect(root.querySelectorAll(".tray__pill .tray__toggle")).toHaveLength(2);
    expect(root.querySelector(".tray__pill .tray__toggle--keyboard")).toBeNull();
    expect(root.querySelector(".tray__seat .tray__toggle--keyboard")).not.toBeNull();
    expect(root.querySelector(".tray__seat .tray__send")).not.toBeNull();
    expect(root.querySelector(".tray__toggle--sessions")).toBeNull();
    expect(root.querySelectorAll(".session__icons .icon-tap")).toHaveLength(2);

    pick(root, ".session__icon--sessions").click();
    await settle();
    expect(pick(root, ".session__icon--sessions").getAttribute("aria-pressed")).toBe("true");
    expect(pick(root, ".tray__toggle--history").getAttribute("aria-pressed")).toBe("false");
    expect(pick(root, ".tray__toggle--keys").getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * 서랍은 디자인이 그린 스물넷만 그린다(3021:80643).
   *
   * 어휘 전체를 훑던 때에는 `?`, `/`, `⏎`, F1–F12 까지 들어가 세 줄짜리 자리에
   * 여덟 줄이 났다. 개수를 세는 이유는 그것이 이 변경이 고친 바로 그 사실이기
   * 때문이다 — 라벨을 세면 번역이 바뀔 때마다 깨진다.
   */
  it("명령 서랍은 키 스트립 설정의 어휘 전체를 그 순서대로 그린다", async () => {
    const root = await openTerminal();
    pick(root, ".tray__toggle--keys").click();
    await settle();

    const caps = [...root.querySelectorAll(".keys-grid__key")];
    expect(caps).toHaveLength(TERMINAL_KEYS.length);
    // The word keys the vocabulary marks wide are the ones drawn two cells wide.
    expect(root.querySelectorAll(".keys-grid__key--wide")).toHaveLength(
      TERMINAL_KEYS.filter((key) => key.wide).length,
    );
    expect(TERMINAL_KEYS.filter((key) => key.wide).map((key) => key.label)).toEqual(["⇧Tab", "Ctrl", "Home", "PgUp", "PgDn"]);
    // 첫 캡과 마지막 캡은 설정 화면의 카드 순서의 양 끝이다.
    expect(caps[0]?.textContent).toBe("Esc");
    expect(caps[caps.length - 1]?.textContent).toBe("⌥⌫");
    // 서랍에는 그리드뿐이다 — 칩 줄도, 편집 문도, 방향키 스위치도 없다.
    expect(root.querySelector(".tray__panel .tray__key")).toBeNull();
    expect(root.querySelector(".tray__edit")).toBeNull();
    expect(root.querySelector(".tray__pad")).toBeNull();
  });

  it("서랍의 수식키 캡은 걸리면 켜진다", async () => {
    const root = await openTerminal();
    pick(root, ".tray__toggle--keys").click();
    await settle();

    const ctrl = [...root.querySelectorAll<HTMLButtonElement>(".keys-grid__key")].find(
      (cap) => cap.textContent === "Ctrl",
    );
    if (!ctrl) throw new Error("no Ctrl cap");
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    ctrl.click();
    await settle();
    expect(
      [...root.querySelectorAll<HTMLButtonElement>(".keys-grid__key")]
        .find((cap) => cap.textContent === "Ctrl")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  /**
   * 명령과 키는 이제 알약 안의 서로 다른 두 단추다(3017:81400). 아래에 있던
   * `명령|키` 분절 바는 그 둘을 한 번 더 말하는 것이라 없앴다.
   */
  it("명령과 키가 각자의 단추로 열린다", async () => {
    const root = await openTerminal();
    expect(root.querySelector(".tray__footer")).toBeNull();

    pick(root, ".tray__toggle--history").click();
    await settle();
    expect(root.querySelector(".keys-grid")).toBeNull();
    expect(pick(root, ".tray__toggle--history").getAttribute("aria-pressed")).toBe("true");

    pick(root, ".tray__toggle--keys").click();
    await settle();
    expect(root.querySelector(".keys-grid")).not.toBeNull();
    expect(pick(root, ".tray__toggle--keys").getAttribute("aria-pressed")).toBe("true");
    expect(pick(root, ".tray__toggle--history").getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * 키보드 단추는 알약 안에 있다 — 3017:81400 에서 켜져 있는 것이 이 세 번째
   * 단추다. 전에는 서랍의 아래 바에만 있어서 **서랍을 먼저 열지 않으면 키보드를
   * 내릴 수 없었다.**
   */
  it("알약의 키보드 단추가 키보드를 올리고 내린다", async () => {
    const root = await openTerminal();
    expect(root.querySelector(".tray__panel")).toBeNull();

    pick(root, ".tray__toggle--keyboard").click();
    await settle();
    const box = root.querySelector<HTMLInputElement>(".tray__box");
    expect(document.activeElement).toBe(box);

    // 올라와 있으면 같은 단추가 내린다.
    document.documentElement.setAttribute("data-keyboard", "on");
    pick(root, ".tray__toggle--keyboard").click();
    await settle();
    expect(document.activeElement).not.toBe(box);
    document.documentElement.removeAttribute("data-keyboard");
  });

  /**
   * 알약의 세 단추는 같은 자리를 나눠 쓴다 — 서랍은 키보드가 차지하는 공간에
   * 열리고, 켜진 표시는 지금 그 자리에 무엇이 있는지를 말한다. 둘이 같이
   * 켜지면 그 표시는 아무것도 말하지 않는다(2026-09-03 사용자 보고).
   */
  it("서랍은 키보드가 자리를 가져가는 그 순간에 닫힌다", async () => {
    const root = await openTerminal();
    pick(root, ".tray__toggle--history").click();
    await settle();
    expect(pick(root, ".tray__toggle--history").getAttribute("aria-pressed")).toBe("true");

    pick(root, ".tray__toggle--keyboard").click();
    await settle();

    // 키보드를 부른다.
    expect(document.activeElement).toBe(root.querySelector(".tray__box"));
    // 서랍은 아직 자리를 지킨다. 여기서 닫으면 알약이 서랍 높이만큼 내려갔다가
    // 키보드가 올라올 때 다시 올라간다 — 올라가는 길에 한 번 꺼지는 셈이다.
    expect(root.querySelector(".tray__panel")).not.toBeNull();

    coverViewport(336);
    await settle();

    try {
      // 키보드가 자리를 가져간 그 순간에 닫힌다. 알약은 한 번만 움직인다.
      expect(root.querySelector(".tray__panel")).toBeNull();
      expect(pick(root, ".tray__toggle--history").getAttribute("aria-pressed")).toBe("false");
    } finally {
      clearViewport();
      document.documentElement.removeAttribute("data-keyboard");
    }
  });

  /**
   * 서랍이 키보드에 자리를 내주고 닫힐 때 트레이는 다시 그려지지 않는다 — 그리면
   * 키보드를 띄운 포커스가 풀려 키보드가 같이 내려간다. 그래서 단추가 들고 있는
   * 모델은 한 박자 낡아 있고, 열지 닫을지를 그 사본으로 정하면 다음 누름이
   * "닫기"로 읽혀 아무것도 안 켜진다(2026-09-03 사용자 보고).
   */
  it("키보드에 자리를 내준 서랍은 같은 단추로 다시 열린다", async () => {
    const root = await openTerminal();
    pick(root, ".tray__toggle--history").click();
    await settle();

    pick(root, ".tray__toggle--keyboard").click();
    await settle();
    coverViewport(336);
    await settle();
    expect(root.querySelector(".tray__panel")).toBeNull();

    try {
      pick(root, ".tray__toggle--history").click();
      await settle();
      coverViewport(0);
      await settle();

      expect(root.querySelector(".tray__panel")).not.toBeNull();
      expect(pick(root, ".tray__toggle--history").getAttribute("aria-pressed")).toBe("true");
    } finally {
      clearViewport();
      document.documentElement.removeAttribute("data-keyboard");
    }
  });

  /**
   * 서랍과 키보드는 같은 자리를 쓴다. 올라오는 키보드가 가져간 만큼 서랍이
   * 내주면 알약은 max(서랍, 키보드) 에 서 있게 되어 한 번만 올라간다 — 서랍이
   * 발밑에서 사라져 알약이 내려갔다 다시 올라오는 일이 없다.
   */
  it("올라오는 키보드가 가져간 만큼 서랍이 자리를 내준다", async () => {
    const root = await openTerminal();
    pick(root, ".tray__toggle--keys").click();
    await settle();
    // jsdom 은 배치를 하지 않아 모든 높이가 0이다. 서랍에 키를 줘야 내줄 것이
    // 생긴다.
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    try {
      coverViewport(80);
      await settle();

      // 아직 키보드라고 부르지도 않는 높이지만, 서랍은 그만큼 이미 내준다.
      expect(document.documentElement.getAttribute("data-keyboard")).toBeNull();
      expect(root.querySelector<HTMLElement>(".tray__panel")?.style.height).toBe("120px");

      coverViewport(200);
      await settle();

      expect(root.querySelector(".tray__panel")).toBeNull();
      expect(pick(root, ".tray__toggle--keys").getAttribute("aria-pressed")).toBe("false");
    } finally {
      height.mockRestore();
      clearViewport();
      document.documentElement.removeAttribute("data-keyboard");
    }
  });

  /**
   * 키보드보다 키가 큰 서랍 — 45% 까지 자란 기록 목록 — 은 1:1 로 내주다가
   * 남는다. 키보드가 다 올라온 뒤에도 남은 조각이 서 있으면 그 단추가 키보드
   * 단추와 같이 켜져 있게 되므로, 애니메이션이 끝날 때 나머지를 넘긴다.
   */
  it("키보드보다 큰 서랍도 키보드가 다 올라오면 자리를 비운다", async () => {
    const root = await openTerminal();
    pick(root, ".tray__toggle--history").click();
    await settle();
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    try {
      coverViewport(336);
      await settle();
      // 1:1 로는 아직 64px 이 남는다.
      expect(root.querySelector<HTMLElement>(".tray__panel")?.style.height).toBe("64px");

      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(root.querySelector(".tray__panel")).toBeNull();
      expect(pick(root, ".tray__toggle--history").getAttribute("aria-pressed")).toBe("false");
    } finally {
      height.mockRestore();
      clearViewport();
      document.documentElement.removeAttribute("data-keyboard");
    }
  });

  /**
   * 키보드를 잡고 있는 것이 트레이의 칸이 아닐 수도 있다 — 대화창을 눌렀으면
   * 그 포커스는 터미널 것이고, 트레이를 다시 그려도 놓이지 않는다. 그래서 여는
   * 쪽이 직접 내린다. 트레이 밖에 선 칸으로 그 경우를 세운다.
   *
   * 열리는 것은 그 다음이다. 누르자마자 열면 서랍이 내려가는 키보드 위에 얹혀
   * 같이 미끄러져 내려온다 — 열리는 것이 아니라 딸려 내려오는 것으로 보인다.
   */
  it("서랍은 키보드를 내리고, 그 자리가 빈 뒤에 열린다", async () => {
    const root = await openTerminal();
    const outside = document.createElement("input");
    document.body.append(outside);
    try {
      coverViewport(336);
      await settle();
      outside.focus();
      expect(document.documentElement.getAttribute("data-keyboard")).toBe("on");

      pick(root, ".tray__toggle--keys").click();
      await settle();

      // 키보드는 내려간다 — 붙잡고 있던 포커스를 놓는다.
      expect(document.activeElement).not.toBe(outside);
      // 서랍은 아직이다. 그 자리에는 아직 키보드가 있다.
      expect(root.querySelector(".keys-grid")).toBeNull();

      coverViewport(0);
      await settle();

      expect(root.querySelector(".keys-grid")).not.toBeNull();
      expect(pick(root, ".tray__toggle--keys").getAttribute("aria-pressed")).toBe("true");
    } finally {
      outside.remove();
      clearViewport();
    }
  });

  /**
   * 키보드를 올린 것이 알약이 아닐 수도 있다 — 대화창을 누르면 그 포커스는
   * 터미널 것이다. 그때도 서랍은 자리를 내준다. 다시 그려서 닫으면 방금 키보드를
   * 띄운 포커스가 풀려 키보드가 같이 내려가므로, 트레이만 제자리에서 고친다.
   */
  it("다른 곳이 키보드를 올려도 서랍은 자리를 내준다", async () => {
    const root = await openTerminal();
    pick(root, ".tray__toggle--history").click();
    await settle();

    try {
      coverViewport(336);
      await settle();

      expect(document.documentElement.getAttribute("data-keyboard")).toBe("on");
      expect(root.querySelector(".tray__panel")).toBeNull();
      expect(pick(root, ".tray__toggle--history").getAttribute("aria-pressed")).toBe("false");
    } finally {
      clearViewport();
      document.documentElement.removeAttribute("data-keyboard");
    }
  });

  /**
   * 대화창을 두 번 두드리면 Tab 이다(2026-09-05 사용자 요청). 트레이의 Tab 칩과
   * 같은 키가 나가고, 한 번 두드린 것은 여전히 한 번이다.
   */
  it("대화창을 두 번 두드리면 Tab 이 나간다", async () => {
    const root = await openTerminal();
    const stage = pick(root, ".session__stage");
    const tap = (): void => {
      stage.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 40, clientY: 80 }));
    };
    tap();
    await settle();
    expect(sentInputIntents().filter((intent) => intent.key === "Tab")).toHaveLength(0);
    tap();
    await settle();
    expect(sentInputIntents().filter((intent) => intent.key === "Tab")).toHaveLength(1);
  });

  it("누르면 그 방향의 semantic intent가 나간다", async () => {
    const root = await openTerminal();

    // 방향은 자리가 아니라 라벨이 말한다. 3021:81309 가 십자를 한 줄로 폈고,
    // 자리로 찾던 시험은 그때 조용히 다른 키를 누르게 된다.
    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();

    expect(sentInputIntents()).toContainEqual(
      expect.objectContaining({
        case: "key",
        key: "ArrowLeft",
        code: "ArrowLeft",
      }),
    );
  });

  /**
   * One light tick under a finger on a drawn key, and the key still goes out.
   * Off, silence. The double-tap Tab is a gesture, not a key, and never ticks.
   */
  it("키를 누르면 한 번 진동한다", async () => {
    const root = await openTerminal();

    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(impacts).toEqual(["light"]);
    expect(sentInputIntents()).toContainEqual(
      expect.objectContaining({ case: "key", key: "ArrowLeft" }),
    );

    const stage = pick(root, ".session__stage");
    const tap = (): void => {
      stage.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 40, clientY: 80 }));
    };
    tap();
    tap();
    await settle();
    expect(sentInputIntents().filter((intent) => intent.key === "Tab")).toHaveLength(1);
    expect(impacts).toEqual(["light"]);
  });

  it("햅틱을 끄면 키가 진동하지 않는다", async () => {
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, haptics: false });
    const root = await openTerminal();

    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(impacts).toEqual([]);
    expect(sentInputIntents()).toContainEqual(
      expect.objectContaining({ case: "key", key: "ArrowLeft" }),
    );
  });
});

/**
 * 승인 시 Face ID: the relay writes the agent's runtime state beside the
 * frames, so this phone knows when the agent is waiting for an approval. With
 * the preference on, the first input sent during that approval waits for the
 * sheet; a passed sheet sends it, and later input for the same approval goes
 * straight through.
 */
describe("승인 시 Face ID", () => {
  const runtimeRecord = (attention: "approval_required" | "none"): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({
        kind: "control",
        body: {
          kind: "agent_runtime_state",
          payload: {
            terminal_epoch: "epoch-1",
            revision: "2",
            observed_through_output_seq: "1",
            lifecycle: "running",
            activity: "waiting",
            attention,
            ...(attention === "approval_required" ? { attention_id: "appr-1" } : {}),
            source: "provider_event",
          },
        },
      }),
    );
  /** Auth calls and the sends that followed each, in the order they happened. */
  let timeline: string[];

  beforeEach(() => {
    invocations.length = 0;
    refuseWritableAttach = false;
    timeline = [];
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, approvalBiometric: true });
    biometricAuth = (reason) => {
      timeline.push(`auth:${reason}`);
      return Promise.resolve();
    };
  });

  /** The dpad's ArrowLeft intents sent so far — the key these tests press. */
  const arrowLefts = (): number =>
    sentInputIntents().filter((intent) => intent.key === "ArrowLeft").length;

  async function openWaitingForApproval(): Promise<HTMLElement> {
    queuedRecords.push(runtimeRecord("approval_required"));
    const root = await openTerminal();
    // Let the pump consume the runtime record after the frame.
    await settle();
    return root;
  }

  it("승인을 기다리는 동안 첫 입력 앞에 Face ID를 묻고, 같은 승인의 다음 키는 묻지 않는다", async () => {
    const root = await openWaitingForApproval();
    const before = sentTerminalRecords.length;
    const sentBeforeAuth = () => {
      timeline.push(`sent:${sentTerminalRecords.length - before}`);
    };
    biometricAuth = (reason) => {
      sentBeforeAuth();
      timeline.push(`auth:${reason}`);
      return Promise.resolve();
    };

    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(timeline).toEqual(["sent:0", `auth:${t("approval.biometricRequired")}`]);
    expect(arrowLefts()).toBe(1);

    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(timeline).toHaveLength(2);
    expect(arrowLefts()).toBe(2);
  });

  it("시트를 취소하면 아무것도 보내지 않고 배너로 말한다", async () => {
    biometricAuth = () => Promise.reject("userCancel");
    const root = await openWaitingForApproval();

    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(arrowLefts()).toBe(0);
    expect(pick(root, ".toast--destructive").textContent).toBe(
      t("approval.biometricCancelled"),
    );
  });

  /**
   * A sheet the system could not show, or one the face failed, is not a
   * cancellation: the banner names what happened, or the owner is told they
   * cancelled something they did not.
   */
  it("시트를 쓸 수 없거나 확인에 실패하면 배너가 그렇게 말한다", async () => {
    biometricAuth = () => Promise.reject("passcodeNotSet: Biometry unavailable");
    let root = await openWaitingForApproval();
    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(arrowLefts()).toBe(0);
    expect(pick(root, ".toast--destructive").textContent).toBe(
      t("approval.biometricUnavailable"),
    );

    biometricAuth = () => Promise.reject("authenticationFailed");
    root = await openWaitingForApproval();
    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(arrowLefts()).toBe(0);
    expect(pick(root, ".toast--destructive").textContent).toBe(
      t("approval.biometricFailedToSend"),
    );
  });

  it("승인을 기다리지 않으면 묻지 않는다", async () => {
    queuedRecords.push(runtimeRecord("none"));
    const root = await openTerminal();
    await settle();

    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(timeline).toEqual([]);
    expect(arrowLefts()).toBe(1);
  });

  it("설정이 꺼져 있으면 승인 중에도 묻지 않는다", async () => {
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, approvalBiometric: false });
    const root = await openWaitingForApproval();

    pick(root, '.dpad__key[aria-label="←"]').click();
    await settle();
    expect(timeline).toEqual([]);
    expect(arrowLefts()).toBe(1);
  });
});

describe("session header activity", () => {
  beforeEach(() => {
    censusReports = [{ server_id: "lab", server_label: "Loopback lab",
      outcome: { state: "listed", sessions: [remoteSession()] } }];
  });
  const spinner = (root: HTMLElement) => root.querySelector(".session__state.dure-loader");
  async function observe(payload: Record<string, unknown>, attachmentId = activeAttachmentId!) {
    const record = new TextEncoder().encode(JSON.stringify({
      kind: "control", body: { kind: "agent_runtime_state", payload: {
        lifecycle: "running", activity: "waiting", attention: "none", revision: "1", ...payload,
      } },
    }));
    const pending = pendingTerminalReads.get(attachmentId);
    expect(pending).toBeDefined();
    pending!.resolve(record.buffer as ArrayBuffer);
    await settle();
  }

  it("does not animate a live session before work is observed or while waiting", async () => {
    const root = await openTerminal();
    expect(spinner(root)).toBeNull();
    await observe({ activity: "waiting" });
    expect(spinner(root)).toBeNull();
  });

  it("follows working and waiting without replacing the focused input or transcript", async () => {
    const root = await openTerminal();
    const field = root.querySelector<HTMLTextAreaElement>(".tray__box")!;
    const grid = root.querySelector(".structured-terminal__grid");
    field.focus();
    field.value = "unfinished draft";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const value = field.value;
    for (const activity of ["working", "waiting", "working", "waiting"]) {
      await observe({ activity });
      expect(spinner(root) !== null).toBe(activity === "working");
      if (activity === "working") expect(spinner(root)?.getAttribute("aria-label")).toBe(t("common.working"));
      expect(document.activeElement).toBe(field);
      expect(field.value).toBe(value);
      expect(root.querySelector(".structured-terminal__grid")).toBe(grid);
    }
    pressReturn(field);
    pick(root, ".tray__toggle--history").click();
    expect(root.querySelector(".history-item__text")?.textContent).toBe("unfinished draft");
  });

  it.each([
    { lifecycle: "starting" }, { lifecycle: "exited" },
    { attention: "approval_required" }, { attention: "input_required" }, { attention: "error" },
  ])("stops motion for %j even if activity still says working", async (payload) => {
    const root = await openTerminal();
    await observe({ activity: "working" });
    expect(spinner(root)).not.toBeNull();
    await observe({ activity: "working", ...payload });
    expect(spinner(root)).toBeNull();
  });

  it("retains the last runtime observation through drawer renders", async () => {
    const root = await openTerminal();
    await observe({ activity: "working" });
    pick(root, ".tray__toggle--history").click();
    expect(spinner(root)).not.toBeNull();
    const drawer = root.querySelector(".tray__panel");
    expect(drawer).not.toBeNull();
    await observe({ activity: "waiting" });
    expect(spinner(root)).toBeNull();
    expect(root.querySelector(".tray__panel")).toBe(drawer);
    pick(root, ".tray__toggle--history").click();
    expect(spinner(root)).toBeNull();
  });

  it("stops motion on an unavailable attachment and does not inherit it on reconnect", async () => {
    const root = await openTerminal();
    await observe({ activity: "working" });
    expect(spinner(root)).not.toBeNull();
    pendingTerminalReads.get(activeAttachmentId!)!.reject(new Error("Connection lost"));
    await settle();
    expect(spinner(root)).toBeNull();
    pick(root, ".session__header .icon-tap").click();
    await settle();
    pick(root, ".list__open").click();
    await settle();
    expect(spinner(root)).toBeNull();
  });

  it("ignores runtime records from a retired attachment", async () => {
    const root = await openTerminal();
    const retired = activeAttachmentId!;
    await observe({ activity: "working" });
    pick(root, ".session__header .icon-tap").click();
    await settle();
    pick(root, ".list__open").click();
    await settle();
    await observe({ activity: "waiting" });
    await observe({ activity: "working" }, retired);
    expect(spinner(root)).toBeNull();
  });
});

/**
 * 알림: the same runtime records, read for what changed while the app was
 * not on screen. A local notification is the only way the phone can say
 * "the agent wants you" once the person has switched away; while the app is
 * visible the screen already says it.
 */
describe("알림", () => {
  const runtimeRecord = (payload: Record<string, unknown>): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({
        kind: "control",
        body: {
          kind: "agent_runtime_state",
          payload: {
            terminal_epoch: "epoch-1",
            observed_through_output_seq: "1",
            lifecycle: "running",
            source: "provider_event",
            ...payload,
          },
        },
      }),
    );
  const working = (turn: string) =>
    runtimeRecord({
      revision: "2",
      activity: "working",
      attention: "none",
      turn_completed_count: turn,
    });
  const idle = (turn: string) =>
    runtimeRecord({
      revision: "3",
      activity: "waiting",
      attention: "none",
      turn_completed_count: turn,
    });
  const approval = runtimeRecord({
    revision: "3",
    activity: "waiting",
    attention: "approval_required",
    attention_id: "appr-1",
  });

  /** jsdom is always visible; the test decides what the phone reports. */
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
  };

  beforeEach(() => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
    notificationPermission = "granted";
  });

  afterEach(() => {
    setHidden(false);
  });

  async function openWith(...records: Uint8Array[]): Promise<HTMLElement> {
    queuedRecords.push(...records);
    const root = await openTerminal();
    await settle();
    return root;
  }

  it("syncs iOS push without opening a terminal, follows preferences, and refreshes OS permission", async () => {
    pushSupported = true;
    const root = await launch();
    const lastCall = () => invocations.filter((call) => call.command === "sync_push_notifications").pop();
    expect(lastCall()?.args.preference).toBe("approvals");
    expect(invocations.some((call) => call.command === "terminal_attach")).toBe(false);
    pick(root, ".home__settings").click();
    await settle();
    settingsRow(root, "notifications").click();
    await settle();
    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[0]?.click();
    await settle();
    expect(lastCall()?.args.preference).toBe("all");
    notificationPermission = "denied";
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(lastCall()?.args.preference).toBeNull();
    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[2]?.click();
    await settle();
    expect(lastCall()?.args.preference).toBeNull();
  });

  it("does not duplicate remote iOS alerts with attachment-local notifications", async () => {
    pushSupported = true;
    setHidden(true);
    await openWith(working("4"), approval);
    expect(sentNotifications).toEqual([]);
  });

  it("keeps a failed push registration visible until the user successfully retries", async () => {
    pushSupported = true;
    pushFailure = "Push service unavailable";
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    settingsRow(root, "notifications").click();
    await settle();
    expect(pick(root, ".settings-choice__note").textContent).toContain(pushFailure);
    pushFailure = null;
    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[1]?.click();
    await settle();
    expect(pick(root, ".settings-choice__note").textContent).not.toContain("Push service unavailable");
  });

  it("백그라운드에서 새 승인이 오면 세션 이름을 담아 알린다", async () => {
    setHidden(true);
    await openWith(working("4"), approval);
    expect(sentNotifications).toEqual([
      {
        title: t("승인 필요"),
        body: t("{session} 세션이 승인을 기다립니다", { session: "lab" }),
      },
    ]);
  });

  it("화면이 보이는 동안은 알리지 않는다", async () => {
    await openWith(working("4"), approval);
    expect(sentNotifications).toEqual([]);
  });

  it("승인만이면 턴이 끝나도 알리지 않는다", async () => {
    setHidden(true);
    await openWith(working("4"), idle("5"));
    expect(sentNotifications).toEqual([]);
  });

  it("모두면 턴이 끝날 때 알린다", async () => {
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, notifications: "all" });
    setHidden(true);
    await openWith(working("4"), idle("5"));
    expect(sentNotifications).toEqual([
      {
        title: t("작업 완료"),
        body: t("{session} 세션의 에이전트가 턴을 마쳤습니다", { session: "lab" }),
      },
    ]);
  });

  /**
   * The first turn on the wire: the Host omits a zero counter, the approval
   * is answered on the desktop, and the agent finishes while `waiting` the
   * whole time. The counter going 0→1 is what says the turn ended.
   */
  it("모두면 첫 턴이 대기 중에 끝나도 알린다", async () => {
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, notifications: "all" });
    setHidden(true);
    await openWith(approval, idle("1"));
    expect(sentNotifications).toEqual([
      {
        title: t("작업 완료"),
        body: t("{session} 세션의 에이전트가 턴을 마쳤습니다", { session: "lab" }),
      },
    ]);
  });

  it("끔이면 승인도 알리지 않는다", async () => {
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, notifications: "off" });
    setHidden(true);
    await openWith(working("4"), approval);
    expect(sentNotifications).toEqual([]);
  });

  it("권한이 없으면 보내지 않는다", async () => {
    notificationPermission = "denied";
    setHidden(true);
    await openWith(working("4"), approval);
    expect(sentNotifications).toEqual([]);
  });

  it("모두나 승인만을 고르면 권한을 요청하고, 거부되면 행과 선택 화면이 그렇게 말한다", async () => {
    notificationPermission = "default";
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    // Never asked: the row and the note say the choice is what asks.
    expect(pick(settingsRow(root, "notifications"), ".settings__row-detail").textContent).toBe(
      t("{choice} · 권한 필요", { choice: t("승인만") }),
    );
    settingsRow(root, "notifications").click();
    await settle();
    expect(pick(root, ".settings-choice__note").textContent).toBe(
      `${t("notifications.local.description")} ${t("notifications.permission.prompt")}`,
    );

    sheetAnswer = "denied";
    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[0]?.click();
    await settle();
    expect(permissionRequests).toBe(1);
    expect(pick(root, ".settings-choice__note").textContent).toBe(
      `${t("notifications.local.description")} ${t("notifications.permission.denied")}`,
    );

    pick(root, ".settings-choice .icon-tap").click();
    await settle();
    expect(pick(settingsRow(root, "notifications"), ".settings__row-detail").textContent).toBe(
      t("{choice} · 권한 없음 — 설정에서 허용", { choice: t("모두") }),
    );

    // 끔 asks nothing and the row stops warning: there is nothing to permit.
    settingsRow(root, "notifications").click();
    await settle();
    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[2]?.click();
    await settle();
    expect(permissionRequests).toBe(1);
    pick(root, ".settings-choice .icon-tap").click();
    await settle();
    expect(pick(settingsRow(root, "notifications"), ".settings__row-detail").textContent).toBe(
      t("끔"),
    );
  });

  it("이미 허용되어 있으면 다시 묻지 않고, 행은 선택만 보여 준다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    expect(pick(settingsRow(root, "notifications"), ".settings__row-detail").textContent).toBe(
      t("승인만"),
    );
    settingsRow(root, "notifications").click();
    await settle();
    expect(pick(root, ".settings-choice__note").textContent).toBe(
      t("notifications.local.description"),
    );
    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[1]?.click();
    await settle();
    expect(permissionRequests).toBe(0);
  });

  it("Android에서는 iOS 백그라운드 안내를 노출하지 않는다", async () => {
    const root = await launch();
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
    try {
      pick(root, ".home__settings").click();
      await settle();
      settingsRow(root, "notifications").click();
      await settle();

      expect(pick(root, ".settings-choice__note").textContent).toBe(
        t("notifications.local.description"),
      );
      expect(root.textContent).not.toContain("iOS");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("처음 묻는 시트에서 허용하면 경고가 사라진다", async () => {
    notificationPermission = "default";
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    settingsRow(root, "notifications").click();
    await settle();
    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[1]?.click();
    await settle();
    expect(permissionRequests).toBe(1);
    expect(pick(root, ".settings-choice__note").textContent).toBe(
      t("notifications.local.description"),
    );
    pick(root, ".settings-choice .icon-tap").click();
    await settle();
    expect(pick(settingsRow(root, "notifications"), ".settings__row-detail").textContent).toBe(
      t("승인만"),
    );
  });

  it("설정 화면은 현재 권한 상태를 읽어 행에 보여 준다", async () => {
    notificationPermission = "denied";
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    expect(pick(settingsRow(root, "notifications"), ".settings__row-detail").textContent).toBe(
      t("{choice} · 권한 없음 — 설정에서 허용", { choice: t("승인만") }),
    );
  });

  /**
   * The plugin's own `isPermissionGranted` answers from a snapshot taken at
   * page load, so an allowance made in the system settings while the app was
   * away never reached it: the row kept saying 권한 없음 and every notice was
   * dropped until the app was killed (2026-09-06). The app reads the live
   * state instead — the row and the notice both follow it without a restart.
   */
  it("시스템 설정에서 허용하면 재시작 없이 행과 알림이 따라온다", async () => {
    notificationPermission = "denied";
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    expect(pick(settingsRow(root, "notifications"), ".settings__row-detail").textContent).toBe(
      t("{choice} · 권한 없음 — 설정에서 허용", { choice: t("승인만") }),
    );
    // The plugin's snapshot is taken; the person now allows it in 설정 and comes back.
    notificationPermission = "granted";
    pick(root, ".settings .icon-tap").click();
    await settle();
    pick(root, ".home__settings").click();
    await settle();
    expect(pick(settingsRow(root, "notifications"), ".settings__row-detail").textContent).toBe(
      t("승인만"),
    );
    expect(permissionRequests).toBe(0);

    pick(root, ".settings .icon-tap").click();
    await settle();
    setHidden(true);
    await openWith(working("4"), approval);
    expect(sentNotifications).toHaveLength(1);
  });
});

/**
 * 트레이에 어떤 키를 둘지 고르는 시트. 저장은 이 폰에만 남는다.
 */
describe("키 트레이 편집", () => {
  beforeEach(() => {
    invocations.length = 0;
    refuseWritableAttach = false;
    localStorage.clear();
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
  });

  /** 설정 → 키 스트립. 서랍의 편집 문은 없어졌다(3211:82211). */
  async function openStrip(): Promise<HTMLElement> {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    settingsRow(root, "key-strip").click();
    await settle();
    if (!root.querySelector(".key-strip")) throw new Error("no key strip");
    return root;
  }

  function cell(root: HTMLElement, label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>(".key-strip__cell")].find(
      (candidate) => candidate.textContent === label,
    );
    if (!found) throw new Error(`no ${label} cell in the key strip`);
    return found;
  }

  it("고른 키가 곧바로 트레이에 선다", async () => {
    const root = await openStrip();

    // ^D 를 넣고 Esc 를 뺀다 (^C·Esc 는 기본 스트립에 이미 있다).
    cell(root, "^D").click();
    await settle();
    cell(root, "Esc").click();
    await settle();

    // 저장된 스트립은 이 폰의 것이다: 다음에 여는 세션이 그것을 그린다.
    const session = await openTerminal();
    const tray = [...session.querySelectorAll(".tray__pill .tray__key")].map(
      (chip) => chip.textContent,
    );
    expect(tray).toContain("^D");
    expect(tray).not.toContain("Esc");
  });

  /**
   * 저장 버튼이 없는 화면이므로 누른 그 순간 저장돼야 한다 — 뒤로 가서야
   * 반영되는 미리보기는 미리보기가 아니라 두 번째 스트립이다.
   */
  it("누른 즉시 이 폰에 저장된다", async () => {
    const root = await openStrip();

    cell(root, "Esc").click();
    await settle();

    expect(localStorage.getItem("hebbian.keytray.v1")).not.toContain('"esc"');
  });

  /** 미리보기 칩을 탭하면 그 키가 스트립에서 빠진다. */
  it("미리보기 칩을 탭하면 빠진다", async () => {
    const root = await openStrip();

    const chip = [...root.querySelectorAll<HTMLButtonElement>(".key-strip__chip")].find(
      (candidate) => candidate.textContent === "Esc",
    );
    chip?.click();
    await settle();

    expect(
      [...root.querySelectorAll(".key-strip__chip")].map((node) => node.textContent),
    ).not.toContain("Esc");
  });

  /**
   * 재설정은 먼저 묻는다 (Figma 3202:81879). 손으로 맞춘 스트립을 버리는
   * 누름이라, 물어보지 않는 버튼이면 잘못 스친 손가락이 되돌릴 수 없다.
   */
  it("기본값 버튼은 먼저 묻고, 취소하면 스트립이 그대로다", async () => {
    const root = await openStrip();

    cell(root, "Esc").click();
    await settle();
    pick(root, ".key-strip__reset").click();
    await settle();

    expect(root.querySelector(".confirm-dialog")).not.toBeNull();
    // 묻는 동안에는 아무것도 되돌리지 않는다.
    expect(
      [...root.querySelectorAll(".key-strip__chip")].map((node) => node.textContent),
    ).not.toContain("Esc");

    pick(root, ".confirm-dialog__button:not(.confirm-dialog__button--confirm)").click();
    await settle();

    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(
      [...root.querySelectorAll(".key-strip__chip")].map((node) => node.textContent),
    ).not.toContain("Esc");
  });

  it("재설정을 누르면 처음 스트립이 돌아오고 저장된다", async () => {
    const root = await openStrip();

    cell(root, "Esc").click();
    await settle();
    pick(root, ".key-strip__reset").click();
    await settle();
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(
      [...root.querySelectorAll(".key-strip__chip")].map((node) => node.textContent),
    ).toContain("Esc");
    expect(localStorage.getItem("hebbian.keytray.v1")).toContain('"esc"');
  });

  /** 설정 → 키보드 → 키스트립. 세션을 열지 않고도 같은 화면에 닿는다. */
  it("설정의 키스트립 행이 같은 화면을 연다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    const strip = settingsRow(root, "key-strip");
    // 그려지는 칩의 수다 — 이 빌드가 못 읽는 id 를 센 숫자를 옆 화면이 반증한다.
    expect(strip.querySelector(".settings__row-detail")?.textContent).toBe(
      t("키 {count}개", { count: 8 }),
    );
    strip.click();
    await settle();

    expect(root.querySelector(".key-strip")).not.toBeNull();
    expect([...root.querySelectorAll(".key-strip__chip")].map((chip) => chip.textContent)).toEqual([
      "⇧Tab",
      "?",
      "/",
      "Esc",
      "Tab",
      "Ctrl",
      "Opt",
      "^C",
    ]);

    pick(root, ".key-strip__bar .icon-tap").click();
    await settle();
    expect(root.querySelector(".settings")).not.toBeNull();
  });
});

describe("연결의 실제 권한", () => {
  beforeEach(() => {
    invocations.length = 0;
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
    vi.resetModules();
  });

  /**
   * 쓰기가 기본이 된 뒤에도, 읽기 전용으로 *떨어졌을 때*는 화면이 그렇게
   * 말해야 한다. 평상시에 늘 떠 있는 문장은 읽히지 않고, 읽히지 않는 문장은
   * 정작 예외가 생겼을 때 그것을 가린다.
   */
  it("쓰기가 거부되어 관찰자로 떨어지면 화면이 그렇게 말한다", async () => {
    refuseWritableAttach = true;

    const root = await openTerminal();

    // 이유를 아는 경우에는 역할이 아니라 그 이유를 말한다 — 다음에 할 일이
    // 코드마다 다르기 때문이다.
    expect(root.textContent).toContain(t("읽기 전용 — 다른 곳에서 입력 중입니다"));
  });

  it("저장한 글꼴 크기와 스크롤 속도를 터미널 생성에 적용한다", async () => {
    saveSettingsPreferences({
      ...DEFAULT_SETTINGS_PREFERENCES,
      fontSize: 15,
      scrollSpeed: "fast",
    });

    const root = await openTerminal();
    await vi.waitFor(() => expect(root.textContent).toContain("ready"));
    const grid = root.querySelector<HTMLElement>(".structured-terminal__grid");
    const transcript = root.querySelector<HTMLElement>(".session__terminal");
    expect(grid?.style.fontSize).toBe("15px");
    if (!transcript) throw new Error("no transcript");
    Object.defineProperties(transcript, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
    });
    transcript.scrollTop = 10;
    const touch = (type: string, clientY: number): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: [{ identifier: 1, clientX: 100, clientY }],
      });
      return event;
    };
    transcript.dispatchEvent(touch("touchstart", 100));
    transcript.dispatchEvent(touch("touchmove", 80));
    expect(transcript.scrollTop).toBe(42);
  });

  /**
   * 홀드 드래그가 무장한 뒤의 손가락은 화살표의 것이다. 속도 오버레이가 그
   * 밑에서 트랜스크립트를 밀면 빠르게에서는 0.6배로 미끄러지고 느리게에서는
   * 거꾸로 간다 — 오버레이는 취소된 이동에 양보해야 한다.
   */
  it("빠르게로 두어도 홀드 드래그 중에는 트랜스크립트가 밀리지 않는다", async () => {
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, scrollSpeed: "fast" });

    const root = await openTerminal();
    await vi.waitFor(() => expect(root.textContent).toContain("ready"));
    const transcript = root.querySelector<HTMLElement>(".session__terminal");
    if (!transcript) throw new Error("no transcript");
    vi.useFakeTimers();
    try {
      transcript.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }),
      );
      vi.advanceTimersByTime(HOLD_MS);
      transcript.scrollTop = 10;
      const touch = (type: string, clientY: number): Event => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: [{ clientY }] });
        return event;
      };
      transcript.dispatchEvent(touch("touchstart", 100));
      const move = touch("touchmove", 80);
      transcript.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
      expect(transcript.scrollTop).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("홈 화면", () => {
  beforeEach(() => {
    invocations.length = 0;
  });

  it("첫 화면에 서버 선택 없이 세션 이름이 나온다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];

    const root = await launch();

    const text = root.textContent ?? "";
    expect(root.querySelector(".session-row__title")?.textContent).toBe("lab");
    expect(text).toContain("lab");
    expect(root.querySelector(".card__row")).toBeNull();
  });

  it("설정 버튼이 Figma의 그룹형 설정 화면을 연다", async () => {
    hubRows = [hubRow(), { ...hubRow(), id: ` ${HUB_ID}-2`, endpoint: "192.168.0.13:47821" }];
    const root = await launch();

    pick(root, ".home__settings").click();
    await settle();

    expect(root.querySelector(".settings")).not.toBeNull();
    expect(settingsRow(root, "hosts").querySelector(".settings__row-detail")?.textContent).toBe(
      "Loopback lab",
    );
    expect(
      [...root.querySelectorAll(".settings__label")].map((label) => label.textContent),
    ).toEqual(["연결", "일반", "키보드", "터미널", "보안", "도움말"].map((label) => t(label)));
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('[role="switch"]')].map((toggle) => [
        toggle.getAttribute("aria-checked"),
        toggle.disabled,
      ]),
    ).toEqual([
      ["true", false],
      ["false", true],
    ]);
  });

  it("햅틱 스위치를 누르면 저장되고 되돌릴 수 있다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    settingsRow(root, "haptics").click();
    await settle();
    expect(settingsRow(root, "haptics").getAttribute("aria-checked")).toBe("false");
    expect(loadSettingsPreferences().haptics).toBe(false);
    // Turning it off gives no tick: there is nothing to preview.
    expect(impacts).toEqual([]);

    settingsRow(root, "haptics").click();
    await settle();
    expect(settingsRow(root, "haptics").getAttribute("aria-checked")).toBe("true");
    expect(loadSettingsPreferences().haptics).toBe(true);
    // Turning it on is the one preview a setting with no visible effect can give.
    expect(impacts).toEqual(["light"]);
  });

  /**
   * Face ID is a device fact before it is a preference: the row is a live
   * switch only where the plugin says a sensor exists, and it is drawn
   * disabled, with the reason, everywhere else — the desktop shell included.
   */
  it("Face ID 행은 센서가 있을 때만 살아 있는 스위치다", async () => {
    biometricStatus = () => Promise.resolve({ isAvailable: true, biometryType: 2 });
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    const row = settingsRow(root, "face-id");
    expect(row.disabled).toBe(false);
    expect(row.textContent).toContain(t("settings.security.approvalBiometric"));
    expect(row.textContent).not.toContain("Face ID");
    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(row.querySelector(".settings__row-detail")).toBeNull();
  });

  it("센서가 없으면 Face ID 행은 꺼진 채 이유를 말한다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    const row = settingsRow(root, "face-id");
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(row.querySelector(".settings__row-detail")?.textContent).toBe(
      t("이 기기에서 사용할 수 없음"),
    );
  });

  /**
   * Arming and disarming both go through the sheet. A dismissed sheet leaves
   * the preference where it was — turning the lock off must not be a plain tap.
   */
  it("Face ID 스위치는 켤 때도 끌 때도 확인을 거친다", async () => {
    biometricStatus = () => Promise.resolve({ isAvailable: true, biometryType: 2 });
    const reasons: string[] = [];
    biometricAuth = (reason) => {
      reasons.push(reason);
      return Promise.resolve();
    };
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    settingsRow(root, "face-id").click();
    await settle();
    expect(reasons).toEqual([t("settings.security.enableApprovalBiometricReason")]);
    expect(loadSettingsPreferences().approvalBiometric).toBe(true);
    expect(settingsRow(root, "face-id").getAttribute("aria-checked")).toBe("true");

    biometricAuth = (reason) => {
      reasons.push(reason);
      return Promise.reject("userCancel");
    };
    settingsRow(root, "face-id").click();
    await settle();
    expect(reasons[1]).toBe(t("settings.security.disableApprovalBiometricReason"));
    expect(loadSettingsPreferences().approvalBiometric).toBe(true);
    expect(settingsRow(root, "face-id").getAttribute("aria-checked")).toBe("true");
    expect(root.querySelector(".toast--destructive")).toBeNull();

    biometricAuth = () => Promise.reject(new Error("authenticationFailed"));
    settingsRow(root, "face-id").click();
    await settle();
    expect(loadSettingsPreferences().approvalBiometric).toBe(true);
    expect(pick(root, ".toast--destructive").textContent).toBe(
      t("settings.security.biometricFailed"),
    );
  });

  it("네 설정 선택 화면이 한 저장값을 즉시 갱신한다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();

    const openMainRow = async (id: string) => {
      settingsRow(root, id).click();
      await settle();
    };
    const choose = async (index: number) => {
      root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[index]?.click();
      await settle();
      pick(root, ".settings-choice .icon-tap").click();
      await settle();
    };

    await openMainRow("language");
    await choose(1);
    await openMainRow("notifications");
    await choose(2);
    await openMainRow("font-size");
    await choose(4);
    await openMainRow("scroll");
    await choose(2);

    expect(loadSettingsPreferences()).toEqual({
      language: "ko",
      notifications: "off",
      fontSize: 15,
      scrollSpeed: "fast",
      haptics: true,
      approvalBiometric: false,
    });
  });

  /**
   * 언어는 저장값 하나가 아니라 화면 전체다: 고르는 순간 제목이 그 언어로 바뀌고,
   * `<html lang>`이 따라와야 보조 기술과 글꼴 선택이 같은 언어를 본다.
   * jsdom의 navigator.language는 en-US라 자동은 English다.
   */
  it("언어를 고르면 화면이 그 언어로 다시 그려진다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    expect(pick(root, ".pair-bar__title").textContent).toBe("Settings");

    settingsRow(root, "language").click();
    await settle();
    expect(pick(root, ".pair-bar__title").textContent).toBe("Language");

    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[1]?.click();
    await settle();
    expect(pick(root, ".pair-bar__title").textContent).toBe("언어");
    expect(document.documentElement.lang).toBe("ko");

    pick(root, ".settings-choice .icon-tap").click();
    await settle();
    expect(pick(root, ".pair-bar__title").textContent).toBe("설정");
    expect(settingsRow(root, "language").querySelector(".settings__row-detail")?.textContent).toBe(
      "한국어",
    );

    settingsRow(root, "language").click();
    await settle();
    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[2]?.click();
    await settle();
    expect(pick(root, ".pair-bar__title").textContent).toBe("Language");
    expect(document.documentElement.lang).toBe("en");
  });

  /**
   * 화살표로 고르면 화면이 다시 그려지고, 이 화면이 포커스했던 행은 떨어져 나간다.
   * 새 트리의 고른 행에 포커스가 내려앉아야 다음 화살표가 이어진다.
   */
  it("선택 화면에서 화살표로 옮겨도 고른 행이 포커스를 지킨다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    settingsRow(root, "scroll").click();
    await settle();

    const checkedIndex = () =>
      [...root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")].findIndex(
        (row) => row.getAttribute("aria-checked") === "true",
      );
    const arrow = (key: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );

    pick(root, '.settings-choice__row[aria-checked="true"]').focus();
    expect(checkedIndex()).toBe(1);
    arrow("ArrowDown");
    await settle();
    expect(checkedIndex()).toBe(2);
    expect(document.activeElement).toBe(pick(root, '.settings-choice__row[aria-checked="true"]'));
    expect(loadSettingsPreferences().scrollSpeed).toBe("fast");

    arrow("ArrowUp");
    await settle();
    expect(checkedIndex()).toBe(1);
    expect(document.activeElement).toBe(pick(root, '.settings-choice__row[aria-checked="true"]'));
    expect(loadSettingsPreferences().scrollSpeed).toBe("normal");

    // 언어 화면은 고를 때마다 다른 언어로 다시 그려진다 — 그래도 포커스는 이어진다.
    pick(root, ".settings-choice .icon-tap").click();
    await settle();
    settingsRow(root, "language").click();
    await settle();
    pick(root, '.settings-choice__row[aria-checked="true"]').focus();
    arrow("ArrowDown");
    await settle();
    expect(pick(root, ".pair-bar__title").textContent).toBe("언어");
    arrow("ArrowDown");
    await settle();
    expect(pick(root, ".pair-bar__title").textContent).toBe("Language");
    expect(document.activeElement).toBe(pick(root, '.settings-choice__row[aria-checked="true"]'));
    expect(document.activeElement?.querySelector(".settings-choice__label")?.textContent).toBe(
      "English",
    );
  });

  /**
   * The notifications screen redraws once more when the system answers the
   * permission read. That redraw must not drop the row a keyboard user just
   * moved to, or the next arrow goes nowhere.
   */
  it("알림 화면은 권한 응답으로 다시 그려져도 고른 행이 포커스를 지킨다", async () => {
    notificationPermission = "default";
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    settingsRow(root, "notifications").click();
    await settle();
    const arrow = (key: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );

    // Not yet decided: the sheet answers, the note changes, the screen
    // redraws — focus still holds.
    pick(root, '.settings-choice__row[aria-checked="true"]').focus();
    arrow("ArrowUp");
    await settle();
    expect(loadSettingsPreferences().notifications).toBe("all");
    expect(permissionRequests).toBe(1);
    expect(document.activeElement).toBe(pick(root, '.settings-choice__row[aria-checked="true"]'));

    // Already granted: nothing changes, nothing redraws, focus still holds.
    arrow("ArrowDown");
    await settle();
    expect(loadSettingsPreferences().notifications).toBe("approvals");
    expect(permissionRequests).toBe(1);
    expect(document.activeElement).toBe(pick(root, '.settings-choice__row[aria-checked="true"]'));
  });

  /** A switch stays where focus was: flipping 햅틱 twice from the keyboard must work. */
  it("스위치 행은 켜고 끌 때 포커스를 지킨다", async () => {
    biometricStatus = () => Promise.resolve({ isAvailable: true, biometryType: 2 });
    biometricAuth = () => Promise.resolve();
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    settingsRow(root, "haptics").focus();
    settingsRow(root, "haptics").click();
    await settle();
    expect(settingsRow(root, "haptics").getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(settingsRow(root, "haptics"));
    settingsRow(root, "haptics").click();
    await settle();
    expect(settingsRow(root, "haptics").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(settingsRow(root, "haptics"));

    settingsRow(root, "face-id").focus();
    settingsRow(root, "face-id").click();
    await settle();
    expect(settingsRow(root, "face-id").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(settingsRow(root, "face-id"));
  });

  it("선택 화면에서 탭으로 고르면 포커스를 옮기지 않는다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    settingsRow(root, "scroll").click();
    await settle();

    root.querySelectorAll<HTMLButtonElement>(".settings-choice__row")[1]?.click();
    await settle();
    expect(document.activeElement?.matches(".settings-choice__row")).not.toBe(true);
  });

  it("도움말 행이 시스템 브라우저로 도움말 주소를 연다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();
    invocations.length = 0;

    const help = settingsRow(root, "help");
    expect(help.disabled).toBe(false);
    help.click();
    await settle();

    expect(openedUrls).toEqual([HELP_URL]);
    expect(invocations.some((call) => call.command.startsWith("plugin:opener"))).toBe(false);
    expect(root.querySelector(".settings")).not.toBeNull();
  });

  it("도움말을 열지 못하면 배너로 알린다", async () => {
    failOpen = true;
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    settingsRow(root, "help").click();
    await settle();

    expect(pick(root, ".toast--destructive").textContent).toBe(
      t("링크를 열지 못했습니다: {message}", { message: `Not allowed to open url ${HELP_URL}` }),
    );
    expect(root.querySelector(".settings")).not.toBeNull();
  });

  it("피드백 보내기 행이 이슈 페이지를 연다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    settingsRow(root, "feedback").click();
    await settle();

    expect(openedUrls).toHaveLength(1);
    expect(openedUrls[0]?.startsWith("https://github.com/hebbianai/hebbian-releases/issues/new?")).toBe(
      true,
    );
    expect(openedUrls[0]).toContain(encodeURIComponent(packageMetadata.version));
    expect(root.querySelector(".settings")).not.toBeNull();
  });

  it("호스트 상세 저장은 화면에 없는 키와 식별자를 보존한다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    pick(root, ".host-settings__list-row").click();
    await settle();

    const port = root.querySelector<HTMLInputElement>('[name="port"]');
    if (!port) throw new Error("host port input missing");
    port.value = "2222";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    pick(root, ".host-settings__save").click();
    await settle();

    const saved = invocations.find((entry) => entry.command === "save_server")?.args.entry as
      | ReturnType<typeof serverRow>
      | undefined;
    expect(saved?.port).toBe(2222);
    expect(saved?.id).toBe("lab");
    expect(saved?.host_key_fingerprint).toBe(serverRow().host_key_fingerprint);

    pick(root, ".host-settings__list-row").click();
    await settle();
    expect(root.querySelector(".host-settings__status--connected")).not.toBeNull();
  });

  /**
   * 폰은 이 상자에 SSH 로 직접 닿는다. 시작만 노트북을 거치던 것은 게이트웨이가
   * 강제 명령 키의 생성을 거절했기 때문이고, 운영자가 `--allow-create` 를 켜면
   * 이 경로가 열린다 — 노트북이 꺼져 있어도.
   */
  it("서버 화면에서 세션을 시작하면 그 상자에 만들고 곧장 붙는다", async () => {
    createRefusal = false;
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    pick(root, ".host-settings__list-row").click();
    await settle();

    pick(root, ".host-settings__start").click();
    await settle();

    const created = invocations.find((entry) => entry.command === "ssh_create_session");
    expect((created?.args as { serverId?: string } | undefined)?.serverId).toBe("lab");
    // 만든 뒤 그 세션에 붙는다 — 만들고 목록으로 돌아가면 방금 만든 것을
    // 사람이 다시 찾아야 한다.
    expect(invocations.map((entry) => entry.command)).toContain("attach_session");
  });

  /**
   * 켜지 않은 키의 거절은 숨기지 않는다. 그 문장이 어느 플래그를 켜야 하는지
   * 말하고, 그것을 켤 수 있는 사람이 지금 화면을 보고 있다.
   */
  it("생성을 허용하지 않은 상자의 거절 문장을 그대로 보여준다", async () => {
    createRefusal = true;
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    pick(root, ".host-settings__list-row").click();
    await settle();

    pick(root, ".host-settings__start").click();
    await settle();

    expect(root.querySelector(".toast")?.textContent).toContain("--allow-create");
    expect(invocations.map((entry) => entry.command)).not.toContain("attach_session");
    createRefusal = false;
  });

  it("편집 전 호스트 확인 결과를 새 엔드포인트 상태로 재사용하지 않는다", async () => {
    censusReports = [];
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    holdServerDiscovery = true;
    pick(root, ".host-settings__list-row").click();
    await settle();

    const port = root.querySelector<HTMLInputElement>('[name="port"]');
    if (!port) throw new Error("host port input missing");
    port.value = "2222";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    pick(root, ".host-settings__save").click();
    await settle();

    releaseServerDiscovery?.(false);
    await settle();

    expect(root.querySelector(".host-settings__offline")).toBeNull();
  });

  it("호스트 저장 중에는 이전 엔드포인트 재시도를 취소한다", async () => {
    censusReports = [];
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    holdServerDiscovery = true;
    pick(root, ".host-settings__list-row").click();
    await settle();
    releaseServerDiscovery?.(false);
    await settle();

    const retry = pick(root, ".host-settings__retry");
    const port = root.querySelector<HTMLInputElement>('[name="port"]');
    if (!port) throw new Error("host port input missing");
    port.value = "2222";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    holdServerMutation = "save";
    pick(root, ".host-settings__save").click();
    await settle();

    retry.click();
    expect(root.querySelector(".host-settings__retry")).toBeNull();
    expect(invocations.filter((entry) => entry.command === "discover_sessions")).toHaveLength(1);
    expect(clearTimeout).toHaveBeenCalled();

    releaseServerMutation?.();
    await settle();
    clearTimeout.mockRestore();
  });

  it("호스트 저장 실패 뒤 편집한 값을 그대로 둔다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    pick(root, ".host-settings__list-row").click();
    await settle();

    const port = root.querySelector<HTMLInputElement>('[name="port"]');
    if (!port) throw new Error("host port input missing");
    port.value = "2222";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    failServerMutation = true;
    pick(root, ".host-settings__save").click();
    await settle();

    expect(root.querySelector<HTMLInputElement>('[name="port"]')?.value).toBe("2222");
  });

  it("호스트 저장이 무효화한 census의 로딩 상태를 남기지 않는다", async () => {
    holdCensus = true;
    const root = await launch();
    expect(root.querySelector(".home__pull--busy")).not.toBeNull();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    pick(root, ".host-settings__list-row").click();
    await settle();

    const port = root.querySelector<HTMLInputElement>('[name="port"]');
    if (!port) throw new Error("host port input missing");
    port.value = "2222";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    pick(root, ".host-settings__save").click();
    await settle();
    pick(root, ".host-settings .icon-tap").click();
    pick(root, ".settings .icon-tap").click();

    expect(root.querySelector(".home__pull--busy")).toBeNull();
    releaseCensus?.();
    await settle();
    expect(root.querySelector(".home__pull--busy")).toBeNull();
  });

  /**
   * 시안에는 "시작된 Agents 1,284", "Agent 시간 142h", "생성된 PR 96" 같은
   * 통계와 계정 사용량 바가 있었다. 이 앱은 그 어느 것도 세지 않는다. 그럴듯한
   * 숫자를 렌더하면 화면이 측정하지 않은 것을 측정했다고 주장하고, 그 화면을
   * 보고 사람이 판단한다. 자리만 잡아두는 회색 상자도 두지 않는다 — 영원히
   * 비어 있는 카드는 고장으로 읽힌다.
   */
  it("세지 않은 숫자를 홈에 적지 않는다", async () => {
    censusReports = [
      {
        server_id: "a",
        server_label: "가 서버",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];

    const root = await launch();

    const text = root.textContent ?? "";
    // 한국어와 영어 양쪽을 검사한다 — 한쪽만 막으면 다른 로케일에서 가짜
    // 숫자가 되살아나도 시험이 통과한다.
    for (const claim of [
      "시작된",
      "Agent 시간",
      "생성된 PR",
      "계정 사용량",
      "워크트리",
      "Agents started",
      "Agent hours",
      "PRs opened",
      "worktree",
    ]) {
      expect(text).not.toContain(claim);
    }
  });

  it("shows connection failure without a separate server card on empty Home", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "unreachable", code: "x", detail: "y" },
      },
    ];

    const root = await launch();

    const text = root.textContent ?? "";
    expect(text).not.toContain("Loopback lab");
    expect(root.querySelector(".failures")).toBeNull();
    expect(text).toMatch(/Could not connect|연결하지 못했습니다/);
  });
});

describe("v2 페어링 — QR과 코드가 둘 다 있어야", () => {
  beforeEach(() => {
    invocations.length = 0;
    offlineCalls.length = 0;
  });

  const V2 = "hmux-pair:2?s=AAAAAAAAAAAAAAAAAAAAAA&c=BBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  /**
   * v1 QR 을 스캔한 사람에게 코드를 물으면 답이 없는 질문이 되고, v2 QR 을 v1
   * 으로 다루면 "노트북에 연결할 수 없습니다"라는 틀린 진단이 나온다. 흐름을
   * 가르는 것이 이 화면의 첫 일이다.
   */
  it("v2 QR을 스캔하면 노트북에 붙지 않고 코드를 묻는다", async () => {
    const root = await openPairing();

    const area = root.querySelector("textarea");
    if (!area) throw new Error("no textarea");
    area.value = V2;
    pick(root, ".paste__submit").click();
    await settle();

    // 코드 입력 칸이 떴고, v1 경로는 건드리지 않았다.
    expect(root.querySelector(".form__input--code")).not.toBeNull();
    expect(invocations.find((entry) => entry.command === "pair_from_scan")).toBeUndefined();
  });

  /**
   * 노트북 1단계의 QR 은 앱 설치 페이지 주소다. 앱을 이미 깐 폰이 그것을 대면
   * SSH 해독기까지 내려가 "hmux 페어링 코드가 아닙니다" 로 끝났다 — 맞는
   * 말이지만 다음에 무엇을 할지 말해 주지 않는다(2026-09-04 사용자 보고).
   */
  it("설치 페이지 주소를 스캔하면 무엇을 해야 하는지 말해 준다", async () => {
    const root = await openPairing();

    const area = root.querySelector("textarea");
    if (!area) throw new Error("no textarea");
    area.value = "https://github.com/hebbianai/hebbian-releases/releases/latest";
    pick(root, ".paste__submit").click();
    await settle();

    expect(root.querySelector(".toast")?.textContent).toBe(
      t("앱을 내려받는 주소입니다. 노트북에서 '이 컴퓨터와 페어링'을 눌러 다음 코드를 띄우세요."),
    );
    // SSH 해독기까지 내려가지 않는다.
    expect(invocations.find((entry) => entry.command === "pair_from_scan")).toBeUndefined();
  });

  it("입력한 코드가 정규화되어 넘어간다", async () => {
    const root = await openPairing();
    const area = root.querySelector("textarea");
    if (!area) throw new Error("no textarea");
    area.value = V2;
    pick(root, ".paste__submit").click();
    await settle();

    const code = root.querySelector<HTMLInputElement>(".form__input--code");
    if (!code) throw new Error("no code input");
    // 사람이 화면을 보고 치는 방식: 소문자에 하이픈.
    code.value = "k7f2-q0";
    pick(root, ".pair__code").click();
    await settle();

    expect(offlineCalls).toEqual([{ scanned: V2, code: "K7F2Q0" }]);
  });

  /**
   * 유도 비용을 치르기 전에 되돌려 준다. 그리고 페이로드를 잃지 않는다 — 틀린
   * 것은 코드 한 글자인데 QR 을 다시 스캔하게 만들면 사용자는 노트북으로
   * 돌아간다.
   */
  it("코드가 여섯 글자가 아니면 유도를 걸지 않고 화면에 남는다", async () => {
    const root = await openPairing();
    const area = root.querySelector("textarea");
    if (!area) throw new Error("no textarea");
    area.value = V2;
    pick(root, ".paste__submit").click();
    await settle();

    const code = root.querySelector<HTMLInputElement>(".form__input--code");
    if (!code) throw new Error("no code input");
    code.value = "K7F2";
    pick(root, ".pair__code").click();
    await settle();

    expect(offlineCalls).toEqual([]);
    // 여전히 코드 화면이고, 이유가 적혀 있다.
    expect(root.querySelector(".form__input--code")).not.toBeNull();
    expect(root.textContent ?? "").toMatch(/6|six/);
  });

  /** v1 QR 은 예전 경로 그대로여야 한다. */
  it("v1 QR은 코드를 묻지 않고 노트북에 붙는다", async () => {
    const root = await openPairing();
    const area = root.querySelector("textarea");
    if (!area) throw new Error("no textarea");
    area.value = "hmux-pair:1?a=192.0.2.10&p=47821&t=abc&k=ssh-ed25519&f=x&e=1";
    pick(root, ".paste__submit").click();
    await settle();

    expect(invocations.find((entry) => entry.command === "pair_from_scan")).toBeDefined();
    expect(offlineCalls).toEqual([]);
  });
});

/**
 * 페어링한 컴퓨터(허브) 경로.
 *
 * 이 배선이 없던 동안 Rust 는 붙는 데 성공한 컴퓨터를 저장하고 있었는데 화면이
 * 그것을 읽지 않아서, 사용자는 앱을 켤 때마다 책상으로 돌아가 QR 을 다시
 * 스캔했다 — 그리고 그 사실은 코드 어디에도 드러나지 않았다. 여기 시험들이
 * 고정하는 것이 그 한 줄이다.
 */
describe("페어링한 컴퓨터", () => {
  beforeEach(() => {
    invocations.length = 0;
    refuseWritableAttach = false;
    censusReports = [];
    vi.resetModules();
  });

  it("앱을 켜면 저장된 컴퓨터의 세션이 재스캔 없이 뜬다", async () => {
    hubRows = [hubRow()];

    const root = await launch();

    expect(invocations.map((entry) => entry.command)).toContain("hub_list");
    const text = root.textContent ?? "";
    expect(text).toContain("배선");
  });

  it("연결 경로와 무관하게 컴퓨터 선택 줄을 만들지 않는다", async () => {
    hubRows = [{ ...hubRow(), relay_offered: false }];

    const root = await launch();

    expect(root.querySelector(".card__row")).toBeNull();
    expect(root.textContent ?? "").toContain("배선");
  });

  it("컴퓨터를 고르지 않아도 통합 목록을 자동으로 갱신한다", async () => {
    hubRows = [hubRow()];
    const root = await launch();

    const commands = invocations.map((entry) => entry.command);
    expect(commands).toContain("hub_open");
    expect(commands).not.toContain("hub_probe");
    expect(root.textContent ?? "").toContain("배선");
  });

  it("살아 있는 허브 세션을 누르면 터미널을 연다", async () => {
    hubRows = [hubRow()];
    const root = await launch();

    const rows = [...root.querySelectorAll<HTMLButtonElement>(".list__open")];
    const live = rows.find((row) => row.textContent?.includes("배선"));
    const done = rows.find((row) => row.textContent?.includes("끝난 것"));
    expect(live?.disabled).toBe(false);
    expect(done?.disabled).toBe(true);

    live?.click();
    await settle();

    const opened = invocations.find((entry) => entry.command === "attach_hub_session");
    expect(opened).toBeDefined();
    if (!opened) throw new Error("attach_hub_session was not invoked");
    expect(opened.args.hubId).toBe(HUB_ID);
    expect(opened.args.boxId).toBe("this-laptop");
    expect((opened.args.session as { session_id?: string }).session_id).toBe("hub-live");
    expect(root.querySelector(".terminal")).not.toBeNull();
    await vi.waitFor(() => expect(root.textContent).toContain("ready"));

    const input = terminalInput(root);
    input.value = "pwd";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(sentInputIntents()).toContainEqual(
      expect.objectContaining({ case: "text", text: "pwd" }),
    );
  });

  /**
   * 스캔의 결과는 목록이지 문장이 아니다. 배너만 띄우고 페어링 화면에 남으면,
   * 방금 받아 온 목록을 보려고 사용자가 뒤로 나가서 다시 눌러야 한다.
   */
  it("허브 QR 한 번으로 허브와 직접 SSH 세션을 같은 목록에 연다", async () => {
    pushSupported = true;
    notificationPermission = "granted";
    const root = await openPairing();
    const area = root.querySelector("textarea");
    if (!area) throw new Error("no textarea");
    // 스캔 직후의 저장을 흉내낸다: Rust 는 붙은 뒤에 저장하므로, 이 시점의
    // `hub_list` 에는 그 컴퓨터가 들어 있다.
    hubRows = [hubRow()];
    hubLayouts = {};
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
    area.value = "dure-hub:3.eyJib3hfbGFiZWwiOiLrp6Xrtoף";
    pick(root, ".paste__submit").click();
    await settle();

    // The fingerprint is shown first; connecting is what the button does.
    const pushCallsBefore = invocations.filter((call) => call.command === "sync_push_notifications").length;
    pick(root, ".confirm__connect").click();
    await settle();

    expect(invocations.map((entry) => entry.command)).toContain("hub_probe");
    expect(root.textContent ?? "").toContain("배선");
    expect(root.textContent ?? "").toContain("lab");
    const probe = invocations.find((entry) => entry.command === "hub_probe");
    expect(probe?.args.deviceLabel).toBe(t("내 폰"));
    expect(invocations.filter((call) => call.command === "sync_push_notifications")).toHaveLength(pushCallsBefore + 1);
  });

  /**
   * There is no certificate authority on this path, so the whole of trust is
   * one comparison at the desk. If the connection happens before the person
   * has seen the fingerprint, that comparison protects nothing — it is being
   * asked to approve something already done.
   */
  it("붙기 전에 지문을 보여주고, 취소해도 붙지 않는다", async () => {
    const root = await openPairing();
    const area = root.querySelector("textarea");
    if (!area) throw new Error("no textarea");
    area.value = "dure-hub:3.eyJib3hfbGFiZWwiOiLrp6Xrtoף";
    pick(root, ".paste__submit").click();
    await settle();

    expect(root.textContent ?? "").toContain(HUB_ID);
    expect(invocations.map((entry) => entry.command)).not.toContain("hub_probe");

    pick(root, ".confirm__cancel").click();
    await settle();

    // Still not connected, and the pasted code is still there — a fingerprint
    // that did not match is a reason to look again, not to retype.
    expect(invocations.map((entry) => entry.command)).not.toContain("hub_probe");
    expect(root.querySelector<HTMLTextAreaElement>(".paste__payload")?.value).toBe(
      "dure-hub:3.eyJib3hfbGFiZWwiOiLrp6Xrtoף",
    );
  });

  it("기기 초기화는 확인 뒤 모든 로컬 연결을 지운다", async () => {
    hubRows = [hubRow()];
    const root = await launch();
    pick(root, ".home__settings").click();
    await settle();

    settingsRow(root, "reset").click();
    await settle();
    expect(root.querySelector('[role="alertdialog"]')?.textContent).toContain("2");

    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    expect(invocations.map((entry) => entry.command)).toContain("reset_device");
    expect(root.querySelector(".first-run")).not.toBeNull();
  });

  /** The four localStorage stores this app owns, seeded as the app itself writes them. */
  function seedLocalStores(): void {
    saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, fontSize: 15, language: "ko" });
    localStorage.setItem(
      "hebbian.commands.v1",
      JSON.stringify([{ text: "export TOKEN=abc", sentAtUnixMs: 1 }]),
    );
    localStorage.setItem(
      "hebbian.recents.v1",
      JSON.stringify([
        {
          serverId: "srv",
          serverLabel: "Loopback lab",
          sessionId: "s1",
          title: "t",
          visitedAtUnixMs: 1,
        },
      ]),
    );
    // The full group shape: a `{ keyIds }`-only value fails `isGroup` and would
    // never exercise the in-memory tray reset.
    localStorage.setItem(
      "hebbian.keytray.v1",
      JSON.stringify({ id: "default", name: "기본", keyIds: ["esc"] }),
    );
  }
  const LOCAL_STORE_KEYS = [
    "hebbian.settings.v1",
    "hebbian.commands.v1",
    "hebbian.recents.v1",
    "hebbian.keytray.v1",
  ];

  /**
   * "Reset" that keeps the font size, the language and a command line holding a
   * token is a reset that kept the things a person handing the phone on would
   * least want kept. The Rust side forgets hosts and keys; this phone forgets
   * everything else in the same step.
   */
  it("기기 초기화는 명령 기록·재개·키 스트립·설정도 지운다", async () => {
    seedLocalStores();
    hubRows = [hubRow()];
    const root = await launch();
    expect(document.documentElement.lang).toBe("ko");
    pick(root, ".home__settings").click();
    await settle();

    settingsRow(root, "reset").click();
    await settle();
    expect(root.querySelector('[role="alertdialog"]')?.textContent).toContain(
      t("호스트 {count}개, 기기 키, 명령 기록과 설정이 삭제됩니다. 되돌릴 수 없습니다.", { count: 2 }),
    );

    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    expect(root.querySelector(".first-run")).not.toBeNull();
    for (const key of LOCAL_STORE_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(loadSettingsPreferences()).toEqual(DEFAULT_SETTINGS_PREFERENCES);
    expect(document.documentElement.lang).toBe("en");
  });

  /** A failed reset leaves the phone exactly as it was — nothing half-forgotten. */
  it("초기화가 실패하면 로컬 기록은 남는다", async () => {
    seedLocalStores();
    failReset = true;
    const root = await launch();
    pick(root, ".home__settings").click();
    settingsRow(root, "reset").click();
    await settle();
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    for (const key of LOCAL_STORE_KEYS) expect(localStorage.getItem(key)).not.toBeNull();
    expect(root.querySelector(".toast--destructive")).not.toBeNull();
    expect(document.activeElement).toBe(settingsRow(root, "reset"));
  });

  it("설정에서 최근 명령을 지우면 서랍과 저장소에서 사라진다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
    let root = await openTerminal();
    const box = root.querySelector<HTMLTextAreaElement>(".tray__box");
    if (!box) throw new Error("no input");
    box.value = "git status";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    pressReturn(box);
    await settle();
    pick(root, ".session__header .icon-tap").click();
    await settle();

    pick(root, ".home__settings").click();
    await settle();
    const row = settingsRow(root, "clear-commands");
    expect(row.querySelector(".settings__row-detail")?.textContent).toBe(
      t("명령 {count}개", { count: 1 }),
    );
    row.click();
    await settle();
    expect(root.querySelector('[role="alertdialog"]')?.textContent).toContain("1");
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    expect(localStorage.getItem("hebbian.commands.v1")).toBeNull();
    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(document.activeElement).toBe(settingsRow(root, "clear-commands"));
    expect(settingsRow(root, "clear-commands").querySelector(".settings__row-detail")?.textContent).toBe(
      t("명령 {count}개", { count: 0 }),
    );

    root = await openTerminal();
    pick(root, ".tray__toggle--history").click();
    await settle();
    expect(root.querySelector(".history-item__text")).toBeNull();
    expect(root.textContent).toContain(t("이 폰에서 보낸 명령이 아직 없습니다"));
  });

  it("초기화 대화상자 안에서 포커스를 지키고 취소 뒤 호출 버튼으로 돌린다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    settingsRow(root, "reset").click();
    await settle();

    const dialog = pick(root, ".confirm-dialog");
    const cancel = pick(root, ".confirm-dialog__button:not(.confirm-dialog__button--confirm)");
    const confirm = pick(root, ".confirm-dialog__button--confirm");
    expect(document.activeElement).toBe(cancel);

    confirm.focus();
    confirm.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(cancel);
    cancel.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(confirm);

    dialog.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(document.activeElement).toBe(settingsRow(root, "reset"));
  });

  it("초기화 실패 뒤에도 호출 버튼으로 포커스를 돌린다", async () => {
    failReset = true;
    const root = await launch();
    pick(root, ".home__settings").click();
    settingsRow(root, "reset").click();
    await settle();
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(document.activeElement).toBe(settingsRow(root, "reset"));
  });

  it("초기화 전에 시작한 목록 읽기가 지운 호스트를 되살리지 않는다", async () => {
    hubRows = [hubRow()];
    holdServerList = true;
    const root = await launch();
    pick(root, ".home__settings").click();
    settingsRow(root, "reset").click();
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    releaseServerList?.();
    await settle();

    expect(root.querySelector(".first-run")).not.toBeNull();
    expect(root.textContent).not.toContain("Loopback lab");
  });

  it.each(["save", "delete"] as const)(
    "초기화 전에 시작한 호스트 %s 응답이 초기화 화면을 덮지 않는다",
    async (operation) => {
      const root = await launch();
      pick(root, ".home__settings").click();
      pick(root, ".settings__host").click();
      pick(root, ".host-settings__list-row").click();
      await settle();

      holdServerMutation = operation;
      if (operation === "save") {
        const port = root.querySelector<HTMLInputElement>('[name="port"]');
        if (!port) throw new Error("host port input missing");
        port.value = "2222";
        port.dispatchEvent(new Event("input", { bubbles: true }));
        pick(root, ".host-settings__save").click();
      } else {
        // The fixture is paired, so the remove asks first; the race is only
        // exercised once the confirm has actually started the delete.
        pick(root, ".host-settings__remove").click();
        pick(root, ".confirm-dialog__button--confirm").click();
      }

      pick(root, ".host-settings .icon-tap").click();
      pick(root, ".host-settings .icon-tap").click();
      settingsRow(root, "reset").click();
      pick(root, ".confirm-dialog__button--confirm").click();
      await settle();

      releaseServerMutation?.();
      await settle();

      expect(root.querySelector(".first-run")).not.toBeNull();
      expect(root.textContent).not.toContain("Loopback lab");
    },
  );
});

/**
 * 추가 시트 — Figma 3096:86354.
 *
 * FAB 이 글자를 잃고 시트를 여는 버튼이 됐다. 그 시트가 여는 두 곳은 둘 다 이미
 * 있던 화면이다: 새 에이전트는 FAB 이 바로 열던 곳이고, SSH 호스트 추가는 설정
 * 안에 숨어 있던 폼이다. 새로 생긴 것은 능력이 아니라, 둘이 같은 자리에서
 * 제안된다는 사실이다.
 */
describe("추가 시트", () => {
  beforeEach(() => {
    invocations.length = 0;
    censusReports = [];
  });

  it("FAB 은 글자 없이 이름만 가지고, 시트를 연다", async () => {
    hubRows = [hubRow()];
    const root = await launch();

    const fab = pick(root, ".fab");
    expect(fab.textContent).toBe("");
    expect(fab.getAttribute("aria-label")).toBe(t("새로 만들기"));
    expect(root.querySelector(".sheet--add")).toBeNull();

    fab.click();
    await settle();

    expect(root.querySelector(".sheet--add")).not.toBeNull();
    const names = [...root.querySelectorAll(".add-sheet__name")].map((node) => node.textContent);
    expect(names).toEqual([t("새 에이전트"), t("SSH 호스트 추가")]);
  });

  /** 시안의 요점: 아래 목록이 계속 보인다. 무엇에 더하는지가 그 목록이다. */
  it("시트 아래로 세션 목록이 계속 보이고, 바깥을 누르면 닫힌다", async () => {
    hubRows = [hubRow()];
    const root = await launch();
    pick(root, ".fab").click();
    await settle();

    expect(root.querySelector(".home")).not.toBeNull();
    expect(root.querySelectorAll(".list__open").length).toBeGreaterThan(0);

    root.querySelector<HTMLElement>(".sheet--add")?.click();
    await settle();

    expect(root.querySelector(".sheet--add")).toBeNull();
  });

  it("새 에이전트는 노트북에게 무엇을 띄울 수 있는지 묻는다", async () => {
    hubRows = [hubRow()];
    const root = await launch();
    pick(root, ".fab").click();
    await settle();
    pick(root, ".add-sheet__row").click();
    await settle();

    expect(root.querySelector(".sheet--add")).toBeNull();
    expect(root.querySelector(".launch")).not.toBeNull();
    expect(invocations.map((entry) => entry.command)).toContain("hub_launch_offer");
  });

  /**
   * 브랜치 이름을 한 글자 칠 때마다 화면을 다시 그리면 입력 칸이 새 노드가 되고,
   * 폰에서는 포커스가 날아가며 키보드가 닫힌다(2026-09-04 사용자 보고). 같은
   * 노드가 살아 있는지로 확인한다 — 포커스는 jsdom 에서 믿을 값이 아니다.
   */
  it("브랜치를 치는 동안 입력 칸이 새로 그려지지 않는다", async () => {
    hubRows = [hubRow()];
    const root = await launch();
    pick(root, ".fab").click();
    await settle();
    pick(root, ".add-sheet__row").click();
    await settle();
    // 제안이 도착해야 폼이 그려진다.
    await settle();

    const input = root.querySelector<HTMLInputElement>(".launch-branch");
    if (!input) throw new Error(`no branch input: ${root.querySelector(".launch")?.className}`);
    input.value = "agent/pairing";
    input.dispatchEvent(new Event("input"));
    await settle();

    expect(root.querySelector(".launch-branch")).toBe(input);
    // 값은 상태에 적혔다 — 시작이 그 이름으로 나가야 한다.
    pick(root, ".launch__start").click();
    await settle();
    const started = invocations.find((entry) => entry.command === "hub_start_agent");
    expect(
      (started?.args.input as { branch?: string } | undefined)?.branch,
    ).toBe("agent/pairing");
  });

  it.each(["unchanged", "branch", "worktree"] as const)(
    "retries an uncertain launch with the correct identity after %s edits",
    async (change) => {
      hubRows = [hubRow()];
      const root = await launch();
      pick(root, ".fab").click();
      await settle();
      pick(root, ".add-sheet__row").click();
      await settle();
      await settle();
      const branch = root.querySelector<HTMLInputElement>(".launch-branch");
      if (!branch) throw new Error("launch branch input is missing");
      branch.value = "agent/first";
      branch.dispatchEvent(new Event("input"));
      rejectNextHubStart = true;
      pick(root, ".launch__start").click();
      await settle();
      expect(root.querySelector(".toast--destructive")?.textContent).toContain("response lost");
      if (change === "branch") {
        const next = root.querySelector<HTMLInputElement>(".launch-branch");
        if (!next) throw new Error("retry branch input is missing");
        next.value = "agent/second";
        next.dispatchEvent(new Event("input"));
      } else if (change === "worktree") {
        pick(root, ".launch-switch").click();
        await settle();
      }
      pick(root, ".launch__start").click();
      const retryBanner = root.querySelector(".toast--destructive");
      await settle();
      const calls = invocations.filter((entry) => entry.command === "hub_start_agent");
      expect(calls).toHaveLength(2);
      const first = calls[0]?.args.input as { actionId: string };
      const second = calls[1]?.args.input as {
        actionId: string;
        useWorktree: boolean;
        branch: string | null;
      };
      if (change === "unchanged") expect(second.actionId).toBe(first.actionId);
      else expect(second.actionId).not.toBe(first.actionId);
      expect(second.useWorktree).toBe(change !== "worktree");
      expect(second.branch).toBe(
        change === "worktree" ? null : `agent/${change === "branch" ? "second" : "first"}`,
      );
      expect(root.querySelector(".launch-outcome--ok")).not.toBeNull();
      expect(root.querySelector(".toast--destructive")).toBeNull();
      expect(retryBanner).toBeNull();
    },
  );

  it("다른 폴더를 만들고 고르면 그 경로로 에이전트를 시작한다", async () => {
    hubRows = [hubRow()];
    const root = await launch();
    pick(root, ".fab").click();
    await settle();
    pick(root, ".add-sheet__row").click();
    await settle();
    await settle();

    root.querySelectorAll<HTMLButtonElement>(".launch-field__row")[1]?.click();
    await settle();
    pick(root, ".launch-menu__add").click();
    await settle();
    await settle();

    expect(root.querySelector(".folder-browser")).not.toBeNull();
    expect(invocations.map((entry) => entry.command)).toContain("hub_browse_folder");
    pick(root, ".folder-browser__add").click();
    await settle();
    const input = root.querySelector<HTMLInputElement>(".folder-create__input");
    if (!input) throw new Error("new-folder input is missing");
    input.value = "feature";
    input.dispatchEvent(new Event("input"));
    await settle();
    expect(root.querySelector(".folder-create__input")).toBe(input);
    pick(root, ".folder-create__button--primary").click();
    await settle();

    pick(root, ".folder-browser__choose").click();
    await settle();
    expect(root.querySelector(".launch-field__meta")?.textContent).toContain(
      "~/feature",
    );

    const branch = root.querySelector<HTMLInputElement>(".launch-branch");
    if (!branch) throw new Error("launch branch input is missing");
    branch.value = "agent/new-folder";
    branch.dispatchEvent(new Event("input"));
    pick(root, ".launch__start").click();
    await settle();
    const started = [...invocations].reverse().find((entry) => entry.command === "hub_start_agent");
    expect((started?.args.input as { folderPath?: string } | undefined)?.folderPath).toBe(
      "/Users/me/feature",
    );
  });

  it.each(["aws", "tailscale"])(
    "refreshes an initially empty catalog and opens the started %s session on its actual host",
    async (host) => {
      hubRows = [hubRow()];
      hubCatalogSessions = [];
      const session = {
        ...remoteSession(),
        session_id: `started-${host}`,
        box_id: `host-${host}`,
        box_label: host,
      };
      hubStartedSessionId = session.session_id;
      hubLaunchOffer = {
        published: true,
        targets: [{ id: `target-${host}`, space_label: "Main", folder_label: "remote", box_label: host,
          path_hint: "/tmp/qa", startable: true, worktree_supported: false, provider_installation: "check_on_start" }],
        kinds: [{ id: "codex", label: "Codex", installed: false }],
      };
      const root = await launch();
      expect(root.querySelector(".list__open")).toBeNull();
      pick(root, ".fab").click();
      await settle();
      pick(root, ".add-sheet__row").click();
      await settle();
      await settle();
      expect(pick(root, ".launch__start").disabled).toBe(true);
      pick(root, ".launch-switch").click();
      await settle();
      expect(pick(root, ".launch__start").disabled).toBe(false);
      pick(root, ".launch__start").click();
      await settle();
      const started = invocations.find((entry) => entry.command === "hub_start_agent");
      expect(started?.args.input).toMatchObject({ targetId: `target-${host}`, kindId: "codex", useWorktree: false, branch: null });

      hubCatalogSessions = [session];
      const beforeOpen = invocations.length;
      pick(root, ".launch-outcome .pair-button").click();
      await settle();
      await settle();
      const opened = invocations.slice(beforeOpen);
      const censusIndex = opened.findIndex((entry) => entry.command === "hub_open");
      const attachIndex = opened.findIndex((entry) => entry.command === "attach_hub_session");
      expect(censusIndex).toBeGreaterThanOrEqual(0);
      expect(attachIndex).toBeGreaterThan(censusIndex);
      expect(opened[attachIndex]?.args).toMatchObject({ hubId: HUB_ID, boxId: session.box_id, session });
      expect(root.querySelector(".terminal")).not.toBeNull();
    },
  );

  /**
   * 폼이지 설정 목록이 아니다. 그 줄이 약속하는 것은 "새 연결을 만듭니다" 이고,
   * 설정으로 보내면 약속한 것보다 한 번 더 누르게 한다.
   */
  it("SSH 호스트 추가는 새 연결 폼을 연다", async () => {
    hubRows = [hubRow()];
    const root = await launch();
    pick(root, ".fab").click();
    await settle();
    root.querySelectorAll<HTMLButtonElement>(".add-sheet__row")[1]?.click();
    await settle();

    expect(root.querySelector(".sheet--add")).toBeNull();
    expect(root.querySelector(".ssh-add")).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>(".ssh-add__input")?.value).toBe("");
  });

  /**
   * 폼에는 문이 둘이다 — 설정의 "직접 추가" 와 이 시트. 둘 다 설정으로 돌려보내면
   * 목록에서 온 사람이 열어 본 적 없는 화면에 떨어진다.
   */
  it("시트에서 연 폼은 취소하면 목록으로 돌아간다", async () => {
    hubRows = [hubRow()];
    const root = await launch();
    pick(root, ".fab").click();
    await settle();
    root.querySelectorAll<HTMLButtonElement>(".add-sheet__row")[1]?.click();
    await settle();

    pick(root, ".ssh-add .icon-tap").click();
    await settle();

    expect(root.querySelector(".home")).not.toBeNull();
    expect(root.querySelector(".ssh-add")).toBeNull();
  });
});

/**
 * SSH 호스트를 손으로 추가하는 화면. Figma 3177:82034, 닿지 못한 상태는
 * 3177:82150.
 */
describe("SSH 호스트 추가", () => {
  beforeEach(() => {
    invocations.length = 0;
    censusReports = [];
    sshHostDrafts.length = 0;
    sshHostUnreachable = false;
  });

  async function openAdd(): Promise<HTMLElement> {
    hubRows = [hubRow()];
    const root = await launch();
    pick(root, ".fab").click();
    await settle();
    root.querySelectorAll<HTMLButtonElement>(".add-sheet__row")[1]?.click();
    await settle();
    return root;
  }

  function fill(root: HTMLElement, values: readonly string[]): void {
    const inputs = [...root.querySelectorAll<HTMLInputElement>(".ssh-add__input")];
    values.forEach((value, index) => {
      const input = inputs[index];
      if (!input || value.length === 0) return;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /**
   * 지문 칸이 없는 것이 이 화면의 요점이다. 사람은 호스트 키 해시를 알 수 없고,
   * 그것을 묻던 예전 폼은 폰에서 채울 수 없었다 — 저장이 호스트에게 물어본다.
   */
  it("묻는 것은 넷뿐이고, 호스트 키는 묻지 않는다", async () => {
    const root = await openAdd();

    const labels = [...root.querySelectorAll(".ssh-add__label")].map((node) => node.textContent);
    expect(labels).toEqual([t("호스트"), t("포트"), t("사용자"), t("라벨 (선택)"), t("인증")]);
    expect(root.querySelectorAll(".ssh-add__input")).toHaveLength(4);
  });

  it("주소와 사용자가 차기 전에는 저장할 수 없다", async () => {
    const root = await openAdd();
    const save = () => pick(root, ".ssh-add__save") as HTMLButtonElement;

    expect(save().disabled).toBe(true);
    fill(root, ["100.64.0.1"]);
    await settle();
    expect(save().disabled).toBe(true);

    fill(root, ["", "", "kattpish"]);
    await settle();
    expect(save().disabled).toBe(false);
  });

  /**
   * 라벨은 선택이고, 비어 있으면 목록이 주소로 부른다. 포트도 마찬가지로 22.
   *
   * 이 기기 키로 저장하면 그 자리에서 공개 키 화면이 선다 — 호스트가 이 키를
   * 아직 모르고, 그 줄을 옮겨 적기 전에는 첫 연결이 될 수 없다. 토스트가 아닌
   * 화면인 이유: 줄은 복사하거나 읽어야 하고, 사라지는 것에서는 둘 다 못 한다.
   */
  it("이 기기 키로 저장하면 공개 키가 그 자리에 선다", async () => {
    const root = await openAdd();
    fill(root, ["100.64.0.1", "", "kattpish"]);
    await settle();
    pick(root, ".ssh-add__save").click();
    await settle();

    expect(sshHostDrafts).toEqual([
      {
        id: expect.any(String),
        label: "100.64.0.1",
        host: "100.64.0.1",
        port: 22,
        username: "kattpish",
        auth: { kind: "device" },
      },
    ]);
    expect(root.querySelector(".ssh-add__form")).toBeNull();
    expect(pick(root, ".host-keys__public-key").textContent).toBe(PUBLIC_KEY_LINE);
    const reads = invocations.filter((entry) => entry.command === "server_public_key");
    expect(reads).toEqual([{ command: "server_public_key", args: { id: sshHostDrafts[0]?.id } }]);
    expect(invocations.some((entry) => entry.command === "add_ssh_host")).toBe(true);
  });

  /** 비밀번호로 넣은 호스트는 그 자리에서 키를 심었다 — 보여 줄 줄이 없다. */
  it("비밀번호로 저장하면 그 상자가 폰의 목록에 서고 화면은 돌아간다", async () => {
    const root = await openAdd();
    fill(root, ["100.64.0.1", "", "kattpish"]);
    pick(root, ".ssh-add__choice--password").click();
    await settle();
    const password = pick(root, ".ssh-add__auth .ssh-add__input") as HTMLInputElement;
    password.value = "hunter2";
    password.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    pick(root, ".ssh-add__save").click();
    await settle();

    // 화면은 돌아가고, 그 상자는 이미 목록에 있다 — 저장이 끝났는데 목록이
    // 예전 것이면 방금 한 일이 되지 않은 것으로 보인다.
    expect(root.querySelector(".ssh-add")).toBeNull();
    expect(root.querySelector(".host-keys")).toBeNull();
    pick(root, ".census__settings, .home__settings, .fab") as HTMLElement;
    expect(invocations.some((entry) => entry.command === "server_public_key")).toBe(false);
  });

  it("복사를 누르면 그 줄이 클립보드에 들어간다", async () => {
    const root = await openAdd();
    fill(root, ["100.64.0.1", "", "kattpish"]);
    await settle();
    pick(root, ".ssh-add__save").click();
    await settle();

    pick(root, ".host-keys__copy").click();
    await settle();
    expect(copiedTexts).toEqual([PUBLIC_KEY_LINE]);
    expect(pick(root, ".host-keys__copy").textContent).toBe(t("복사됨"));
  });

  // The selectable `<pre>` is the fallback that always works; the banner says
  // to use it rather than pretending the copy happened.
  it("복사가 거부되면 길게 눌러 고르라고 말한다", async () => {
    failCopy = true;
    const root = await openAdd();
    fill(root, ["100.64.0.1", "", "kattpish"]);
    await settle();
    pick(root, ".ssh-add__save").click();
    await settle();

    pick(root, ".host-keys__copy").click();
    await settle();
    expect(pick(root, ".toast--destructive").textContent).toBe(
      t("복사하지 못했습니다 — 길게 눌러 선택하세요"),
    );
    expect(pick(root, ".host-keys__copy").textContent).toBe(t("복사"));
  });

  it("키 화면의 뒤로는 호스트 상세로 돌아가 접속을 확인한다", async () => {
    const root = await openAdd();
    fill(root, ["100.64.0.1", "", "kattpish"]);
    await settle();
    pick(root, ".ssh-add__save").click();
    await settle();

    pick(root, ".host-keys .icon-tap").click();
    await settle();
    expect(root.querySelector(".host-settings__status")).not.toBeNull();
    expect(invocations.filter((entry) => entry.command === "discover_sessions")).toHaveLength(1);
  });

  /**
   * The home sheet's door exists so the person never lands in 설정. That has
   * to hold through the public-key screen too: key → detail → home, the way
   * the add started.
   */
  it("홈에서 추가한 호스트는 공개 키와 상세를 지나 홈으로 돌아간다", async () => {
    const root = await openAdd();
    fill(root, ["100.64.0.1", "", "kattpish"]);
    await settle();
    pick(root, ".ssh-add__save").click();
    await settle();
    expect(root.querySelector(".host-keys")).not.toBeNull();

    pick(root, ".host-keys .icon-tap").click();
    await settle();
    expect(root.querySelector(".host-settings__status")).not.toBeNull();

    pick(root, ".host-settings .icon-tap").click();
    await settle();
    expect(root.querySelector(".home")).not.toBeNull();
    expect(root.querySelector(".host-settings")).toBeNull();
  });

  /**
   * 세 가지 방법은 한 줄의 선택이고, 그 아래에 오는 것은 **고른 그것**에 대한
   * 것뿐이다. 비밀번호는 이 기기의 키를 호스트에 등록하는 데 한 번 쓰이고
   * 저장되지 않는다 — 그래서 화면이 그렇게 적는다.
   */
  it("인증은 세 가지 중 하나를 고르는 것이다", async () => {
    const root = await openAdd();
    const choices = () => [...root.querySelectorAll<HTMLButtonElement>(".ssh-add__choice")];

    expect(choices().map((button) => button.textContent)).toEqual([
      t("이 기기 키"),
      t("비밀번호"),
      t("키 가져오기"),
    ]);
    expect(choices()[0]?.getAttribute("aria-checked")).toBe("true");
    // 이 기기 키일 때만 그 키와 그 안내문이 선다.
    expect(root.querySelector(".ssh-add__key")).not.toBeNull();

    pick(root, ".ssh-add__choice--password").click();
    await settle();

    expect(pick(root, ".ssh-add__choice--password").getAttribute("aria-checked")).toBe("true");
    expect(root.querySelector(".ssh-add__key")).toBeNull();
    expect(root.querySelector<HTMLInputElement>(".ssh-add__auth .ssh-add__input")?.type).toBe(
      "password",
    );
  });

  /** 빈 비밀번호는 비밀번호로 나간다. 고른 방법도 차 있어야 저장할 수 있다. */
  it("비밀번호를 고르면 그것까지 차야 저장할 수 있다", async () => {
    const root = await openAdd();
    fill(root, ["100.64.0.1", "", "kattpish"]);
    await settle();
    expect((pick(root, ".ssh-add__save") as HTMLButtonElement).disabled).toBe(false);

    pick(root, ".ssh-add__choice--password").click();
    await settle();
    expect((pick(root, ".ssh-add__save") as HTMLButtonElement).disabled).toBe(true);

    const password = pick(root, ".ssh-add__auth .ssh-add__input") as HTMLInputElement;
    password.value = "hunter2";
    password.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect((pick(root, ".ssh-add__save") as HTMLButtonElement).disabled).toBe(false);

    pick(root, ".ssh-add__save").click();
    await settle();
    expect(sshHostDrafts[0]?.auth).toEqual({ kind: "password", password: "hunter2" });
  });

  /**
   * 닿지 못한 것은 이 시도에 대한 사실이므로, 화면 위 배너가 아니라 폼 아래
   * 카드로 남는다 — 고칠 곳이 그 위의 칸이거나 호스트 자신이다(3177:82150).
   */
  it("닿지 못하면 폼 위에 남아 그 자리에 이유를 그린다", async () => {
    sshHostUnreachable = true;
    const root = await openAdd();
    fill(root, ["mac-mini", "22", "kattpish", "mac-mini"]);
    await settle();
    pick(root, ".ssh-add__save").click();
    await settle();

    expect(root.querySelector(".ssh-add")).not.toBeNull();
    expect(pick(root, ".ssh-add__failure-title").textContent).toBe(
      t("{label}에 연결할 수 없음 — 포트 {port} 응답 없음", { label: "mac-mini", port: "22" }),
    );
    // 다시 누를 수 있어야 한다 — 호스트를 켜고 오는 것이 흔한 고침이다.
    expect((pick(root, ".ssh-add__save") as HTMLButtonElement).disabled).toBe(false);

    // 칸을 고치면 그 카드는 방금 고친 주소에 대한 말이 아니게 된다.
    fill(root, ["mac-studio"]);
    await settle();
    expect(root.querySelector(".ssh-add__failure")).toBeNull();
  });
});

/**
 * 늦게 도착한 답이 화면을 빼앗지 않는다.
 *
 * `hub_open` 은 최악의 경우 12초가 걸린다 — 직결 마감 2초에 릴레이 페어링 대기
 * 10초. 그 사이 사용자가 뒤로 나갔는데 앞선 답이 화면을 갈아끼우면, 폰이
 * 제멋대로 움직이는 것으로 보인다.
 */
describe("느린 컴퓨터 연결", () => {
  beforeEach(() => {
    invocations.length = 0;
    censusReports = [];
    vi.resetModules();
  });

  it("늦은 컴퓨터 답도 허브 선택 화면을 만들지 않는다", async () => {
    hubRows = [hubRow()];
    holdHubOpen = true;
    const root = await launch();
    expect(root.querySelector(".card__row")).toBeNull();
    expect(root.textContent ?? "").not.toContain("배선");

    releaseHubOpen?.();
    await settle();

    expect(root.textContent ?? "").toContain("배선");
    expect(root.querySelector(".card__row")).toBeNull();
  });
});

/**
 * 세션 화면이 사용자가 노트북에서 만든 데스크탑으로 선다.
 *
 * 이 배선이 끊기는 방식은 조용하다 — 표는 멀쩡히 만들어지고 화면은 예전처럼
 * 한 줄씩 그린다. 그래서 순수 함수 시험만으로는 잡히지 않는다.
 */
describe("세션 화면의 데스크탑 묶음", () => {
  const WORKSPACE = "Workspace";
  const ONCHAIN = "Onchain";

  function pairedLaptop(): void {
    hubRows = [hubRow()];
    hubLayouts = {
      [HUB_ID]: {
        placements: {
          "hub-live": { desktop: WORKSPACE, project: "agent-ide", order: 0 },
          [SESSION_ID]: { desktop: ONCHAIN, project: "Gate1", order: 0 },
        },
        desktop_order: [WORKSPACE, ONCHAIN],
      },
    };
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];
  }

  it("두 경로의 세션을 사용자가 만든 데스크탑 탭 아래에 세운다", async () => {
    pairedLaptop();

    const root = await openAllSessions();

    const tabs = [...root.querySelectorAll(".tab")].map((node) => node.textContent);
    expect(tabs).toEqual([WORKSPACE, ONCHAIN]);
    // 첫 탭은 노트북 로컬 세션(허브)이 앉은 데스크탑이다.
    expect(root.textContent).toContain("배선");

    // 서버 세션(SSH)은 다른 데스크탑에 있고, 그 탭을 누르면 나온다.
    const onchain = [...root.querySelectorAll<HTMLButtonElement>(".tab")].find(
      (tab) => tab.textContent === ONCHAIN,
    );
    onchain?.click();
    await settle();

    expect(root.textContent).toContain("lab");
  });

  it("노트북 세션 줄도 같은 화면에서 열린다", async () => {
    pairedLaptop();

    const root = await openAllSessions();

    const rows = [...root.querySelectorAll<HTMLButtonElement>(".list__open")];
    const laptop = rows.find((row) => row.textContent?.includes("배선"));
    expect(laptop?.disabled).toBe(false);

    laptop?.click();
    await settle();
    expect(invocations.map((entry) => entry.command)).toContain("attach_hub_session");
    expect(root.querySelector(".terminal")).not.toBeNull();
  });

  /**
   * 길게 누르면 뜨는 메뉴는 인구조사가 도는 동안에도 서 있어야 한다.
   *
   * `render()` 는 트리를 통째로 갈아치우고 인구조사 한 번이 그것을 여러 번 한다.
   * 메뉴가 눌린 **노드**를 들고 있었다면 그 사이에 사라진다 — 그래서 상태가 들고
   * 있는 것은 세션 id 와 눌린 순간의 사각형뿐이고, 이 시험이 그것을 고정한다.
   */
  it("길게 누른 메뉴는 인구조사가 지나가도 서 있는다", async () => {
    pairedLaptop();
    const root = await openAllSessions();

    const row = [...root.querySelectorAll<HTMLButtonElement>(".list__open")].find((node) =>
      node.textContent?.includes("배선"),
    );
    await holdRow(row);
    await settle();
    expect(root.querySelector(".row-menu")).not.toBeNull();

    await pullDown(root);
    expect(root.querySelector(".row-menu")).not.toBeNull();

    // 바깥을 누르면 닫힌다.
    root.querySelector<HTMLElement>(".row-menu")?.click();
    await settle();
    expect(root.querySelector(".row-menu")).toBeNull();
  });

  it("offers a menu only while the row's machine is reachable", async () => {
    pairedLaptop();
    const root = await openAllSessions();
    const labels = () =>
      [...root.querySelectorAll(".row-menu__label")].map((node) => node.textContent);

    await holdRow(
      [...root.querySelectorAll<HTMLButtonElement>(".list__open")].find((node) =>
        node.textContent?.includes("배선"),
      ),
    );
    await settle();
    expect(labels()).toEqual([t("세션 열기")]);

    root.querySelector<HTMLElement>(".row-menu")?.click();
    await settle();
    hubUnreachable = true;
    await pullDown(root);

    await holdRow(
      [...root.querySelectorAll<HTMLButtonElement>(".list__open")].find((node) =>
        node.textContent?.includes("배선"),
      ),
    );
    await settle();
    expect(labels()).toEqual([]);
  });

  it("opens a formerly offline session after a successful refresh", async () => {
    pairedLaptop();
    const root = await openAllSessions();
    hubUnreachable = true;
    await pullDown(root);

    const before = invocations.filter((entry) => entry.command === "attach_hub_session").length;
    hubUnreachable = false;
    await pullDown(root);
    const row = [...root.querySelectorAll<HTMLButtonElement>(".list__open")]
      .find((node) => node.textContent?.includes("배선"));
    expect(row?.disabled).toBe(false);
    row?.click();
    await settle();
    await settle();

    expect(invocations.filter((entry) => entry.command === "attach_hub_session")).toHaveLength(before + 1);
  });

  it("노트북이 중간에 꺼지면 로컬 줄만 비활성이고 SSH 줄은 계속 열린다", async () => {
    pairedLaptop();
    const root = await openAllSessions();
    hubUnreachable = true;
    // 홈에는 보이는 새로고침 버튼이 없다 — 목록을 끌어내리는 것이 다시 묻는
    // 길이다. 끌기를 쓸 수 없는 사람을 위한 같은 동작은 아래 시험이 잡는다.
    await pullDown(root);

    const tabs = [...root.querySelectorAll(".tab")].map((node) => node.textContent);
    expect(tabs).toEqual([WORKSPACE, ONCHAIN]);

    const local = [...root.querySelectorAll<HTMLButtonElement>(".list__open")].find((row) =>
      row.textContent?.includes("배선"),
    );
    expect(local?.disabled).toBe(true);
    expect(local?.textContent).not.toContain(t("컴퓨터가 꺼져 있어 로컬 세션에 닿을 수 없습니다"));
    expect(root.querySelector(".project--offline")).toBeNull();
    expect(root.querySelector(".project__state--retry")).toBeNull();

    local?.click();
    await settle();
    expect(root.querySelector(".toast")).toBeNull();
    expect(root.querySelector(".home__header")).not.toBeNull();

    // 다른 데스크탑의 SSH 줄은 노트북과 무관하게 계속 열린다.
    const onchain = [...root.querySelectorAll<HTMLButtonElement>(".tab")].find(
      (tab) => tab.textContent === ONCHAIN,
    );
    onchain?.click();
    await settle();
    const server = [...root.querySelectorAll<HTMLButtonElement>(".list__open")].find((row) =>
      row.textContent?.includes("lab"),
    );
    expect(server?.disabled).toBe(false);
  });

  /**
   * 2026-08-12 에 실제로 밟은 것. 사이드바가 빈 노트북에 붙으면 세션은 99개가
   * 오는데 자리는 0개다. 그때 "실행 중인 세션이 없습니다" 라고 쓰면 그건
   * 거짓말이고, 사용자는 에이전트가 전부 죽은 줄 안다.
   */
  it("세션은 있는데 전부 사이드바 밖이면 그렇다고 말한다", async () => {
    hubRows = [hubRow()];
    // 데스크탑은 있는데 아무 세션도 올려두지 않은 사이드바.
    hubLayouts = { [HUB_ID]: { placements: {}, desktop_order: ["Main"] } };
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];

    const root = await openAllSessions();

    expect(root.textContent).not.toContain(t("실행 중인 세션이 없습니다"));
    expect(root.textContent).toContain(
      t(
        "세션 {count}개가 모두 사이드바 밖에 있습니다 — 노트북 앱에서 데스크탑에 올려 둔 것이 여기 보입니다",
        {
          count: 3,
        },
      ),
    );
  });

  /**
   * 노트북을 한 번도 페어링하지 않은 사람에게는 데스크탑이라는 것이 없다. 그
   * 화면에서 묶음별로 그리려 들면 모든 줄이 자리 없음으로 떨어져 빈 화면이 된다.
   */
  it("묶음을 모르면 예전처럼 한 줄씩 그린다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "listed", sessions: [remoteSession()] },
      },
    ];

    const root = await openAllSessions();

    expect(root.querySelectorAll(".tab")).toHaveLength(0);
    expect(root.querySelectorAll(".project__header")).toHaveLength(0);
    expect(root.textContent).toContain("lab");
  });
});

/**
 * 설정 › 호스트 — 상세, 키 화면, 지문 없는 예전 항목, 페어링된 호스트의 제거.
 *
 * 호스트 상세는 저장된 상자 한 대에 대한 사실의 화면이고, 키 화면은 그 상자가
 * 신뢰해야 하는 공개 키와 이 폰이 들고 있는 개인키 슬롯이다. 둘 다 그 상자의
 * 저장된 키가 유일한 권위다 — 화면은 읽어서 보여 줄 뿐 두 번째 사본을 두지 않는다.
 */
describe("설정 › 호스트", () => {
  beforeEach(() => {
    invocations.length = 0;
    censusReports = [];
  });

  async function openDetail(): Promise<HTMLElement> {
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    pick(root, ".host-settings__list-row").click();
    await settle();
    return root;
  }

  it("호스트 상세에서 SSH 키 화면에 들어간다", async () => {
    const root = await openDetail();
    pick(root, ".host-settings__keys").click();
    await settle();

    expect(root.querySelector(".host-keys")).not.toBeNull();
    expect(pick(root, ".host-keys .banner--warn").textContent).toBe(
      t("개인키는 앱 저장소에 평문 파일로 저장됩니다. Secure Enclave/Keystore가 아닙니다."),
    );
    expect(root.querySelectorAll("textarea")).toHaveLength(2);
    expect(pick(root, ".host-keys__public-key").textContent).toBe(PUBLIC_KEY_LINE);
  });

  it("공개 키를 읽지 못하면 키 화면이 그 이유를 말한다", async () => {
    failPublicKey = true;
    const root = await openDetail();
    pick(root, ".host-settings__keys").click();
    await settle();

    expect(root.querySelector(".host-keys__public-key")).toBeNull();
    expect(pick(root, ".host-keys__public-key-failure").textContent).toContain("저장된 키가 없습니다");
  });

  it("붙여넣은 개인키를 그 서버의 연결용 슬롯에 저장한다", async () => {
    const privateKeyPem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
    const root = await openDetail();
    pick(root, ".host-settings__keys").click();
    await settle();

    const attach = root.querySelector<HTMLTextAreaElement>("textarea");
    if (!attach) throw new Error("no attach textarea");
    attach.value = privateKeyPem;
    attach.dispatchEvent(new Event("input", { bubbles: true }));
    pick(root, ".host-keys__save").click();
    await settle();

    expect(invocations).toContainEqual({
      command: "save_identity",
      args: { serverId: "lab", role: "attach", privateKeyPem },
    });
    expect(root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
    expect(root.querySelector(".host-keys__stored")?.textContent).toBe(
      t("등록됨 — 새로 붙여넣으면 대체됩니다"),
    );
  });

  /**
   * The line on screen is the public half of the key the phone dials with.
   * After a replacement is saved the old line — and its 복사됨 — must go: the
   * one the person pastes into authorized_keys next has to be the new key's.
   */
  it("연결용 키를 저장하면 공개 키를 다시 읽어 새 줄을 보여 준다", async () => {
    const root = await openDetail();
    pick(root, ".host-settings__keys").click();
    await settle();
    pick(root, ".host-keys__copy").click();
    await settle();
    expect(pick(root, ".host-keys__copy").textContent).toBe(t("복사됨"));

    const attach = root.querySelector<HTMLTextAreaElement>("textarea");
    if (!attach) throw new Error("no attach textarea");
    attach.value = "-----BEGIN OPENSSH PRIVATE KEY-----\nnew\n-----END OPENSSH PRIVATE KEY-----";
    attach.dispatchEvent(new Event("input", { bubbles: true }));
    pick(root, ".host-keys__save").click();
    await settle();

    const reads = invocations.filter((entry) => entry.command === "server_public_key");
    expect(reads).toHaveLength(2);
    expect(pick(root, ".host-keys__public-key").textContent).toBe(REPLACED_PUBLIC_KEY_LINE);
    expect(pick(root, ".host-keys__copy").textContent).toBe(t("복사"));
  });

  /**
   * A key picked from the system picker is a draft like a pasted one: it has
   * to land in the textarea and arm 키 저장, or the pick did nothing anybody
   * can see and the next keystroke silently replaces it.
   */
  it("키 파일을 고르면 그 키가 칸에 서고 저장할 수 있다", async () => {
    pickedPath = "/Users/me/.ssh/id_ed25519";
    const root = await openDetail();
    pick(root, ".host-settings__keys").click();
    await settle();
    expect((pick(root, ".host-keys__save") as HTMLButtonElement).disabled).toBe(true);

    pick(root, ".host-keys__pick").click();
    await settle();

    expect(invocations).toContainEqual({
      command: "read_ssh_private_key",
      args: { path: "/Users/me/.ssh/id_ed25519" },
    });
    expect(root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(PICKED_PRIVATE_KEY_PEM);
    expect((pick(root, ".host-keys__save") as HTMLButtonElement).disabled).toBe(false);

    pick(root, ".host-keys__save").click();
    await settle();
    expect(invocations).toContainEqual({
      command: "save_identity",
      args: { serverId: "lab", role: "attach", privateKeyPem: PICKED_PRIVATE_KEY_PEM },
    });
  });

  // The host check fired by the detail lands after the person has moved on to
  // the keys screen and started pasting. Its redraw must not eat the paste —
  // which is why the drafts live in state rather than in the textarea alone.
  it("확인 응답이 늦게 와도 붙여넣던 키는 남는다", async () => {
    holdServerDiscovery = true;
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    pick(root, ".host-settings__list-row").click();
    await settle();
    pick(root, ".host-settings__keys").click();
    await settle();

    const attach = root.querySelector<HTMLTextAreaElement>("textarea");
    if (!attach) throw new Error("no attach textarea");
    attach.value = "-----BEGIN OPENSSH";
    attach.dispatchEvent(new Event("input", { bubbles: true }));
    releaseServerDiscovery?.(false);
    await settle();

    expect(root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("-----BEGIN OPENSSH");
  });

  /**
   * A row without a pin came from a hand-edited file — the phone never writes
   * one. The screen says why it cannot connect, skips the 5 s retry loop that
   * would only ever fail, and still lets an edit through: refusing the save
   * would leave the entry in a state nothing can fix.
   */
  it("지문이 없는 예전 호스트도 저장되고 그 이유가 화면에 있다", async () => {
    serverRows = [serverRow({ host_key_fingerprint: "", paired: false })];
    const root = await openDetail();

    expect(pick(root, ".host-settings__status--unpinned").textContent).toBe(
      t("호스트 키 지문이 없어 연결할 수 없습니다"),
    );
    expect(root.querySelector(".host-settings__retry")).toBeNull();
    expect(invocations.some((entry) => entry.command === "discover_sessions")).toBe(false);

    const port = root.querySelector<HTMLInputElement>('[name="port"]');
    if (!port) throw new Error("host port input missing");
    port.value = "2222";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    pick(root, ".host-settings__save").click();
    await settle();

    const saved = invocations.find((entry) => entry.command === "save_server")?.args.entry as
      | ReturnType<typeof serverRow>
      | undefined;
    expect(saved?.id).toBe("lab");
    expect(saved?.port).toBe(2222);
    expect(saved?.host_key_fingerprint).toBe("");
  });

  it("모양이 틀린 지문은 배너로 말한다", async () => {
    serverRows = [serverRow({ host_key_fingerprint: "MD5:xx" })];
    const root = await openDetail();

    const port = root.querySelector<HTMLInputElement>('[name="port"]');
    if (!port) throw new Error("host port input missing");
    port.value = "2222";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    pick(root, ".host-settings__save").click();
    await settle();

    expect(pick(root, ".toast--destructive").textContent).toContain(
      t("지문은 SHA256:로 시작하는 값이어야 합니다"),
    );
    expect(invocations.some((entry) => entry.command === "save_server")).toBe(false);
  });

  it("페어링된 호스트 제거는 확인을 거친다", async () => {
    const root = await openDetail();
    pick(root, ".host-settings__remove").click();
    await settle();

    expect(root.querySelector(".confirm-dialog")).not.toBeNull();
    pick(root, ".confirm-dialog__button").click();
    await settle();
    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(root.querySelector(".host-settings__form")).not.toBeNull();
    expect(invocations.some((entry) => entry.command === "delete_server")).toBe(false);
    expect(document.activeElement?.classList.contains("host-settings__remove")).toBe(true);

    pick(root, ".host-settings__remove").click();
    await settle();
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();
    expect(invocations.some((entry) => entry.command === "delete_server")).toBe(true);
    expect(root.querySelector(".host-settings__body--list")).not.toBeNull();
  });

  it("페어링되지 않은 호스트는 바로 지운다", async () => {
    serverRows = [serverRow({ paired: false })];
    const root = await openDetail();
    pick(root, ".host-settings__remove").click();
    await settle();

    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(invocations.some((entry) => entry.command === "delete_server")).toBe(true);
  });

  it("기본 포트는 목록에서 :22 없이 보인다", async () => {
    serverRows = [serverRow({ port: 22 })];
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();

    expect(pick(root, ".host-settings__endpoint").textContent).toBe("kattpish@127.0.0.1");
    expect(root.textContent).not.toContain(":22");
  });

  it("설정 행의 요약은 호스트 수를 따라간다", async () => {
    // A computer keeps the home off the first-run screen with no hosts.
    hubRows = [hubRow()];
    serverRows = [];
    const none = await launch();
    pick(none, ".home__settings").click();
    expect(settingsRow(none, "hosts").querySelector(".settings__row-detail")?.textContent).toBe(
      t("연결 없음"),
    );

    serverRows = [serverRow(), serverRow({ id: "two", label: "Zwei", host: "10.0.0.2" })];
    const two = await launch();
    pick(two, ".home__settings").click();
    expect(settingsRow(two, "hosts").querySelector(".settings__row-detail")?.textContent).toBe(
      t("{host} 외 {count}", { host: "Loopback lab", count: 1 }),
    );
  });

  it("호스트 추가는 추가 화면을 열고 그 뒤로는 목록으로 돌아온다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();
    pick(root, ".host-settings__add").click();
    await settle();

    expect(root.querySelector(".ssh-add")).not.toBeNull();
    pick(root, ".ssh-add .icon-tap").click();
    await settle();
    expect(root.querySelector(".host-settings__body--list")).not.toBeNull();
  });

  it("답하지 못한 호스트는 목록에서 연결 안 됨을 단다", async () => {
    censusReports = [
      {
        server_id: "lab",
        server_label: "Loopback lab",
        outcome: { state: "unreachable", code: "x", detail: "y" },
      },
    ];
    const root = await launch();
    pick(root, ".home__settings").click();
    pick(root, ".settings__host").click();

    expect(root.querySelector(".host-settings__offline")).not.toBeNull();
  });
});

/**
 * 설정 › 컴퓨터 — 짝지은 컴퓨터를 이 폰에서 잊는다.
 *
 * 잊기는 이 폰의 줄과 그 컴퓨터가 준 묶음만 지운다. 그 컴퓨터가 넣어 준 SSH
 * 호스트는 남는다 — 서버 항목에는 어느 컴퓨터가 넣었는지가 없어서 골라 지울 수
 * 없고, 대화상자가 그 사실을 그대로 말한다. 해지는 노트북에서 한다.
 */
describe("설정 › 컴퓨터", () => {
  beforeEach(() => {
    invocations.length = 0;
    censusReports = [];
    hubRows = [
      hubRow(),
      { ...hubRow(), id: `${HUB_ID}-2`, box_label: "작업실", endpoint: "192.168.0.13:47821" },
    ];
  });

  async function openComputers(): Promise<HTMLElement> {
    const root = await launch();
    pick(root, ".home__settings").click();
    settingsRow(root, "computers").click();
    await settle();
    return root;
  }

  it("설정의 컴퓨터 행은 호스트 위에 서고 짝지은 컴퓨터를 요약한다", async () => {
    const root = await launch();
    pick(root, ".home__settings").click();

    const rows = [...root.querySelectorAll<HTMLElement>(".settings__row")].map(
      (row) => row.dataset.row,
    );
    expect(rows.indexOf("computers")).toBeLessThan(rows.indexOf("hosts"));
    expect(
      settingsRow(root, "computers").querySelector(".settings__row-detail")?.textContent,
    ).toBe(t("{host} 외 {count}", { host: "맥북", count: 1 }));
  });

  it("설정 › 컴퓨터의 잊기는 확인 뒤 hub_forget 을 부르고 그 컴퓨터만 지운다", async () => {
    const root = await openComputers();
    expect(root.querySelectorAll(".host-settings__forget")).toHaveLength(2);

    pick(root, ".host-settings__forget").click();
    await settle();
    const dialog = pick(root, '[role="alertdialog"]');
    expect(dialog.textContent).toContain("맥북");
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    const calls = invocations.map((entry) => entry.command);
    const forget = calls.indexOf("hub_forget");
    expect(invocations[forget]).toEqual({ command: "hub_forget", args: { id: HUB_ID } });
    expect(calls.indexOf("hub_list", forget)).toBeGreaterThan(forget);
    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(root.textContent).not.toContain("192.168.0.12:47821");
    expect(root.textContent).toContain("192.168.0.13:47821");
  });

  it("잊기를 취소하면 아무것도 부르지 않는다", async () => {
    const root = await openComputers();
    pick(root, ".host-settings__forget").click();
    await settle();
    pick(root, ".confirm-dialog__button").click();
    await settle();

    expect(root.querySelector(".confirm-dialog")).toBeNull();
    expect(invocations.some((entry) => entry.command === "hub_forget")).toBe(false);
    expect(root.querySelectorAll(".host-settings__forget")).toHaveLength(2);
    expect(document.activeElement?.classList.contains("host-settings__forget")).toBe(true);
  });

  // Focus returns to the 잊기 that opened the dialog — the second row's, when
  // that is the one pressed — not to whichever comes first in the list.
  it("두 번째 컴퓨터의 잊기를 취소하면 그 행의 잊기로 돌아간다", async () => {
    const root = await openComputers();
    const second = root.querySelectorAll<HTMLButtonElement>(".host-settings__forget")[1];
    if (!second) throw new Error("two forget buttons expected");
    second.click();
    await settle();
    pick(root, ".confirm-dialog__button").click();
    await settle();

    const buttons = [...root.querySelectorAll<HTMLButtonElement>(".host-settings__forget")];
    expect(buttons).toHaveLength(2);
    expect(document.activeElement).toBe(buttons[1]);
  });

  it("hub_forget 이 실패하면 컴퓨터가 남고 배너가 말한다", async () => {
    rejectHubForget = true;
    const root = await openComputers();
    pick(root, ".host-settings__forget").click();
    await settle();
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    expect(root.querySelectorAll(".host-settings__forget")).toHaveLength(2);
    expect(pick(root, ".toast--destructive").textContent).toContain("store locked");
  });

  it("마지막 컴퓨터를 잊으면 홈이 첫 화면으로 돌아간다", async () => {
    serverRows = [];
    hubRows = [hubRow()];
    const root = await openComputers();
    pick(root, ".host-settings__forget").click();
    await settle();
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    expect(root.textContent).toContain(t("짝지은 컴퓨터가 없습니다"));
    pick(root, ".host-settings .icon-tap").click();
    pick(root, ".settings .icon-tap").click();
    expect(root.querySelector(".first-run")).not.toBeNull();
  });

  // The census that was already asking that computer must not put its
  // sessions back when the answer lands — the forget bumps the epoch.
  it("인구조사가 도는 중에 잊은 컴퓨터는 답이 와도 돌아오지 않는다", async () => {
    hubRows = [hubRow()];
    holdHubOpen = true;
    const root = await openComputers();
    pick(root, ".host-settings__forget").click();
    await settle();
    pick(root, ".confirm-dialog__button--confirm").click();
    await settle();

    releaseHubOpen?.();
    await settle();
    pick(root, ".host-settings .icon-tap").click();
    pick(root, ".settings .icon-tap").click();
    expect(root.textContent).not.toContain("배선");
    expect(root.textContent).not.toContain("맥북");
  });
});

it("does not refresh the Home catalog or replace terminal input while the terminal is open", async () => {
  hubRows = [hubRow()];
  censusReports = [];
  refuseWritableAttach = false;
  const root = await openTerminal();
  const input = root.querySelector<HTMLTextAreaElement>(".tray__box");
  expect(input).not.toBeNull();
  if (!input) return;
  input.focus();
  const terminal = root.querySelector(".terminal");
  const before = invocations.filter((call) => call.command === "hub_open").length;
  vi.useFakeTimers();
  try {
    window.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invocations.filter((call) => call.command === "hub_open")).toHaveLength(before);
    expect(root.querySelector(".terminal")).toBe(terminal);
    expect(root.querySelector(".tray__box")).toBe(input);
    expect(document.activeElement).toBe(input);
  } finally {
    vi.useRealTimers();
  }
});

describe("watchingBecause", () => {
  /**
   * 이 문장은 세션 화면의 읽기 전용 줄에 들어간다. 원래 이 자리에는 위쪽
   * 빨간 배너로 `Hmux Host refused attach (ControllerConflict): …
   * (hmux_controller_conflict)` 가 그대로 떴다 — 세션은 **열렸는데** 열리지
   * 않은 것처럼 읽히고, 어휘도 이 앱의 것이 아니었다.
   */
  it("남이 잡고 있는 것과 보기 전용으로 짝지어진 것을 갈라 말한다", async () => {
    const { watchingBecause } = await import("./app");

    expect(
      watchingBecause(
        "Hmux Host refused attach (ControllerConflict): … (hmux_controller_conflict)",
      ),
    ).toBe("Watch-only — someone else is typing");

    expect(
      watchingBecause(
        "Hmux Host refused attach (AuthorizationDenied): … (hmux_authorization_denied)",
      ),
    ).toBe("Watch-only — this connection was paired for watching");
  });

  /** 모르는 코드는 지어내지 않고 원문을 남긴다. */
  it("모르는 거절은 원문을 들고 간다", async () => {
    const { watchingBecause } = await import("./app");

    expect(watchingBecause("Hmux Host refused attach (ReplayGap): … (hmux_replay_gap)")).toContain(
      "hmux_replay_gap",
    );
  });

  /** 이유를 모르면 아무 말도 만들지 않는다 — 그 줄은 역할만 말한다. */
  it("이유가 없으면 문장을 만들지 않는다", async () => {
    const { watchingBecause } = await import("./app");

    expect(watchingBecause(undefined)).toBeUndefined();
  });
});

describe("입장 모션 (#851)", () => {
  beforeAll(async () => { await import("./app"); });
  beforeEach(() => {
    hubRows = [hubRow()];
    censusReports = [];
  });

  it("a sheet enters with motion on the render it opens and stands still when rebuilt", async () => {
    const root = await launch();
    pick(root, ".home__view-options").click();
    await settle();
    const sheet = root.querySelector(".sheet");
    expect(sheet?.classList.contains("motion-enter")).toBe(true);

    // A row opens its card, and the render that follows rebuilds the tree
    // with the sheet still open: a new node, and no second entrance.
    pick(root, ".home-menu__row").click();
    await settle();
    const rebuilt = root.querySelector(".sheet");
    expect(rebuilt).not.toBeNull();
    expect(rebuilt).not.toBe(sheet);
    expect(rebuilt?.classList.contains("motion-enter")).toBe(false);
  });

  it("the view fades in only when the screen changes", async () => {
    const root = await launch();
    expect(root.querySelector(".view")?.classList.contains("motion-screen")).toBe(false);
    pick(root, ".list__open").click();
    await settle();
    expect(root.querySelector(".view")?.classList.contains("motion-screen")).toBe(true);
  });
});

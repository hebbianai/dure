import type { SessionPresentation } from "@/lib/hub/sessionPresentation";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { demoInvoke } from "./demo/demoInvoke";
import type { ServerReport } from "./census";
import type { ServerEntry } from "./servers";
import type { RemoteSession } from "./sessions";

export type SessionResolution =
  | { state: "resolved"; session: RemoteSession }
  | { state: "pending" | "unknown" };

/**
 * Demo builds answer every command from `demo/` instead of Rust.
 *
 * Chosen at build time (`VITE_DURE_DEMO=1`), never at runtime: a phone that
 * could flip into pretend data while paired would be a phone whose screens
 * can lie. Vite folds the condition, so the demo never ships in a real build.
 */
const invoke: typeof tauriInvoke =
  import.meta.env.VITE_DURE_DEMO === "1" ? demoInvoke : tauriInvoke;

/** Rust `CommandError`. */
export interface CommandError {
  code: string;
  message: string;
}

/** Rust `ServerRow` — 항목 + 키가 있는지 여부. 키 자체는 절대 넘어오지 않는다. */
export interface ServerRow extends ServerEntry {
  has_attach_key: boolean;
  has_list_key: boolean;
}

/**
 * Rust `RefusedHost` — 노트북이 이름을 부른, 이 기기가 쓸 수 없는 서버.
 *
 * 키 설치에 실패했거나, 설치는 됐지만 호스트 키 지문을 받지 못해 고정할 수 없는
 * 경우다. 목록에서 조용히 빼지 않는다 — 사라진 서버는 없는 서버로 읽히고,
 * 사용자가 책상까지 온 이유였던 그 기계가 바로 실패한 기계다.
 */
export interface RefusedHost {
  label: string;
  host: string;
  port: number;
  detail: string;
}

/** Rust `PairingOutcome`. */
export interface PairingOutcome {
  /** 노트북 쪽 기기 id. `hmux pair revoke`가 받는 값이라 화면에 보여준다. */
  device_id: string;
  adopted: ServerRow[];
  refused: RefusedHost[];
  key_algorithm: string;
}

/**
 * 저장된 컴퓨터 한 줄. `hub_list`가 돌려준다.
 *
 * **토큰도 지문도 없다.** 화면이 쓸 일이 없고, 나가지 않는 것이 나가는 것보다
 * 언제나 되돌리기 쉽다 — 붙는 데 필요한 값은 Rust 쪽 저장소에만 남는다.
 */
export interface HubRow {
  /** 인증서 지문이 곧 신원이다. 주소는 네트워크마다 달라진다. */
  id: string;
  box_label: string;
  endpoint: string;
  relay_offered: boolean;
}

/**
 * Rust `HubOfferPreview` — a scanned QR read **without connecting**.
 *
 * Carries no token. The confirm screen has no use for one, and what never
 * leaves is always easier to take back than what does.
 */
export interface HubOfferPreview {
  box_label: string;
  endpoint: string;
  /** `SHA256:` plus 43 characters. The screen never shortens it — a prefix
   *  would make the compared thing a part of the value. */
  fingerprint: string;
  relay_offered: boolean;
}

/** 허브 하나에 붙어 본 결과. `hub_probe`와 `hub_open`이 같은 모양을 돌려준다. */
export interface HubProbe {
  /** `HubRow.id`와 같은 값(인증서 지문). 방금 저장된 줄을 목록에서 찾는 열쇠다. */
  id: string;
  box_label: string;
  /** 허브가 이 폰을 무엇으로 인식했는지. 화면이 기억한 값이 아니라 저쪽의 답이다. */
  device_label: string;
  /** QR이 릴레이 주소를 나르고 있었는지. 아니면 같은 네트워크에서만 닿는다. */
  relay_offered: boolean;
  sessions: HubProbeSession[];
  /**
   * 사용자가 노트북 앱에서 만든 묶음. 화면이 아직 안 보냈으면 `null`.
   *
   * `null`과 빈 표는 다른 사실이다 — 앞은 "아직 못 받았다", 뒤는 "사이드바가
   * 비었다". 화면이 그 둘을 같게 그리면 사용자는 자기가 정리한 것이 사라졌다고
   * 읽는다.
   */
  layout: HubLayout | null;
  /**
   * 묶음을 폰에 기억시키지 못한 이유. 성공했으면 `null`.
   *
   * 연결은 성공했고 위 `layout`도 맞다 — 실패한 것은 다음에 노트북이 꺼져 있을
   * 때를 위한 기억뿐이라, 오류가 아니라 쪽지로 온다.
   */
  layout_note: string | null;
  direct_pairing: PairingOutcome | null;
  direct_pairing_error: CommandError | null;
  /** 대답하지 못한 상자. 목록에서 빼면 없는 상자로 읽힌다. */
  unreachable: string[];
}

/** Rust `SourceControlOutcomeFile` — 바뀐 파일 하나. */
export interface LaunchOfferTarget {
  id: string;
  space_label: string;
  folder_label: string;
  /** 비어 있으면 짝지은 그 컴퓨터다 — 화면이 자기가 아는 이름을 채운다. */
  box_label: string;
  path_hint: string;
  startable: boolean;
  /** Older offers retain local worktree support. */
  worktree_supported?: boolean;
  /** Reported installation is local to the paired computer. */
  provider_installation?: "reported" | "check_on_start";
}

export interface LaunchOfferKind {
  id: string;
  label: string;
  installed: boolean;
}

export interface LaunchOffer {
  /**
   * 노트북 화면이 이 표를 한 번이라도 내려보냈는가.
   *
   * 빈 목록과 갈라 읽는다. 방금 켜진 노트북은 기다리면 되고, 폴더가 하나도 없는
   * 노트북은 거기 가서 등록해야 한다 — 사람이 할 일이 다르다.
   */
  published: boolean;
  targets: LaunchOfferTarget[];
  kinds: LaunchOfferKind[];
}

export interface StartAgentOutcome {
  /** 노트북이 실제로 띄웠는가. 요청이 닿았는가가 아니다. */
  started: boolean;
  agent_id: string | null;
  /** 띄웠어도 없을 수 있다 — 제공자에 따라 세션 id 는 나중에 생긴다. */
  session_id: string | null;
  detail: string | null;
  code: string | null;
}

export interface FolderBrowserEntry {
  name: string;
  path: string;
}

export interface FolderBrowserOutcome {
  ok: boolean;
  path: string | null;
  entries: FolderBrowserEntry[];
  detail: string | null;
  code: string | null;
}

export interface SourceControlFile {
  path: string;
  /** git name-status 첫 글자: A/M/D/R/C/T. */
  status: string;
  /** 옮겨진 파일의 원래 경로. `R`/`C` 가 아니면 `null`. */
  old_path: string | null;
  /**
   * 이진 파일이면 `null`. 0 이 아니다 — `+0 −0` 은 "안 바뀜" 으로 읽히는데, 그
   * 파일은 바뀌었다. 화면 타입으로 옮길 때 `null` 은 **없음**이 된다.
   */
  added: number | null;
  deleted: number | null;
  /**
   * 아직 커밋되지 않은 변경이 이 파일에 있나.
   *
   * `null` 은 거짓이 아니라 **안 물어봤다** 이다. 목록은 기준 브랜치와의
   * 비교라 이미 커밋된 파일도 들어 있고, 커밋하거나 되돌릴 수 있는지는 HEAD
   * 와의 비교가 답하는 다른 질문이다. 거짓으로 접으면 모든 줄이 "커밋할 것
   * 없음" 으로 그려지고, 참으로 접으면 고를 수 없는 것을 고르게 해서 선택
   * 전체가 거절된다.
   */
  uncommitted: boolean | null;
}

/**
 * Rust `HubGitStatusOutcome` — 세션 하나가 무엇을 바꿔 놓았나.
 *
 * `read: false` 와 빈 목록은 다르다. 앞은 못 읽은 것이고 뒤는 깨끗한 저장소다.
 * 같게 그리면 노트북이 답을 못 준 걸 "바뀐 게 없다" 로 보여주게 된다.
 */
/**
 * 그 상자에서 방금 시작한 세션.
 *
 * 실패도 결과다. 가장 흔한 실패는 "이 키로는 만들 수 없다"이고 그건 사람이 그
 * 상자에서 켜야 하는 상태라, 문장을 상자가 쓴 그대로 싣는다 — 어느 플래그를
 * 켜야 하는지 그 문장이 말한다.
 */
export interface CreatedSessionOutcome {
  started: boolean;
  session: HubProbeSession | null;
  code: string | null;
  detail: string | null;
}

export interface SourceControlOutcome {
  read: boolean;
  /**
   * 노트북이 그 순간 읽은 브랜치.
   *
   * 배치표(layout)에도 브랜치가 있지만 그것은 캐시다 — 터미널 pane 은 담기지
   * 않고, 기존 체크아웃에서 만든 에이전트는 비어 있다. 소스 컨트롤 화면은 물어서
   * 받은 이 값을 먼저 쓴다.
   */
  branch: string | null;
  files: SourceControlFile[];
  ahead: number | null;
  behind: number | null;
  base_ref: string | null;
  /** 못 읽은 이유. 읽었으면 없다. 화면은 이 문장을 그대로 보여준다. */
  detail: string | null;
  /**
   * 파일 목록을 무엇과 비교한 것인가 — `merge_base` 또는 `head`.
   *
   * 앞뒤 수는 다른 질문(브랜치의 upstream)에 답한다. 한 화면이 둘을 같은 것처럼
   * 그리면 40개 앞선 브랜치가 2개 앞선 것으로 읽힌다.
   */
  comparison: string | null;
  /** 저장소 뿌리. 세션 디렉토리보다 위일 수 있다. */
  root: string | null;
  /**
   * 문장이 아니라 상태로 갈라야 하는 거절의 코드.
   *
   * `unsupported_protocol_version` 은 그 상자의 hmux 를 갱신하라는 뜻이고,
   * 그건 사용자가 할 일이 있는 상태다 — 다시 눌러 보라는 뜻이 아니다.
   */
  code: string | null;
  /**
   * 파일 목록을 실제로 물어봤나.
   *
   * 탭마다 다른 읽기다. 커밋 탭과 PR 탭의 답은 파일을 싣지 않으므로, 그 빈
   * 목록을 "깨끗하다" 로 읽으면 브랜치 카드가 더러운 워크트리 위에
   * "0 changed" 라고 쓴다 — 물어보지도 않은 것에 대한 주장이다.
   */
  files_read: boolean;
  /** 기준 브랜치 이후의 커밋들. 커밋 탭이 물었을 때만 채워진다. */
  /** 리뷰를 부탁할 만한 사람들. 리뷰어 시트가 물었을 때만 채워진다. */
  reviewers: SourceControlReviewer[];
  /**
   * 사람 목록을 실제로 물어봤나.
   *
   * 빈 목록은 "함께 커밋한 사람이 없다" 는 답이다(새 저장소에서 실제로 있는
   * 상태). 못 물어본 것과 다른 사실이라 따로 온다.
   */
  reviewers_read: boolean;
  /**
   * 커밋 하나의 메시지 본문. 커밋 상세가 물었을 때만, 본문이 있을 때만 온다.
   *
   * `null` 은 빈 문자열이 아니다 — 본문 없는 커밋은 흔하고, 둘을 접으면 화면이
   * "본문이 없다" 와 "아직 안 읽었다" 를 갈라 그릴 수 없다.
   */
  commit_body: string | null;
  branches: SourceControlBranch[];
  /**
   * 브랜치를 실제로 물어봤나. 저장소에는 언제나 브랜치가 하나는 있으므로 빈
   * 목록은 "없다" 가 아니다 — 이 값이 가르는 것은 "이 노트북은 아직 안 보낸다"
   * 이다. `commits_read` 와 같은 이유로 있다.
   */
  branches_read: boolean;
  commits: SourceControlCommit[];
  /**
   * 커밋을 실제로 물어봤나.
   *
   * `commits` 가 비어 있어도 이것이 참이면 "기준 브랜치 이후 커밋이 없다" 는
   * 뜻이고, 거짓이면 "못 물어봤다" 는 뜻이다. 접으면 base 에 그대로 앉은
   * 워크트리 — 여기서 가장 흔한 상태 — 가 "아직 안 보냅니다" 로 보인다.
   */
  commits_read: boolean;
  /** 이 브랜치에 열린 리뷰. */
  review: SourceControlReview | null;
  /**
   * 리뷰를 실제로 물어봤나.
   *
   * `review` 가 없어도 이것이 참이면 "아직 리뷰가 없다" 는 뜻이고, 거짓이면
   * "못 물어봤다" 는 뜻이다. 접으면 "PR 없음" 이 "gh 로그인 하세요" 를 덮는다.
   */
  review_read: boolean;
}

/** Rust `SourceControlReview` — 이 브랜치에 열린 리뷰. */
/**
 * 폰이 부탁할 수 있는 저장소 변경, 전부. Rust `ScmWriteAction` 의 거울.
 *
 * 여기 **없는** 것이 요점의 절반이다: push 도, merge 도, rebase 도, reset 도,
 * 강제 옵션도 없다. 다른 사람의 작업에 닿거나 되돌릴 수 없는 것들이라 폰의 한
 * 번 누름이 일으킬 일이 아니다.
 */
export type ScmWriteAction =
  | { kind: "commit"; paths: string[]; message: string }
  /** 되돌릴 수 없다. 화면이 확인을 받은 뒤에만 보낸다. */
  | { kind: "discard"; paths: string[] }
  | { kind: "checkout"; branch: string }
  | { kind: "create_branch"; name: string }
  /**
   * 지금 브랜치를 원격에 올린다. 값이 없다 — 브랜치도 원격도 저장소가 정한다.
   *
   * 강제는 없다. 이 요청이 원격 히스토리를 덮어쓸 방법은 없고, fast-forward 가
   * 아니면 거절하는 것은 git 자신이다.
   */
  | { kind: "push" };

/** Rust `FileDiffOutcome` — 파일 하나의 패치. */
export interface FileDiffOutcome {
  /** 읽어냈나. 거짓이면 `patch` 가 없고 `detail` 이 이유를 말한다. */
  read: boolean;
  /** 물어본 경로 그대로. 화면이 답과 줄을 맞춘다. */
  path: string;
  /**
   * 통합 diff 본문.
   *
   * 이진 파일이면 `null` 이다 — 빈 문자열이 아니다. 빈 본문은 "이 파일에서
   * 바뀐 게 없다" 라는 다른 답이고, 둘을 접으면 화면이 PNG 를 "변경 없음" 으로
   * 그린다.
   */
  patch: string | null;
  /** 본문이 상한에 걸려 잘렸나. */
  truncated: boolean;
  /** 이진 파일인가. 참이면 본문이 없고, 그것은 실패가 아니다. */
  binary: boolean;
  added: number | null;
  deleted: number | null;
  /** 거절의 종류. 문장이 아니라 이 값으로 분기한다. */
  code: string | null;
  detail: string | null;
}

/** 리뷰의 체크 요약. 시안(3050:81530)의 "체크 2/2 통과". */
export interface SourceControlChecks {
  total: number;
  passed: number;
  failed: number;
  /** 아직 도는 것. 통과도 실패도 아니다. */
  pending: number;
}

export interface SourceControlReview {
  number: number;
  title: string;
  /** 호스트가 부르는 그대로 — `OPEN` / `CLOSED` / `MERGED`. */
  state: string;
  url: string;
  is_draft: boolean;
  base_ref: string;
  /** 리뷰가 요청된 사람들의 로그인. 팀은 여기 없다. */
  requested_reviewers: string[];
  /** 호스트의 리뷰 판정. 아무도 아직 안 봤으면 빈 문자열이다. */
  review_decision: string;
  /**
   * 호스트의 체크 요약.
   *
   * `null` 은 "체크가 없다" 가 아니라 **못 물어봤다** 이다. CI 가 없는 저장소는
   * 0개짜리 요약으로 답하고, 둘을 접으면 못 물어본 질문에 "체크 없음" 이라고
   * 말하게 된다.
   */
  checks: SourceControlChecks | null;
}

/** Rust `SourceControlCommit` — 커밋 하나. */
/** Rust `SourceControlReviewer` — 리뷰어 시트의 한 줄. */
export interface SourceControlReviewer {
  login: string;
  /** 커밋이 들고 있는 이름. 비어 있으면 화면이 로그인만 그린다. */
  name: string;
}

/** Rust `SourceControlBranch` — 전환 시트의 한 줄. */
export interface SourceControlBranch {
  name: string;
  current: boolean;
  /** 다른 워크트리가 쓰고 있으면 그 경로. git 이 두 번째 체크아웃을 거절한다. */
  checked_out_at: string | null;
  when: string | null;
}

export interface SourceControlCommit {
  short_sha: string;
  subject: string;
  author: string;
  /** 사람이 읽는 상대 시각. 노트북이 이미 사람 말로 만들어 보낸다. */
  when: string;
}

/** 세션 하나가 노트북 사이드바에서 앉아 있는 자리. */
export interface HubPlacement {
  /** 사용자가 만든 최상위 묶음 — 사이드바의 "Workspace" 같은 것. */
  desktop: string;
  /** 그 안의 저장소/프로젝트 — 사이드바의 "agent-ide" 같은 것. */
  project: string;
  /** 사이드바에서의 순서. 폰이 같은 순서로 세울 수 있게. */
  order: number;
  /**
   * 그 세션이 올라앉은 git 브랜치.
   *
   * 노트북이 모르면 없다 — 저장소가 아닌 세션도 있고, 아직 상태를 못 읽은
   * 세션도 있다. 없으면 화면은 **아무것도 그리지 않는다.** 대시나 빈 문자열로
   * 채우면 "브랜치를 모른다"와 "브랜치가 없다"가 같은 그림이 된다.
   */
  branch?: string | null;
}

/**
 * 노트북 한 대의 사이드바 모양.
 *
 * 폰은 이 표와 허브의 로컬/원격 카탈로그를 함께 받아 노트북과 같은 묶음으로
 * 세운다. 직접 SSH 목록만 남은 때에도 이 표를 재사용한다.
 */
export interface HubLayout {
  /** hmux 세션 id → 자리. */
  placements: Record<string, HubPlacement>;
  /** 데스크탑이 사이드바에 선 순서. 이름만으로는 순서를 알 수 없다. */
  desktop_order: string[];
}

export interface HubProbeSession extends RemoteSession {
  presentation?: SessionPresentation | null;
  /** Rust가 계산해 붙인다. 화면이 `lifecycle`을 다시 해석하지 않는다. */
  ready: boolean;
  box_id: string;
  box_label: string;
}

export interface ServerListing {
  version: number;
  servers: ServerRow[];
}

/** The Rust `SshHostAuth`, as serde reads it. */
export type SshHostAuthWire =
  | { kind: "device" }
  | { kind: "imported"; privateKeyPem: string }
  | { kind: "password"; password: string };

/**
 * What comes back once a typed-in host has been reached.
 *
 * The public key is not in here: the stored private key is its one authority,
 * and `serverPublicKey` reads it back from there whenever a screen needs it.
 */
export interface SshHostAdded {
  listing: ServerListing;
}

export interface LimitationReport {
  kind: string;
  message: string;
}

export interface RuntimeInfo {
  protocol_major: number;
  protocol_minor: number;
  withheld_over_relay: string[];
  limitations: LimitationReport[];
}

export interface AttachedSession {
  session_id: string;
  /** 전송 계층이 무엇을 증명했는지. hmux-ssh-transport가 직접 문장으로 준다. */
  attestation: string;
  granted_capabilities: string[];
  /** 중계 연결이라 요청조차 하지 않은 세 가지 권한. 붙은 결과와 같은 호출에서 온다. */
  withheld_over_relay: string[];
  /** `observer` 또는 `controller`. 명령을 만드는 값과 같은 것이라 화면과 서버가 어긋날 수 없다. */
  role: string;
  terminal: {
    attachment_id: string;
    terminal_epoch: string;
    through_output_seq: string;
    state_revision: string;
    initial_delivery_record_count: number;
  };
}

export type DeviceIdentityStatus = {
  state: "not_provisioned";
  reason: string;
  planned_algorithm: string;
};

/** 어느 용도의 키인지. 서버가 강제 명령을 쓰면 둘을 따로 등록해야 한다. */
export type KeyRole = "attach" | "list";

export const ipc = {
  listServers: () => invoke<ServerListing>("list_servers"),
  /**
   * Whether the system allows local notifications, asked of the system each
   * time: `true`/`false` once decided, `null` while it has not been asked.
   * The notification plugin's own `isPermissionGranted()` answers from a
   * snapshot its init script takes at page load, so a decision made in the
   * system settings while the app runs would not reach it until a restart.
   */
  notificationPermissionGranted: () =>
    invoke<boolean | null>("plugin:notification|is_permission_granted"),
  syncPushNotifications: (preference: "all" | "approvals" | null, language: "en" | "ko") =>
    invoke<import("./pushNotifications").PushSyncResult>("sync_push_notifications", { preference, language }),
  resetDevice: () => invoke<void>("reset_device"),
  saveServer: (entry: ServerEntry) => invoke<ServerListing>("save_server", { entry }),
  /**
   * Adds a host somebody typed in, by asking the host who it is.
   *
   * No fingerprint goes in: this phone pins a host key on every connection and
   * nobody can type one from a phone, so the dial reads the key the address
   * answers with. That is the SSH client's own first-connection trust, and it
   * is why this is a command of its own rather than a `saveServer` with a
   * field left blank — an entry with no pin cannot connect at all.
   */
  addSshHost: (draft: {
    id: string;
    label: string;
    host: string;
    port: number;
    username: string;
    auth: SshHostAuthWire;
  }) => invoke<SshHostAdded>("add_ssh_host", { draft }),
  /**
   * Reads the private key at a path the system picker just returned.
   *
   * Only that: the picker is what grants the file, and this is the read of it.
   * There is no general "open a path" command here on purpose.
   */
  readSshPrivateKey: (path: string) => invoke<string>("read_ssh_private_key", { path }),
  deleteServer: (id: string) => invoke<ServerListing>("delete_server", { id }),
  /** The `authorized_keys` line a host must trust, derived from that server's stored attach key. */
  serverPublicKey: (id: string) => invoke<string>("server_public_key", { id }),
  saveIdentity: (serverId: string, role: KeyRole, privateKeyPem: string) =>
    invoke<ServerListing>("save_identity", { serverId, role, privateKeyPem }),
  /** `hmux mobile-gateway`에 세션 목록을 스트림으로 요청하고 프레임 JSON 목록을 읽어온다. */
  discoverSessions: (serverId: string) =>
    invoke<RemoteSession[]>("discover_sessions", { serverId }),
  /**
   * 등록된 모든 서버에 각각 직접 물어본다. 노트북은 관여하지 않는다.
   *
   * 서버마다 정확히 하나의 보고가 돌아온다 — 대답하지 못한 서버까지. 짧은
   * 목록을 조용히 돌려주면 없는 세션이 죽은 세션으로 읽힌다.
   */
  takeSessionCensus: () => invoke<ServerReport[]>("take_session_census"),
  /**
   * QR로 읽은 문자열 하나로 페어링을 끝낸다.
   *
   * 문자열을 받는다는 것이 중요하다: 카메라가 없는 플랫폼에서도 같은 경로가
   * 그대로 돌고, 그래서 이 흐름은 폰 없이도 시험할 수 있다.
   */
  // ── v2(오프라인) 페어링 ────────────────────────────────────────────────
  //
  // QR이 개인키와 서버 목록을 담고 있고 여섯 글자 코드로 봉인돼 있다. 어떤
  // 소켓도 열지 않으므로 같은 와이파이일 필요가 없다.

  /**
   * 스캔한 텍스트가 어느 흐름인지. `offline`이면 코드를 물어야 하고, `hub`면
   * 이 컴퓨터의 앱에 직접 붙는 다른 경로다. `link`는 페어링 코드가 아니라
   * 사람이 브라우저에 넣을 주소다 — 노트북 1단계의 설치 페이지 QR이 그것이고,
   * 갈라 두지 않으면 SSH 해독기까지 내려가 "페어링 코드가 아닙니다"로 끝난다.
   */
  pairingFlowFor: (scanned: string) =>
    invoke<"online" | "offline" | "hub" | "link">("pairing_flow_for", { scanned }),

  /**
   * 허브 QR 하나로 그 컴퓨터에 붙어 세션 목록을 받는다.
   *
   * 붙은 **뒤에** 저장한다. 그래서 이 호출이 성공했다는 것은 곧 그 컴퓨터가
   * `hubList`에 한 줄로 남았다는 뜻이고, 다음부터는 `hubOpen`이 재스캔 없이
   * 같은 길을 간다.
   */
  hubProbe: (scanned: string, deviceLabel: string) =>
    invoke<HubProbe>("hub_probe", { scanned, deviceLabel }),

  /**
   * Read a scanned hub QR without connecting. The confirm screen shows the
   * fingerprint from this.
   *
   * `hubProbe` cannot double as this because of order: it connects and then
   * saves, so a confirm screen drawn from its result would appear after the
   * connection it is meant to authorise had already happened.
   */
  hubPreview: (scanned: string) => invoke<HubOfferPreview>("hub_preview", { scanned }),

  /**
   * 세션 하나가 무엇을 바꿔 놓았는지 노트북에 묻는다.
   *
   * `sessionId` 는 카탈로그가 준 값이어야 한다. 폰이 지어낸 값이면 노트북은 그
   * 세션을 못 찾고 거절 문장을 돌려준다.
   *
   * 이 값은 밀어 주는 배치(layout)에 실을 수 없다 — 저장할 때마다 움직여서,
   * 그 경로의 규약(자주 바뀌지 않는 값만)을 깬다. 그래서 물어서 가져온다.
   */
  /**
   * 이 브랜치에 리뷰를 열어 달라고 한다.
   *
   * 폰이 일으키는 유일한 바깥으로 나가는 일이다 — 다른 사람이 보는 리뷰가
   * 생긴다. 그래서 화면이 확인을 받고 나서만 부른다.
   */
  hubCreatePullRequest: (
    hubId: string,
    sessionId: string,
    title: string,
    body: string,
    draft: boolean,
  ) =>
    invoke<SourceControlOutcome>("hub_create_pull_request", {
      id: hubId,
      sessionId,
      title,
      body,
      draft,
    }),

  hubGitStatus: (
    hubId: string,
    sessionId: string,
    want?: "changes" | "commits" | "pull_request" | "branches" | "reviewers",
  ) =>
    invoke<SourceControlOutcome>("hub_git_status", {
      id: hubId,
      sessionId,
      want: want ?? null,
    }),

  /** "새 에이전트" 폼이 고를 수 있는 것들. 폼을 열 때 묻는다. */
  hubLaunchOffer: (hubId: string) => invoke<LaunchOffer>("hub_launch_offer", { id: hubId }),

  hubBrowseFolder: (hubId: string, path?: string) =>
    invoke<FolderBrowserOutcome>("hub_browse_folder", { id: hubId, path: path ?? null }),

  hubCreateFolder: (hubId: string, parent: string, name: string) =>
    invoke<FolderBrowserOutcome>("hub_create_folder", { id: hubId, parent, name }),

  /**
   * 에이전트를 하나 띄워 달라고 한다.
   *
   * `actionId` 는 **이 누름**의 이름이다. 답이 오는 길이 끊겨 다시 부를 때는 같은
   * 값을 그대로 넘겨야 한다 — 노트북은 그 이름으로 재시도와 두 번째 누름을
   * 가른다. 새 값을 지어 주면 그 순간 에이전트가 둘 뜬다.
   */
  hubStartAgent: (
    hubId: string,
    targetId: string,
    kindId: string,
    actionId: string,
    useWorktree: boolean,
    branch: string | null,
    folderPath?: string,
  ) =>
    invoke<StartAgentOutcome>("hub_start_agent", {
      id: hubId,
      input: {
        targetId,
        kindId,
        actionId,
        useWorktree,
        branch,
        folderPath: folderPath ?? null,
      },
    }),

  /**
   * 세션 하나가 무엇을 바꿔 놓았는지 그 상자에 직접 묻는다.
   *
   * [`hubGitStatus`] 와 같은 질문에 대한 두 번째 답. 짝지은 노트북이 그 세션을
   * 모르면 — SSH 로만 닿는 상자가 그렇다 — 물어볼 곳은 그 상자 자신뿐이다.
   */
  sshGitStatus: (
    serverId: string,
    sessionId: string,
    workspaceId: string,
    want?: "changes" | "commits" | "pull_request",
  ) =>
    invoke<SourceControlOutcome>("ssh_git_status", {
      serverId,
      sessionId,
      workspaceId,
      want: want ?? null,
    }),

  hubStageSessionFile: (id: string, sessionId: string, file: { fileName: string; dataB64: string }) =>
    invoke<string[]>("hub_stage_session_file", { id, sessionId, file }),
  /**
   * 파일 하나의 패치를 노트북에 묻는다.
   *
   * 목록과 따로 묻는다 — 본문은 프레임 한도에 들지 않고, 목록을 여는 것만으로
   * 아무도 안 열어 본 파일의 본문까지 건너간다.
   */
  hubFileDiff: (hubId: string, sessionId: string, path: string, commit?: string) =>
    invoke<FileDiffOutcome>("hub_file_diff", {
      id: hubId,
      sessionId,
      path,
      commit: commit ?? null,
    }),

  /**
   * 그 상자에서 세션 하나를 시작한다 — 노트북을 거치지 않고.
   *
   * 폰은 이 상자에 SSH 로 직접 닿는데, 시작만은 노트북을 거쳐야 했다. 게이트웨이가
   * 강제 명령 키의 생성 요청을 거절했기 때문이고, 그건 운영자가 그 상자의
   * `authorized_keys` 줄에 `--allow-create` 를 켜면 열린다. 켜지 않은 상자는 전과
   * 같이 거절하며, 그 문장이 무엇을 켜야 하는지 말한다 — `started` 가 거짓일 때
   * `detail` 을 그대로 보여주는 이유다.
   */
  sshCreateSession: (serverId: string, cwd?: string) =>
    invoke<CreatedSessionOutcome>("ssh_create_session", {
      serverId,
      cwd: cwd ?? null,
    }),

  /** 같은 질문을 그 상자에 직접. [`sshGitStatus`] 와 같은 이유로 있다. */
  sshFileDiff: (
    serverId: string,
    sessionId: string,
    workspaceId: string,
    path: string,
    commit?: string,
  ) =>
    invoke<FileDiffOutcome>("ssh_file_diff", {
      serverId,
      sessionId,
      workspaceId,
      path,
      commit: commit ?? null,
    }),

  /**
   * 저장소를 바꿔 달라고 노트북에 부탁한다.
   *
   * SSH 짝이 없다. 폰이 상자에 직접 쓰는 길은 없고, 있어서도 안 된다 —
   * 페어링 키는 읽기 전용 forced command 다. 그래서 이 기능은 짝지은 노트북이
   * 그 세션을 아는 경우에만 존재하고, 화면은 그때만 컨트롤을 그린다.
   *
   * `actionId` 는 이 **누름**의 이름이다. 답이 오는 길이 끊겨 다시 물었을 때
   * 노트북이 같은 누름인 줄 알아야 커밋이 둘 생기지 않는다.
   */
  hubScmWrite: (hubId: string, sessionId: string, actionId: string, action: ScmWriteAction) =>
    invoke<SourceControlOutcome>("hub_scm_write", {
      id: hubId,
      sessionId,
      actionId,
      action,
    }),

  /**
   * 커밋 하나가 무엇을 했는지 노트북에 묻는다.
   *
   * 목록의 `want` 가 아니라 자기 명령인 이유: 목록 요청의 모양이 "리비전을
   * 이름 짓지 않는다" 는 약속이고, 변경 탭이 아직 거기 기대고 있다.
   */
  hubCommitDetail: (hubId: string, sessionId: string, commit: string) =>
    invoke<SourceControlOutcome>("hub_commit_detail", {
      id: hubId,
      sessionId,
      commit,
    }),

  /**
   * 이 리뷰의 리뷰어를 바꿔 달라고 노트북에 부탁한다.
   *
   * `hubScmWrite` 와 나뉘어 있는 이유: 저장소를 바꾸면 고른 파일 목록이 의미를
   * 잃지만, 리뷰어를 바꾸는 것은 그 선택에 아무 영향이 없다.
   *
   * 집합이 아니라 더할 사람과 뺄 사람이다 — 목록에 없던 팀을 이 화면이 지우지
   * 않게 한다.
   */
  hubSetReviewers: (
    hubId: string,
    sessionId: string,
    actionId: string,
    number: number,
    add: readonly string[],
    remove: readonly string[],
  ) =>
    invoke<SourceControlOutcome>("hub_set_reviewers", {
      id: hubId,
      sessionId,
      actionId,
      number,
      add,
      remove,
    }),

  /** 저장된 컴퓨터 목록. 앱을 켤 때 한 번 불러 화면을 복원한다. */
  hubList: () => invoke<HubRow[]>("hub_list"),

  /** 저장된 컴퓨터 하나로 다시 붙는다. 카메라를 열지 않는다. */
  hubOpen: (id: string) => invoke<HubProbe>("hub_open", { id }),
  /**
   * 폰이 기억하고 있는 묶음. 허브 id → 그 노트북의 사이드바 모양.
   *
   * 노트북에 붙지 않고 읽는다. 그것이 이 명령이 있는 이유다 — 노트북이 꺼져
   * 있어도 SSH로 붙는 서버 세션은 살아 있고, 그 목록은 사용자가 만든 묶음대로
   * 서야 한다.
   */
  hubLayouts: () => invoke<Record<string, HubLayout>>("hub_layouts"),

  /**
   * 이 폰이 기억하고 있던 것만 지운다.
   *
   * 노트북 쪽 기기 등록은 남는다 — 그건 노트북의 기기 목록에서 취소하는
   * 별개의 일이고, 여기서 같이 지우는 척하면 "해지했다"고 믿은 폰이 실제로는
   * 여전히 등록된 채로 남는다.
   */
  hubForget: (id: string) => invoke<boolean>("hub_forget", { id }),

  /**
   * 입력한 코드가 코드가 될 수 있는지, 정규화한 값과 함께.
   *
   * 64MiB 유도를 걸기 전에 부른다 — 오타 하나에 0.2초를 쓰고 "맞지 않습니다"를
   * 받으면 사용자는 코드를 다시 읽는 대신 QR을 다시 스캔한다.
   */
  pairingCodeNormalize: (typed: string) =>
    invoke<string | null>("pairing_code_normalize", { typed }),

  pairingCodeLength: () => invoke<number>("pairing_code_length"),

  /** v2 QR과 코드로 페어링을 끝낸다. */
  pairOffline: (scanned: string, code: string) =>
    invoke<PairingOutcome>("pair_offline", { scanned, code }),

  pairFromScan: (scanned: string, deviceLabel: string) =>
    invoke<PairingOutcome>("pair_from_scan", { scanned, deviceLabel }),
  /**
   * Attaches to a session. Success opens the pull stream of complete
   * TerminalSurface records.
   *
   * `writable`은 기본이 거짓이다. 참이면 세션의 유일한 쓰기 리스를 가져가므로,
   * 타이핑하지 않을 화면은 요청하지 않는다 — 보고만 있는 폰이 노트북에서
   * 타이핑을 막는 이유가 되어서는 안 된다.
   */
  attachSession: (serverId: string, session: RemoteSession, writable = false) =>
    invoke<AttachedSession>("attach_session", { serverId, session, writable }),
  resolveSessionSuccessor: (serverId: string, session: RemoteSession) =>
    invoke<SessionResolution>("resolve_session_successor", { serverId, session }),
  resolveHubSessionSuccessor: (hubId: string, boxId: string, session: RemoteSession) =>
    invoke<SessionResolution>("resolve_hub_session_successor", { hubId, boxId, session }),
  attachHubSession: (hubId: string, boxId: string, session: RemoteSession, writable = false) =>
    invoke<AttachedSession>("attach_hub_session", {
      hubId,
      boxId,
      session,
      writable,
    }),
  detachSession: (attachmentId?: string) =>
    invoke<string | null>("detach_session", {
      attachmentId: attachmentId ?? null,
    }),
  nextTerminalRecord: (attachmentId: string) =>
    invoke<ArrayBuffer>("next_terminal_record", { attachmentId }),
  sendTerminalRecord: (attachmentId: string, record: Uint8Array) =>
    invoke<string>("send_terminal_record", {
      attachmentId,
      record: Array.from(record),
    }),
  deviceIdentityStatus: () => invoke<DeviceIdentityStatus>("device_identity_status"),
  runtimeInfo: () => invoke<RuntimeInfo>("client_runtime_info"),
};

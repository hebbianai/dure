import { notificationPermission, sendLocalNotification } from "./notificationDelivery";
import { createPushSync, pushSyncNote, type PushSyncState } from "./pushNotifications";
import type { SpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import type { HomeMenuSection } from "./homeViewMenu";
import { loadHomeViewOptions, saveHomeViewOptions } from "./homeViewPreferences";
import { preserveHomeScroll } from "./homeScroll";
import {
  type RememberedListing,
  type ServerReport,
  emptyMessage,
  failures,
  mergeSessions,
} from "./census";
import { createSessionCensus } from "./sessionCensus";
import { createNativeBack } from "./nativeBack";
import {
  type HubSessions,
  type UnifiedSource,
  allSessionRows,
  flattenRows,
  hubKnowing,
  mergeLayouts,
  sourceOpenable,
} from "./allSessions";
import { renderHomeScreen } from "./censusView";
import { t } from "./i18n";
import { describeError, isCommandError } from "./commandError";
import {
  type AttachedSession,
  type HubLayout,
  type HubOfferPreview,
  type HubProbe,
  type HubRow,
  type KeyRole,
  type PairingOutcome,
  type ScmWriteAction,
  type ServerRow,
  ipc,
} from "./ipc";
import { hubReach, hubTitle, reachOf, sortHubs } from "./hubs";
import {
  actionIdFor,
  emptyForm,
  type LaunchForm,
  preselect,
  retryKeepsActionId,
  selectSpace as selectSpaceIn,
} from "./launch";
import { renderLaunchScreen } from "./launchView";
import {
  createFolderBrowserFlow,
  type FolderBrowserScreen,
  type LaunchScreen,
} from "./folderBrowserFlow";
import {
  renderCodeEntry,
  renderConfirm,
  renderFirstRun,
  renderPaste,
  renderScan,
} from "./pairingScreens";
import { type ScanOutcome, type ScannerBridge, scanPairingCode } from "./scanner";
import {
  type DraftFieldError,
  type ServerDraft,
  confinementNote,
  draftToEntry,
  entryToDraft,
  formatEndpoint,
  sortServers,
} from "./servers";
import { type RemoteSession, currentSession, sessionTitle } from "./sessions";
import { type StructuredTerminalSurface, mountStructuredTerminal } from "./structuredTerminal";
import { type ApprovalGate, createApprovalGate } from "./approvalGate";
import {
  type BiometricBridge,
  type BiometryKind,
  confirmOwner,
  probeBiometry,
} from "./biometricLock";
import { keyTapFeedback } from "./haptics";
import {
  type NotificationPermission,
  createNotificationObserver,
} from "./notificationPolicy";
import { renderSessionList } from "./sessionListView";
import { type SshHostForm, EMPTY_SSH_HOST_FORM, sshHostFields } from "./sshHostDraft";
import { renderSshHostAddScreen } from "./sshHostAddView";
import {
  type SessionPanel,
  closeTrayDrawer,
  lowerKeyboard,
  paintArmedKey,
  paintSessionState,
  renderSessionScreen,
  showTrackpadDirection,
  yieldTrayDrawer,
} from "./sessionScreen";
import type { AgentRuntimeState } from "./agentRuntimeState";
import { publishTranscriptLift } from "./transcriptLift";
import {
  type SourceControlChanges,
  changesFromOutcome,
  renderSourceControl,
} from "./sourceControlView";
import { type FilePatch, patchFromOutcome, renderFileDiff } from "./fileDiffView";
import { renderCommitSheet } from "./scmSheets";
import * as commandHistory from "./commandHistory";
import { type KeyPress, pressKey } from "./terminalKeys";
import * as keyTray from "./keyTray";
import { renderKeyStripScreen } from "./keyStripView";
import { projectHome } from "./homeProjection";
import type { RowFilter } from "./sessionRows";
import * as recents from "./recents";
import { attachPullToRefresh } from "./pullToRefresh";
import { renderAddSheet } from "./addSheetView";
import iconArrowUpRight from "./assets/icon-arrow-up-right.svg";
import iconRefreshCw from "./assets/icon-refresh-cw.svg";
import { type RowMenuItem, renderSessionRowMenu } from "./sessionRowMenu";
import type { MenuAnchor } from "./sessionRowMenuPlacement";
import { glyph } from "./dom";
import iconPlusLarge from "./assets/icon-plus-lg.svg";
import packageMetadata from "../package.json";
import { HELP_URL, feedbackUrl, openExternal } from "./openExternal";
import { languageName, renderSettingsScreen } from "./settingsView";
import { renderSettingsChoiceScreen } from "./settingsChoiceView";
import {
  renderComputerListScreen,
  renderHostDetailScreen,
  renderHostListScreen,
} from "./hostSettingsView";
import {
  EMPTY_HOST_KEYS_DRAFT,
  type HostKeysDraft,
  clearDraft,
  keysScreenModel,
  withDraft,
} from "./hostKeys";
import { renderHostKeysScreen } from "./hostKeysView";
import { renderConfirmDialog } from "./confirmDialog";
import { renderToast } from "./toast";
import { createKeyboardHeightRecorder } from "./keyboardHeight";
import { EMPTY_LEDGER, markEntrances, type MotionLedger } from "./enterMotion";
import {
  DEFAULT_SETTINGS_PREFERENCES,
  type SettingsPreferences,
  loadSettingsPreferences,
  resolveSettingsLanguage,
  saveSettingsPreferences,
} from "./settingsPreferences";

/**
 * 첫 화면은 서버 목록이 아니라 **모든 서버의 세션**이다.
 *
 * 페어링이 끝나면 노트북은 사라진다. 폰은 서버 목록을 들고 각 서버에 직접
 * 물어보고, 사용자가 찾는 것은 "어느 서버"가 아니라 "어제 남겨둔 그 에이전트"다.
 * 서버 화면은 설정으로 물러난다.
 */
/**
 * 소스 컨트롤 화면이 여는 시트 하나. Figma 3050:81250, 3048:81145.
 *
 * 화면이 아니라 소스 컨트롤 화면의 **필드**인 이유: 둘 다 그 화면 위에 그려지고,
 * 아래 목록이 계속 보이는 것이 시안의 요점이다 — 커밋 시트는 어떤 파일에 대한
 * 것인지 말하고, 확인은 무엇을 버리는지 말한다.
 */
type ScmSheet =
  | { kind: "commit"; message: string; error?: string }
  /** 되돌릴 수 없는 일 앞의 확인. 무엇을 되돌리는지 경로로 말한다. */
  | { kind: "discard"; paths: readonly string[]; error?: string };

/** One open row menu. See `State.rowMenu`. */
interface RowMenu {
  readonly sessionId: string;
  readonly anchor: MenuAnchor;
}

type Screen =
  // 홈이 첫 화면이다. 세션 전체 목록(`sessions`)은 홈에서 서버를 고르기 전
  // 단계가 아니라, 서버를 가로질러 훑고 싶을 때 가는 곳으로 남는다.
  | { kind: "home" }
  | { kind: "sessions" }
  /**
   * Choosing the strip's keys. Figma 3272:85021.
   *
   * Edits the live strip — there is no draft and no 저장, because the screen's
   * own preview is the strip. `added` is the key the last press put in, which
   * is what lets that chip pop in and the row scroll to it; `scrollTop` is
   * where the page stands, kept current by the screen's own scroll so a redraw
   * nobody asked for does not throw somebody back to where they last tapped.
   *
   * `confirm` is 기본값으로 재설정 waiting for an answer (Figma 3202:81879).
   */
  | {
      kind: "key-strip";
      returnTo: Screen;
      added?: string;
      scrollTop?: number;
      confirm?: true;
    }
  | {
      kind: "source-control";
      title: string;
      /**
       * Who to ask, and about what. Both sides resolve `sessionId` against
       * their own catalog, so it must be the id that catalog gave — one the
       * phone made up comes back as "그 세션을 찾지 못했습니다".
       *
       * A paired computer answers when one knows the session; otherwise the box
       * itself does, over the SSH connection this phone already holds. Which
       * one it is has nothing to do with which list the row came from.
       */
      hubId?: string;
      /**
       * 이 세션을 직접 아는 상자. `label` 은 사람에게 보여주기 위한 것이다 —
       * 짝을 안 지은 상자라고 말할 때 `host-GQqGGxKN` 을 내밀면 사용자는 어느
       * 기계인지 알 수 없고, 할 수 있는 일도 없다.
       */
      ask?: { serverId: string; workspaceId: string; label: string };
      sessionId: string;
      changes: SourceControlChanges;
      /**
       * 다음 커밋에 넣으려고 고른 파일들.
       *
       * 화면 상태다 — 커밋이 실제로 돌기 전에는 git 의 index 에 아무것도
       * 올라가지 않는다. 화면을 떠나면 선택이 사라지고 저장소는 그대로다.
       * 그게 요점이다: 폰이 반쯤 스테이징해 둔 index 는 누군가의 책상 위에서
       * 발견되는 놀라움이 된다.
       */
      selection?: ReadonlySet<string>;
      /** 지금 열려 있는 시트. 하나뿐이다. */
      sheet?: ScmSheet;
      /** 요청이 나가 있다. 두 번째를 시작할 수 있는 컨트롤은 죽는다. */
      busy?: boolean;
      returnTo: Screen;
    }
  /**
   * 파일 하나의 패치. 변경 목록의 줄을 누르면 열린다. Figma 3048:81027.
   *
   * 누구에게 물을지는 소스 컨트롤 화면에서 그대로 받는다 — 여기서 다시
   * 정하면 목록과 패치가 다른 컴퓨터에서 올 수 있고, 그 화면은 정상으로
   * 보인다.
   */
  | {
      kind: "file-diff";
      hubId?: string;
      ask?: { serverId: string; workspaceId: string; label: string };
      sessionId: string;
      /** 목록이 준 경로 그대로. 폰이 짓지 않는다. */
      path: string;
      /**
       * 이 파일에 아직 커밋되지 않은 변경이 있나.
       *
       * 목록이 말해 준 값을 그대로 들고 온다 — 여기서 다시 물으면 목록과 이
       * 화면이 서로 다른 순간을 말하게 되고, 버튼은 그 차이만큼 거짓말을 한다.
       */
      uncommitted?: boolean;
      /** 커밋의 파일 목록에서 왔으면 그 짧은 sha. */
      commit?: string;
      patch: FilePatch;
      returnTo: Screen;
    }
  /**
   * "새 에이전트". Figma `dure-UI` 3172:81560.
   *
   * `actionId` 는 **한 번의 누름**의 이름이고, 화면 상태에 있어야 재시도가 같은
   * 값을 다시 보낸다. 매번 새로 지으면 노트북에게는 사람이 여러 번 누른 것과
   * 같아지고, 그 순간 에이전트가 둘 뜬다.
   */
  | LaunchScreen
  | FolderBrowserScreen
  | { kind: "pair"; stage: PairStage; busy: boolean }
  | { kind: "settings"; reset?: "confirm" | "busy"; clearCommands?: "confirm" }
  /**
   * 설정 › 컴퓨터. `forget` is the 잊기 waiting for an answer, then running.
   * Not "hubs": `hub` below is one computer's own screen and differs by a letter.
   */
  | { kind: "computers"; forget?: { id: string; busy: boolean } }
  | {
      kind: "settings-choice";
      page: "language" | "notifications" | "font-size" | "scroll";
    }
  | { kind: "servers" }
  /**
   * A new or edited SSH host.
   *
   * `returnTo` because the form has two doors now: 설정 → 직접 추가, and the
   * home screen's 추가 sheet. Sending both back to 설정 drops somebody who came
   * from the session list onto a screen they never opened.
   */
  | {
      kind: "form";
      draft: ServerDraft;
      returnTo?: Screen;
      /** 호스트 제거 on a paired entry, asking and then running. */
      remove?: "confirm" | "busy";
    }
  /**
   * Adding an SSH host by hand. Figma 3177:82034.
   *
   * Its own screen rather than the `form` above, which edits a saved entry: the
   * two ask for different things. `form` still owns the host-key fingerprint,
   * because an entry that came from pairing has one and it can be read there;
   * this one has no such field at all, and the key is learned on save.
   */
  | {
      kind: "ssh-host-add";
      form: SshHostForm;
      saving?: boolean;
      failure?: { title: string; detail: string };
      returnTo?: Screen;
    }
  /**
   * 설정 › 호스트 › SSH 키. The public key is read back when the screen opens
   * and lands here; the pasted drafts live here too, so a redraw the host
   * check causes puts them back into the textareas.
   *
   * `returnTo` is where the host detail behind this screen goes back to: the
   * screen is reached from the detail (which has a `returnTo` of its own) and
   * from a device-key add, which started at home or in 설정. Back goes to the
   * detail, and the detail back to where the add began.
   */
  | {
      kind: "keys";
      serverId: string;
      publicKey?: string;
      publicKeyFailure?: string;
      copied?: boolean;
      drafts: HostKeysDraft;
      returnTo?: Screen;
    }
  | {
      kind: "server-sessions";
      server: ServerRow;
      sessions?: RemoteSession[];
      /** 목록 위 칩. 화면 상태라서 여기 둔다 — 서버를 다시 열면 전체로 돌아간다. */
      filter: RowFilter;
      busy: boolean;
    }
  | {
      kind: "terminal";
      source: SessionSource;
      session: RemoteSession;
      attached: AttachedSession;
      returnTo: Screen;
      /** 왜 보기만 되는지. 쓰기가 거부된 뒤의 관찰 attach 에만 있다. */
      watchReason?: string;
    };

type SessionSource =
  | { kind: "ssh"; id: string; label: string }
  | { kind: "hub"; id: string; label: string; boxId: string };

/**
 * Where the person came from, so cancelling gives their input back.
 *
 * A confirm screen reached from a pasted code has to return to that code, not
 * to an empty field: a fingerprint that did not match is a reason to look
 * again, not a reason to retype.
 */
type PairOrigin = { kind: "scan" } | { kind: "paste"; deviceLabel: string; payload: string };

type PairStage =
  /** The camera, with the mockup's overlay drawn over it. Figma 2865:76794. */
  | { kind: "scan"; notice?: string }
  /** The same path typed instead of scanned. Figma 2863:76554. */
  | { kind: "paste"; deviceLabel: string; payload: string; notice?: string }
  /**
   * The fingerprint, before anything connects. Figma 2865:77049.
   *
   * Holds the scanned string because this screen is the authorisation: the
   * connection happens on "연결" and nowhere earlier.
   */
  | {
      kind: "confirm";
      scanned: string;
      deviceLabel: string;
      offer: HubOfferPreview;
      origin: PairOrigin;
    }
  /**
   * v2: the QR is in hand and only the code is missing.
   *
   * It holds the scanned payload because reopening the camera to type a code
   * would point it at a screen that has already moved on. A v2 payload does not
   * expire, so holding it costs nothing — and without the code it is nothing.
   */
  | {
      kind: "code";
      payload: string;
      code: string;
      notice?: string;
      origin: PairOrigin;
    }
  | { kind: "done"; outcome: PairingOutcome };

interface State {
  screen: Screen;
  settings: SettingsPreferences;
  /**
   * 페어링한 컴퓨터. Rust가 붙는 데 성공한 뒤에 저장한 것이고, 앱을 켤 때
   * `hub_list`로 복원한다 — 이게 없으면 저장은 되는데 화면이 읽지 않아서
   * 사용자는 켤 때마다 다시 스캔한다.
   */
  hubs: HubRow[];
  /**
   * 폰이 기억하고 있는 묶음. 허브 id → 그 컴퓨터의 사이드바 모양.
   *
   * 노트북에 붙지 않고 읽는다. 노트북을 막 켜면 카탈로그는 오는데 묶음은 아직 안
   * 오고(화면이 뜨기 전이다), 그때 이것이 없으면 목록이 몇 초 동안 다른 축으로
   * 섰다가 제자리로 돌아간다.
   */
  hubLayouts: Record<string, HubLayout>;
  /**
   * 컴퓨터별로 마지막에 받은 세션 목록.
   *
   * "세션" 화면이 SSH 인구조사와 이것을 한 목록으로 합친다. 화면을 열 때마다 다시
   * 묻지 않는 이유는 인구조사와 같다 — 그 화면의 새로고침이 둘을 함께 갱신한다.
   */
  hubSessions: Record<string, HubSessions>;
  servers: ServerRow[];
  /** 홈과 세션 목록이 같은 인구조사를 쓴다 — 화면을 옮길 때마다 다시 묻지 않게. */
  reports?: ServerReport[];
  /**
   * What each SSH server last listed, kept across a census it fails.
   *
   * The mirror of `hubSessions` for the other transport, and it exists for the
   * same reason: a server that stops answering must leave its sessions on the
   * screen, dimmed, rather than deleting them. Deleted rows read as dead
   * agents. `census.rememberListings` owns the merge.
   */
  serverListings: Record<string, RememberedListing>;
  hostChecks: Record<string, { reachable: boolean; checkedAt: number }>;
  checkingHost?: string;
  /**
   * 세션을 시작하는 중인 서버.
   *
   * 화면이 아니라 앱의 상태다: 생성은 상자에 프로세스를 하나 띄우는 일이라,
   * 두 번 눌리면 유령 세션이 하나 더 남는다.
   */
  startingServer?: string;
  /** 조사가 도는 중. 화면이 아니라 앱의 상태다 — 홈과 목록이 같은 조사를 본다. */
  censusBusy: boolean;
  /** 이 폰의 표현 상태. 서버가 대답하지 않아도 보여줄 수 있다. */
  recents: recents.RecentVisit[];
  /** 이 폰에서 보낸 명령. 세션 화면의 "최근" 서랍이 읽는다. */
  commands: commandHistory.SentCommand[];
  /** 세션 화면에서 열려 있는 서랍. */
  panel: SessionPanel;
  /**
   * Ctrl 이 다음 키를 기다리는 중인가.
   *
   * 손가락은 Ctrl 을 누른 채 C 를 못 누른다. 그래서 한 번 걸어 두고 다음
   * 누름에만 붙는다 — 계속 켜 두면 마음을 바꿔 누른 평범한 키가 파괴적인
   * 것이 된다.
   */
  /** The modifier waiting for the next tray press, by id. */
  armed?: string;
  /** The tray this phone has saved. */
  tray: keyTray.KeyGroup;
  /**
   * The 추가 sheet is open over the list. Figma 3096:86354.
   *
   * Lives beside `banner` rather than inside `Screen` because the FAB that
   * opens it is drawn over two screen kinds, and a sheet that belongs to one of
   * them would vanish on the other while its own button stayed.
   */
  addSheet: boolean;
  /**
   * The menu a long press opened, over one session row. Figma 3356:85254.
   *
   * Identity and geometry, never a node: `render()` replaces the whole tree and
   * a census does that several times a minute, so the element the finger landed
   * on is gone long before the menu is next drawn. The same reason `opening`
   * carries a session id rather than a row.
   */
  rowMenu?: RowMenu;
  /**
   * The selected desktop tab. Presentation state, so it lives here and not in
   * the hub protocol.
   */
  desktop?: string;
  homeOptions?: SpacesViewOptions;
  homeMenu?: HomeMenuSection;
  /**
   * The session this phone is attaching to right now.
   *
   * Every list that can open a session reads it, so the row that was tapped is
   * the thing that says the tap landed — one fact, one owner, four screens
   * projecting it.
   */
  opening?: string;
  /**
   * Which sensor this phone has, once the settings screen has asked. Unset
   * until then; the row draws as unavailable until the answer lands, so the
   * desktop shell and jsdom — where the plugin does not exist — never show a
   * switch that cannot work.
   */
  biometry?: BiometryKind;
  /**
   * What the system has decided about this app's notifications, as last read
   * from the plugin. Unset until the settings screen or a choice asks; the
   * row and the choice note say when it is missing. Sending never reads this —
   * it asks the plugin at the moment it sends.
   */
  notificationPermission?: NotificationPermission;
  pushSync?: PushSyncState;
  /** Projection of the current terminal surface's failure, not a session runtime fact. */
  terminalUnavailable?: { attachmentId: string; detail: string };
  /** Host runtime projection, replaced by each observation and scoped to its attachment. */
  terminalRuntime?: { attachmentId: string; runtime: AgentRuntimeState };
  /** A failure, shown as a destructive toast until it is closed. */
  banner?: string;
  /** A plain report, shown as a neutral toast for the desktop's 2.5 seconds. */
  report?: string;
}

const DRAFT_ERROR_TEXT: Record<DraftFieldError["code"], string> = {
  empty: "",
  port_not_a_number: "포트는 숫자여야 합니다",
  port_out_of_range: "포트는 1–65535 범위여야 합니다",
  port_zero: "포트 0은 쓸 수 없습니다",
  fingerprint_shape: "지문은 SHA256:로 시작하는 값이어야 합니다",
};

const EMPTY_FIELD_TEXT: Record<Extract<DraftFieldError, { code: "empty" }>["field"], string> = {
  label: "이름을 입력하세요",
  host: "호스트를 입력하세요",
  username: "계정을 입력하세요",
};

function errorText(error: DraftFieldError): string {
  return error.code === "empty"
    ? t(EMPTY_FIELD_TEXT[error.field])
    : t(DRAFT_ERROR_TEXT[error.code]);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 오류는 코드까지 보여준다 — "연결 실패"만으로는 어디를 고쳐야 할지 알 수 없다. */
/**
 * 쓰기가 거부됐지만 보기로는 붙었을 때, 그 이유를 사람이 읽는 말로.
 *
 * 세션 화면의 읽기 전용 줄이 이 문장을 들고 간다. 위쪽 빨간 배너가 아닌 이유는
 * 세션이 **열렸기** 때문이다 — 열리지 않은 것처럼 읽히는 자리에 두면 잘 열린
 * 화면 위에 실패가 얹힌다. 그 줄은 이미 "입력 켜기" 버튼을 달고 있어서, 다음에
 * 할 일도 그 옆에 있다.
 *
 * 코드마다 그 다음 일이 다르다: 남이 잡고 있으면 입력 켜기가 언젠가 되고, 보기
 * 전용으로 짝지어졌으면 영원히 안 된다. 모르는 코드는 원문을 남긴다 — 지어낸
 * 설명보다 낫다.
 */
export function watchingBecause(refusal: string | undefined): string | undefined {
  if (refusal === undefined) return undefined;
  if (refusal.includes("hmux_controller_conflict")) {
    return t("읽기 전용 — 다른 곳에서 입력 중입니다");
  }
  if (refusal.includes("hmux_authorization_denied")) {
    return t("읽기 전용 — 이 연결은 보기 전용으로 짝지어졌습니다");
  }
  return t("읽기 전용 — {reason}", { reason: refusal });
}

/**
 * 카메라 플러그인은 필요할 때만 불러온다.
 *
 * 정적 import를 하지 않는 이유: 이 플러그인은 Android/iOS 전용이고, 데스크탑
 * 빌드와 jsdom 테스트에서는 존재하지 않는 명령을 가리킨다. 화면을 여는 것만으로
 * 그 모듈이 평가되면, 카메라를 쓰지도 않는 경로가 없는 것 때문에 무너진다.
 */
async function cameraBridge(): Promise<ScannerBridge> {
  const plugin = await import("@tauri-apps/plugin-barcode-scanner");
  return {
    checkPermissions: () => plugin.checkPermissions(),
    requestPermissions: () => plugin.requestPermissions(),
    scan: (options) =>
      plugin.scan({
        formats: options.formats as never,
        windowed: options.windowed,
      }),
    cancel: () => plugin.cancel(),
  };
}

/** The biometric plugin, loaded only when the screen needs it — same reason as `cameraBridge`. */
async function biometricBridge(): Promise<BiometricBridge> {
  const plugin = await import("@tauri-apps/plugin-biometric");
  return {
    checkStatus: () => plugin.checkStatus(),
    authenticate: (reason, options) => plugin.authenticate(reason, options),
  };
}

/**
 * Below this, the difference between the two viewports is something other than
 * a keyboard — a browser toolbar sliding, or rounding. Every software keyboard
 * on a phone is far taller.
 */
const KEYBOARD_MIN_HEIGHT = 120;
/** How long a plain report stays up: the desktop toast's own clock. */
const REPORT_MS = 2500;

/**
 * How much of the window the OS keyboard is covering, or 0 when it is down.
 *
 * # Why the keyboard is read from the viewport and not from focus
 *
 * Tapping the transcript raises the keyboard too — that field belongs to the
 * terminal, and it is the one somebody uses to answer an agent. Keying the
 * layout off our own input's focus left the message row standing in front of
 * the keys in exactly that case. The layout viewport does not shrink for the
 * keyboard on iOS and the visual one does, so the gap between them is the
 * keyboard, whoever put it there.
 *
 * One reader for two publishers: the viewport listener that raises the flag,
 * and the render that has to reserve room whether or not a keyboard event just
 * fired. Two would drift, and the number is what the terminal is sized from.
 */
function keyboardCoverage(): number {
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  const covered = window.innerHeight - viewport.height;
  if ((viewport.scale ?? 1) > 1.01 || covered <= KEYBOARD_MIN_HEIGHT) return 0;
  return covered;
}

export function startApp(root: HTMLElement): () => void {
  let disposed = false;
  const nativeBack = createNativeBack();
  // What the keyboard covers, kept for the drawers that stand in for it.
  const keyboardHeight = createKeyboardHeightRecorder(document.documentElement);
  // What the last render showed, so the next knows what is new (#851).
  let motion: MotionLedger = EMPTY_LEDGER;
  let state: State = {
    screen: { kind: "home" },
    settings: loadSettingsPreferences(),
    hubs: [],
    hubLayouts: {},
    hubSessions: {},
    servers: [],
    serverListings: {},
    hostChecks: {},
    censusBusy: false,
    recents: recents.load(),
    commands: commandHistory.load(),
    panel: "none",
    tray: keyTray.load(),
    addSheet: false,
  };
  let surface: StructuredTerminalSurface | undefined;
  const pushSync = createPushSync({
    permission: () => notificationPermission(false),
    synchronize: ipc.syncPushNotifications,
    changed: (pushSync) => {
      if (disposed) return;
      writeState({ pushSync });
      if (state.screen.kind === "settings-choice" && state.screen.page === "notifications") {
        const note = view.querySelector(".settings-choice__note");
        if (note) note.textContent = notificationNote();
      }
    },
  });
  function notificationNote(): string {
    return pushSyncNote(state.pushSync,
      state.settings.notifications === "off" ? "granted" : state.notificationPermission);
  }
  function syncPush(): void {
    pushSync.request({
      preference: state.settings.notifications,
      language: resolveSettingsLanguage(state.settings.language),
    });
  }
  const refreshPushOnForeground = () => {
    if (document.visibilityState === "visible") syncPush();
  };
  document.addEventListener("visibilitychange", refreshPushOnForeground);
  // Phone-local input history, scoped to the attachment rather than its renders.
  // ponytail: this records typed attempts, not the provider's line editor state.
  let commandDraft = "";
  /** The Face ID gate on `surface`'s input; lives and dies with the attachment, like the surface. */
  let approvalGate: ApprovalGate | undefined;
  /**
   * The node the transcript is drawn into, and which attach it belongs to.
   *
   * # Why the screen does not own this
   *
   * Every `setState` re-renders, and re-rendering used to dispose the surface
   * and build a fresh host: arming Ctrl, opening a drawer, or toggling the
   * arrow pad tore down the terminal and re-primed it from scratch. Reattaching
   * is not free and it is not invisible — the transcript blanks and rebuilds
   * under whoever is reading it.
   *
   * So the surface's life is tied to the *attachment*, not to a render. The
   * screen asks for this node and places it; nothing else creates or destroys
   * it. One authority, one state path.
   */
  let transcriptNode: HTMLElement | undefined;
  let transcriptAttachment: string | undefined;
  let transcriptScroll = { scrollTop: 0, scrollLeft: 0 };
  let sessionOpenGeneration = 0;
  /**
   * Which change request the source-control screen is waiting on.
   *
   * Two refreshes are two independent round trips, each able to take the full
   * 20-second deadline; without this, the slower one wins by arriving last.
   */
  let changesGeneration = 0;
  /**
   * Which patch request the file screen is waiting on.
   *
   * Its own counter, not the change list's: a person can open a file, go back,
   * and open another before the first answers, and sharing one counter would
   * make a refresh of the *list* silently discard a patch that is still coming.
   */
  let patchGeneration = 0;
  /**
   * Which scan the screen is currently waiting on.
   *
   * In windowed mode the camera keeps reading after the person has walked off
   * the scan screen, so an answer can arrive for a screen nobody is looking at.
   * Letting it through would drag someone out of the paste field they had
   * started typing in, or send them home from a form they were filling.
   */
  let scanGeneration = 0;
  let hostRetryTimer: number | undefined;
  let connectionEpoch = 0;

  const view = element("div", "view");
  root.replaceChildren(view);

  function setState(next: Partial<State>): void {
    if (disposed) return;
    writeState(next);
    preserveHomeScroll(view, render);
    sessionCensus.sync();
  }

  /**
   * State without the redraw — for the one caller that must not redraw.
   *
   * A render replaces the whole tree, so it blurs whatever holds focus. That
   * is fine on every path somebody took deliberately, and wrong on the one
   * that runs *because* the keyboard came up: see `publishViewport`.
   */
  function writeState(next: Partial<State>): void {
    state = { ...state, ...next };
  }

  const folderBrowserFlow = createFolderBrowserFlow({
    back: nativeBack.bind,
    browse: ipc.hubBrowseFolder,
    create: ipc.hubCreateFolder,
    offer: ipc.hubLaunchOffer,
    show: (screen, clearBanner) =>
      setState({ screen, ...(clearBanner ? { banner: undefined } : {}) }),
    remember: (screen) => writeState({ screen }),
    current: () => (state.screen.kind === "folder-browser" ? state.screen : undefined),
    describeError,
  });

  /** A drawer that was asked for while the keyboard still held its space. */
  let pendingPanel: SessionPanel | undefined;

  /**
   * A drawer opens into the space the keyboard has left, not onto the keyboard.
   *
   * Opening it on the press instead puts the drawer on top of a keyboard that
   * is still retracting, so for those 250ms the drawer rides it down — it
   * reads as falling with the keyboard rather than opening (2026-09-03 user
   * report). The press already lowered the keyboard, so the open waits for the
   * space to actually be free. `publishViewport` is what says it is.
   */
  function openTrayPanel(panel: SessionPanel): void {
    const keyboardUp = document.documentElement.getAttribute("data-keyboard") === "on";
    if (panel !== "none" && keyboardUp) {
      // The opener takes the space: the keyboard goes down, and the drawer
      // moves in once the space is actually free.
      lowerKeyboard();
      pendingPanel = panel;
      return;
    }
    pendingPanel = undefined;
    setState({ panel });
  }

  /**
   * The last of a drawer, once the keyboard has finished arriving.
   *
   * The 1:1 yield in `yieldTrayDrawer` runs out when the keyboard has covered
   * the drawer. A drawer taller than the keyboard — a long history at its 45%
   * cap — would keep the remainder for good, and its button would stay lit
   * beside the keyboard's. The keyboard's animation is over by the time this
   * fires, so whatever is left goes then.
   */
  let handover: ReturnType<typeof setTimeout> | undefined;
  function finishHandoverSoon(): void {
    if (handover !== undefined || state.panel === "none") return;
    handover = setTimeout(() => {
      handover = undefined;
      if (state.panel === "none") return;
      if (document.documentElement.getAttribute("data-keyboard") !== "on") return;
      closeTrayDrawer(document);
      writeState({ panel: "none" });
    }, 320);
  }
  function cancelHandover(): void {
    if (handover === undefined) return;
    clearTimeout(handover);
    handover = undefined;
  }

  async function refresh(publish = setState): Promise<void> {
    const epoch = connectionEpoch;
    try {
      const listing = await ipc.listServers();
      if (epoch !== connectionEpoch) return;
      publish({ servers: sortServers(listing.servers), banner: undefined });
    } catch (error) {
      if (epoch !== connectionEpoch) return;
      publish({
        banner: t("서버 목록을 읽지 못했습니다: {message}", {
          message: describeError(error),
        }),
      });
    }
  }

  /**
   * 저장된 컴퓨터 목록을 읽어 온다.
   *
   * 실패해도 배너로 끝낸다. 저장소를 읽지 못한 것과 컴퓨터가 없는 것은 다른
   * 사실이고, 후자로 그리면 사용자는 페어링이 풀렸다고 읽고 책상으로 돌아간다.
   */
  async function refreshHubs(publish = setState): Promise<void> {
    const epoch = connectionEpoch;
    try {
      // 기억해 둔 묶음도 같이 읽는다. 실패하면 묶음 없이 간다 — 목록을 못 그리는
      // 것보다 다른 축으로라도 그리는 편이 낫고, 화면이 그 사실을 위에 적는다.
      const [hubs, hubLayouts] = await Promise.all([
        ipc.hubList(),
        ipc.hubLayouts().catch(() => state.hubLayouts),
      ]);
      if (epoch !== connectionEpoch) return;
      publish({ hubs, hubLayouts });
      syncPush();
    } catch (error) {
      if (epoch !== connectionEpoch) return;
      publish({
        banner: t("저장된 컴퓨터를 읽지 못했습니다: {message}", {
          message: describeError(error),
        }),
      });
    }
  }

  /**
   * 저장된 컴퓨터 하나에 붙어 세션 목록을 받는다. 카메라를 열지 않는다.
   *
   * 화면을 먼저 바꾸고 붙는다: 붙는 데 몇 초가 걸리고(직결 2초 마감 뒤 릴레이),
   * 그동안 홈에 머무르면 누른 것이 먹지 않은 것으로 보인다.
   *
   * **늦게 온 답은 화면을 빼앗지 않는다.** 이 호출은 최악의 경우 12초가 걸린다
   * — 직결 마감 2초에 릴레이 페어링 대기 10초. 사용자가 그 사이 뒤로 나가거나
   * 다른 컴퓨터를 눌렀는데 앞선 답이 도착해서 화면을 갈아끼우면, 폰이 제멋대로
   * 움직이는 것으로 보인다. 배너도 마찬가지다 — 떠난 화면의 실패 이유를 지금
   * 보고 있는 화면 위에 띄우면 그건 지금 화면이 실패했다는 말로 읽힌다.
   */
  /**
   * 방금 받은 묶음을 화면 쪽 기억에도 반영한다.
   *
   * Rust 가 이미 파일에 썼다. 여기서 한 번 더 두는 이유는 **다음 실행**이 아니라
   * **이번 실행**이다: 이 화면을 나갔다가 노트북이 꺼진 뒤 다시 들어오면, 파일은
   * 맞는데 화면 상태는 앱을 켤 때 읽은 옛 값이라 목록이 다른 축으로 선다.
   */
  function rememberLayout(
    hubId: string,
    probe: { layout: HubLayout | null },
  ): Record<string, HubLayout> {
    return probe.layout ? { ...state.hubLayouts, [hubId]: probe.layout } : state.hubLayouts;
  }

  /** 방금 받은 세션 목록을 "세션" 화면이 쓸 수 있게 둔다. */
  function rememberSessions(hub: HubRow, probe: HubProbe): Record<string, HubSessions> {
    return {
      ...state.hubSessions,
      [hub.id]: {
        hubId: hub.id,
        hubLabel: hubTitle(hub),
        reachable: true,
        sessions: probe.sessions,
      },
    };
  }

  const homeVisible = () => (state.screen.kind === "home" || state.screen.kind === "sessions") && !state.addSheet &&
    !state.rowMenu && !state.homeMenu && !state.opening && document.visibilityState !== "hidden";
  const sessionCensus = createSessionCensus({
    root,
    current: () => state,
    epoch: () => connectionEpoch,
    home: homeVisible,
    detached: () => dispose(),
    publish: (patch, background, visible) => {
      if (!background && (state.screen.kind === "home" || state.screen.kind === "sessions")) {
        setState(patch);
        return;
      }
      writeState(patch);
      if (!visible) return;
      preserveHomeScroll(view, render);
    },
    reconcile: async (publish) => { await Promise.all([refreshHubs(publish), refresh(publish)]); },
  });
  const census = sessionCensus.refresh;

  /** 화면을 떠날 때 반드시 붙잡고 있던 SSH 세션을 놓는다. */
  async function leaveTerminal(attachmentId?: string): Promise<void> {
    sessionOpenGeneration += 1;
    writeState({ opening: undefined });
    try {
      await ipc.detachSession(attachmentId);
    } catch (error) {
      // 이미 끊긴 경우가 대부분이므로 화면을 막지 않는다.
      console.warn("detach failed", error);
    }
  }

  /**
   * The attach whose transcript must stay alive under this screen, if any.
   *
   * Screens with a return path cover the session rather than replacing it.
   * Keep its one record consumer and replica alive, including through Git diffs.
   */
  function liveAttachment(screen: Screen): string | undefined {
    if (screen.kind === "terminal") return screen.attached.terminal.attachment_id;
    return "returnTo" in screen && screen.returnTo
      ? liveAttachment(screen.returnTo) : undefined;
  }

  function render(): void {
    nativeBack.begin();
    // Disposed only when the screen being drawn no longer holds the attach the
    // surface belongs to. A re-render of the same session keeps it.
    const keeping =
      transcriptAttachment !== undefined && liveAttachment(state.screen) === transcriptAttachment;
    if (!keeping) {
      surface?.dispose();
      surface = undefined;
      approvalGate?.reset();
      approvalGate = undefined;
      transcriptNode = undefined;
      transcriptAttachment = undefined;
      writeState({ terminalRuntime: undefined });
      transcriptScroll = { scrollTop: 0, scrollLeft: 0 };
      commandDraft = "";
    }
    // Read before the tree goes: `replaceChildren` detaches the transcript, and
    // a detached node's scroll position is gone. Put back after it is in the
    // new tree, below.
    if (keeping && transcriptNode?.isConnected) transcriptScroll = { scrollTop: transcriptNode.scrollTop, scrollLeft: transcriptNode.scrollLeft };
    const keptScroll = transcriptScroll;
    view.replaceChildren();

    // The camera only shows through a webview with nothing painted on it, so
    // the attribute that strips every app surface is set here — the one place
    // that already knows which screen is up. Setting it beside the `scan()`
    // call instead would leave it on any path that leaves the screen without
    // going through the outcome switch.
    const scanning =
      state.screen.kind === "pair" &&
      state.screen.stage.kind === "scan" &&
      !state.screen.stage.notice;
    if (scanning) {
      document.documentElement.setAttribute("data-scan", "on");
    } else {
      document.documentElement.removeAttribute("data-scan");
    }

    // The session screen is the one screen that must not scroll: it is sized to
    // the visible viewport, and a document taller than that is what iOS drags
    // up and down under a finger. Set here for the same reason as `data-scan` —
    // this is the one place that knows which screen is up.
    if (state.screen.kind === "terminal") {
      document.documentElement.setAttribute("data-screen", "session");
    } else {
      document.documentElement.removeAttribute("data-screen");
    }
    // `<html lang>` follows the language the copy is drawn in; index.html's
    // `lang="ko"` is only the pre-render default.
    document.documentElement.lang = resolveSettingsLanguage(state.settings.language);

    // Notices float over the column rather than sitting in it, so the row
    // somebody pressed stays under the finger still on it (`toast.ts`).
    if (state.banner) {
      view.append(
        renderToast(
          { tone: "destructive", title: state.banner },
          { dismiss: () => setState({ banner: undefined }) },
        ),
      );
    }
    if (state.report) {
      view.append(
        renderToast(
          { tone: "neutral", title: state.report },
          { dismiss: () => setState({ report: undefined }) },
        ),
      );
    }

    switch (state.screen.kind) {
      case "home":
      case "sessions": {
        view.append(renderCensus());
        view.append(...launchFab());
        // Over the list, not instead of it: 3096:86354 keeps the sessions
        // visible behind the scrim, because what is being added is added to
        // them.
        if (state.addSheet) view.append(addSheet());
        // The menu floats over the list with its own scrim.
        if (state.rowMenu) {
          const menu = rowMenu(state.rowMenu);
          if (menu) view.append(menu);
        }
        break;
      }
      case "source-control": {
        view.append(renderSourceControlScreen(state.screen));
        // 시트는 화면 **위에** 그려진다. 아래 목록이 계속 보이는 것이 시안의
        // 요점이다 — 커밋 시트는 어떤 파일에 대한 것인지 말한다.
        const sheet = renderScmSheet(state.screen);
        if (sheet) view.append(sheet);
        break;
      }
      case "file-diff":
        view.append(renderFileDiffScreen(state.screen));
        break;
      case "key-strip": {
        // The screen covers the session rather than replacing it: opened from
        // the keys drawer, the transcript under it is still attached, and
        // tearing it down to edit a strip would lose the session's scrollback.
        const strip = state.screen;
        const under = strip.returnTo;
        if (under.kind === "terminal") view.append(renderTerminal(under));
        view.append(renderKeyStrip(strip));
        if (strip.confirm) {
          view.append(
            renderConfirmDialog(
              {
                title: t("기본값으로 재설정할까요?"),
                description: t("직접 고른 키는 사라지고 기본 스트립이 돌아옵니다."),
                confirmLabel: t("재설정"),
              },
              {
                // Both read the screen fresh rather than the one closed over
                // at draw time, for the same reason `edit` does: `remember`
                // keeps writing the scroll position into it.
                cancel: nativeBack.bind(() => closeKeyStripConfirm()),
                confirm: () => {
                  keyTray.save(keyTray.DEFAULT_GROUP);
                  closeKeyStripConfirm({ tray: keyTray.DEFAULT_GROUP });
                },
              },
            ),
          );
        }
        // The pop-in belongs to the press that caused *this* draw. Spent here,
        // without a redraw, so a later one nobody asked for — a census
        // answering, a host check landing — does not play it a second time.
        if (strip.added !== undefined) writeState({ screen: { ...strip, added: undefined } });
        break;
      }
      case "launch":
        view.append(renderLaunch(state.screen));
        break;
      case "folder-browser":
        view.append(folderBrowserFlow.render(state.screen));
        break;
      case "pair":
        view.append(renderPair(state.screen));
        break;
      case "settings":
        view.append(renderSettings());
        probeBiometryOnce();
        probeNotificationPermission();
        if (state.screen.reset) {
          view.append(
            renderConfirmDialog(
              {
                title: t("기기를 초기화할까요?"),
                description: t(
                  "호스트 {count}개, 기기 키, 명령 기록과 설정이 삭제됩니다. 되돌릴 수 없습니다.",
                  { count: state.hubs.length + state.servers.length },
                ),
                confirmLabel: t("초기화"),
                busy: state.screen.reset === "busy",
              },
              {
                cancel: nativeBack.bind(() => {
                  setState({ screen: { kind: "settings" } });
                  queueMicrotask(() => settingsRow("reset")?.focus());
                }, state.screen.reset === "busy"),
                confirm: () => void resetDevice(),
              },
            ),
          );
        }
        if (state.screen.clearCommands) {
          const back = () => {
            setState({ screen: { kind: "settings" } });
            queueMicrotask(() => settingsRow("clear-commands")?.focus());
          };
          view.append(
            renderConfirmDialog(
              {
                title: t("최근 명령을 지울까요?"),
                description: t("이 폰에서 보낸 명령 {count}개가 삭제됩니다. 세션에는 영향이 없습니다.", {
                  count: state.commands.length,
                }),
                confirmLabel: t("지우기"),
              },
              {
                cancel: nativeBack.bind(back),
                confirm: () => {
                  commandHistory.clear();
                  writeState({ commands: [] });
                  back();
                },
              },
            ),
          );
        }
        break;
      case "settings-choice":
        view.append(renderSettingsChoice(state.screen.page));
        break;
      case "servers":
        view.append(renderServers());
        break;
      case "form": {
        const form = state.screen;
        view.append(renderForm(form.draft, form.returnTo));
        if (form.remove) {
          view.append(
            renderConfirmDialog(
              {
                title: t("호스트를 제거할까요?"),
                description: t(
                  "노트북이 넣은 키가 함께 지워집니다. 다시 페어링하기 전에는 되돌릴 수 없습니다.",
                ),
                confirmLabel: t("제거"),
                busy: form.remove === "busy",
              },
              {
                cancel: nativeBack.bind(() => {
                  setState({ screen: { ...form, remove: undefined } });
                  queueMicrotask(() =>
                    view.querySelector<HTMLButtonElement>(".host-settings__remove")?.focus(),
                  );
                }, form.remove === "busy"),
                confirm: () => void removeHost(form.draft),
              },
            ),
          );
        }
        break;
      }
      case "ssh-host-add":
        view.append(renderSshHostAdd(state.screen));
        break;
      case "keys": {
        const keys = state.screen;
        const server = state.servers.find((candidate) => candidate.id === keys.serverId);
        if (!server) {
          // The host went away under the screen (a listing without it landed).
          view.append(renderServers());
          queueMicrotask(() => {
            if (state.screen.kind === "keys") setState({ screen: { kind: "servers" } });
          });
          break;
        }
        view.append(
          renderHostKeysScreen(keysScreenModel(server, keys), {
            back: nativeBack.bind(() => openHostDetail(keys.serverId, keys.returnTo)),
            copyPublicKey: () => void copyPublicKey(keys.serverId),
            // Drawn, unlike a keystroke: the picked key has to land in the
            // textarea and arm 키 저장, or the pick did nothing anybody can see.
            pickFile: (role) =>
              void pickPrivateKey().then((picked) => {
                if (!picked) return;
                if (state.screen.kind !== "keys" || state.screen.serverId !== keys.serverId) return;
                setState({
                  screen: {
                    ...state.screen,
                    drafts: withDraft(state.screen.drafts, role, picked.privateKeyPem),
                  },
                });
              }),
            editDraft: (role, text) => editKeysDraft(keys.serverId, role, text),
            save: (role) => void saveHostKey(keys.serverId, role),
          }),
        );
        break;
      }
      case "computers": {
        const computers = state.screen;
        view.append(
          renderComputerListScreen(
            {
              computers: sortHubs(state.hubs).map((hub) => ({
                id: hub.id,
                label: hubTitle(hub),
                endpoint: hub.endpoint,
                reach: hubReach(hub),
              })),
            },
            {
              back: nativeBack.bind(() => setState({ screen: { kind: "settings" } })),
              forget: (id) => setState({ screen: { kind: "computers", forget: { id, busy: false } } }),
              pair: () => void startScan(),
            },
          ),
        );
        if (computers.forget) {
          const hub = state.hubs.find((candidate) => candidate.id === computers.forget?.id);
          view.append(
            renderConfirmDialog(
              {
                title: t("이 컴퓨터를 잊을까요?"),
                description: t(
                  "{computer}의 세션이 이 폰의 목록에서 사라집니다. 이 컴퓨터가 넣어 준 SSH 호스트와 노트북의 기기 목록은 그대로입니다.",
                  { computer: hub ? hubTitle(hub) : "" },
                ),
                confirmLabel: t("잊기"),
                busy: computers.forget.busy,
              },
              {
                cancel: nativeBack.bind(() => {
                  const id = computers.forget?.id ?? "";
                  setState({ screen: { kind: "computers" } });
                  // Back to the 잊기 that opened the dialog, not the first in the list.
                  queueMicrotask(() =>
                    view
                      .querySelector<HTMLButtonElement>(
                        `.host-settings__forget[data-id="${CSS.escape(id)}"]`,
                      )
                      ?.focus(),
                  );
                }, computers.forget.busy),
                confirm: () => void forgetHub(computers.forget?.id ?? ""),
              },
            ),
          );
        }
        break;
      }
      case "server-sessions":
        view.append(renderServerSessions(state.screen));
        break;
      case "terminal":
        view.append(renderTerminal(state.screen));
        break;
    }

    if (state.screen.kind === "terminal" && state.panel !== "none") {
      nativeBack.bind(() => openTrayPanel("none"));
    }
    if (state.homeMenu) nativeBack.bind(() => setState({ homeMenu: state.homeMenu === "root" ? undefined : "root" }));
    nativeBack.commit();

    // The tree is built; what is new in it animates in (`enterMotion.ts`).
    motion = markEntrances(view, state.screen.kind, motion);

    // The home list can be pulled to ask again. Bound here rather than inside
    // the view because it is a gesture on a node the view does not own after it
    // returns, and every render builds a fresh one — so there is nothing to
    // unbind and nothing that outlives its element.
    const pullable = view.querySelector<HTMLElement>(".home__body");
    const strip = pullable?.querySelector<HTMLElement>(".home__pull");
    if (pullable && strip) {
      attachPullToRefresh(pullable, strip, () => {
        if (!state.censusBusy) void census();
      }, () => pullable.scrollTop);
    }

    // A drawer opens and closes through a render, so this is where the
    // transcript learns what is standing on it. Before the fit below,
    // deliberately: the fit is what scrolls the newest line clear of it.
    publishTranscriptLift(document.documentElement, {
      tray: view.querySelector(".tray"),
      drawer: view.querySelector(".tray__panel"),
      covered: keyboardCoverage(),
      stage: view.querySelector(".session__stage"),
    });

    // `replaceChildren` took the kept node out of the document and put it back
    // inside a new tree. Its box is only final once that tree is laid out, and
    // both surfaces measure their grid from it.
    //
    // Taking a node out of the document also discards where it was scrolled to,
    // and nothing announces that — no `scroll` event fires, so the surface goes
    // on believing whatever it last saw. Every render did this; it only started
    // to matter once a drawer opening became a scroll rather than a resize,
    // because then a render is how a drawer opens. Put back before the fit, so
    // the fit can still take somebody at the bottom back to the bottom.
    if (keeping) {
      queueMicrotask(() => {
        if (!transcriptNode?.isConnected) return;
        Object.assign(transcriptNode, keptScroll);
        surface?.fit();
      });
    }
  }

  // ---------------------------------------------------------------- 세션 전체

  /**
   * The branch the laptop last said this session sits on.
   *
   * One reader, because two would drift: the session header and the source
   * control screen must never disagree about which branch is open.
   */
  function currentBranch(sessionId: string): string | undefined {
    return allSessionRows({
      census: state.reports ? mergeSessions(state.reports, state.serverListings) : [],
      hubs: Object.values(state.hubSessions),
      layout: mergeLayouts(state.hubLayouts),
    }).find((row) => row.sessionId === sessionId)?.branch;
  }

  /** The live git read wins over the catalog's creation-time branch snapshot. */
  function sourceControlBranch(
    screenState: Extract<Screen, { kind: "source-control" }>,
  ): string | undefined {
    if (screenState.changes.kind !== "loading" && screenState.changes.branch) {
      return screenState.changes.branch;
    }
    return currentBranch(screenState.sessionId);
  }

  /**
   * Where a session sits in the laptop's sidebar — desktop, then project.
   *
   * The header's trail in 3017:81400 and its siblings. Read from the placement
   * the laptop published rather than assembled here: the sidebar is its screen,
   * and a second opinion about which desktop a session is on would drift the
   * first time somebody moved one. Empty when nothing placed it, and the header
   * then says what the phone does know instead.
   */
  function sessionTrail(sessionId: string): readonly string[] {
    const seat = mergeLayouts(state.hubLayouts).placements[sessionId];
    if (seat === undefined) return [];
    return [seat.desktop, seat.project].filter((segment) => segment.trim() !== "");
  }

  /**
   * Ask the laptop what this session changed, and put the answer on the screen
   * that asked.
   *
   * The result is written back only if that same screen is still open. Someone
   * who left mid-request would otherwise be thrown back to source control by an
   * answer they are no longer waiting for.
   */
  async function loadChanges(
    screenState: Extract<Screen, { kind: "source-control" }>,
  ): Promise<void> {
    const { hubId, sessionId } = screenState;
    // 두 번 새로고침하면 두 요청이 동시에 떠 있고, 각각은 왕복 마감(20초)까지
    // 걸릴 수 있다. 도착 순서로 쓰면 늦게 뜬 첫 요청이 새 목록을 덮는다.
    const generation = ++changesGeneration;
    const settle = (changes: SourceControlChanges): void => {
      const open = state.screen;
      if (generation !== changesGeneration) return;
      if (open.kind !== "source-control" || open.sessionId !== sessionId) return;
      setState({ screen: { ...open, changes } });
    };
    // 물어볼 상자는 줄이 알려 준 값을 쓴다. 조사 목록을 다시 뒤지지 않는 이유는
    // `openSourceControl` 에 있다 — 그 값은 줄을 만들 때 확정됐고, 목록은 낡을
    // 수 있어서 뒤지면 오히려 맞는 상자를 틀린 것으로 덮는다.
    const { ask } = screenState;
    if (hubId === undefined && ask === undefined) {
      // 어느 경로로도 이 세션에 닿을 수 없다. 목록에 있는데 여기 오는 경우는,
      // 그 줄을 만든 조회가 지금은 안 닿는다는 뜻이다.
      settle({
        kind: "failed",
        detail: t("이 세션에 닿을 수 있는 경로가 없습니다"),
      });
      return;
    }
    try {
      // 짝지은 컴퓨터가 먼저다. 이미 켜져 있고, SSH 왕복 하나를 아낀다. 이
      // 화면이 묻는 것은 변경 목록 하나뿐이다 — 커밋 탭과 브랜치 시트가 같이
      // 사라졌다(2026-09-04).
      let outcome =
        hubId === undefined
          ? await ipc.sshGitStatus(ask!.serverId, sessionId, ask!.workspaceId, "changes")
          : await ipc.hubGitStatus(hubId, sessionId, "changes");
      // 노트북이 "그 세션은 다른 컴퓨터에서 돈다" 고 답하면 그건 막다른 길이
      // 아니다 — 폰은 그 컴퓨터에도 닿는다. 어느 쪽이 읽을 수 있는지는 미리
      // 알 수 없고, 물어본 쪽이 알려 준다.
      if (outcome.code === "session_elsewhere") {
        if (ask === undefined) {
          // 노트북의 문장을 그대로 옮기면 "다른 컴퓨터에서 돌아서 못 읽는다"
          // 가 되는데, 폰 입장의 사실은 그게 아니다 — 그 컴퓨터에 물어볼 수는
          // 있지만 **이 폰이 그 상자를 모른다**. 할 일이 다르므로 다른 문장을
          // 말한다: 그 상자와 짝을 짓거나, 목록을 새로 고쳐야 한다.
          settle({
            kind: "failed",
            detail: t("그 세션은 다른 컴퓨터에서 돌고, 이 폰의 목록에는 그 상자가 없습니다"),
          });
          return;
        }
        // 같은 것을 그 상자에 다시 묻는다.
        outcome = await ipc.sshGitStatus(ask.serverId, sessionId, ask.workspaceId, "changes");
      }
      settle(changesFromOutcome(outcome));
    } catch (error) {
      // 짝을 안 지은 상자는 고장이 아니라 할 일이다. 내부 id 를 그대로 내밀면
      // 사용자는 어느 기계인지도, 무엇을 해야 하는지도 알 수 없다.
      if (isCommandError(error) && error.code === "server_not_found" && ask !== undefined) {
        settle({
          kind: "failed",
          detail: t("이 세션은 {box} 에서 돕니다. 이 폰은 그 상자와 아직 짝을 짓지 않았습니다", {
            box: ask.label,
          }),
        });
        return;
      }
      settle({ kind: "failed", detail: describeError(error) });
    }
  }

  function renderSourceControlScreen(
    screenState: Extract<Screen, { kind: "source-control" }>,
  ): HTMLElement {
    // 쓰기는 짝지은 노트북이 이 세션을 알 때만 가능하다. SSH 로만 닿는 상자에는
    // 그 명령이 없고 있어서도 안 된다(페어링 키는 읽기 전용) — 그럴 때는
    // 컨트롤을 아예 안 그린다. 눌러도 아무 일이 없는 체크박스는 "안 골랐다" 로
    // 읽히는데 실제로는 "고를 수 없다" 다.
    const canWrite = screenState.hubId !== undefined;
    return renderSourceControl(
      {
        title: screenState.title,
        // 화면을 열 때의 사본이 아니라 지금 값이다. 얼려 두면 새로고침이
        // 브랜치를 못 바꾸고, 뒤에 있는 세션 화면과 서로 다른 브랜치를 말한다.
        branch: sourceControlBranch(screenState),
        changes: screenState.changes,
        ...(screenState.selection === undefined ? {} : { selection: screenState.selection }),
        ...(screenState.busy === true ? { busy: true } : {}),
      },
      {
        back: nativeBack.bind(() => setState({ screen: screenState.returnTo })),
        // Two different reads: the branch rides the pushed layout, so it needs
        // a census; the file list is a request of its own.
        refresh: () => {
          setState({
            screen: { ...screenState, changes: { kind: "loading" } },
          });
          void census();
          void loadChanges(screenState);
        },
        /**
         * 한 줄을 넣거나 뺀다.
         *
         * 화면 상태일 뿐이다 — git 의 index 는 커밋이 실제로 돌기 전까지
         * 건드리지 않는다. 이 화면을 떠나면 선택이 사라지고 저장소는 그대로다.
         */
        ...(canWrite
          ? {
              toggleFile: (path: string) => {
                const next = new Set(screenState.selection ?? []);
                if (!next.delete(path)) next.add(path);
                setState({ screen: { ...screenState, selection: next } });
              },
              toggleAll: () => {
                const selectable = committableOf(screenState.changes);
                const chosen = screenState.selection ?? new Set<string>();
                const all = selectable.every((path) => chosen.has(path));
                setState({
                  screen: {
                    ...screenState,
                    selection: all ? new Set<string>() : new Set(selectable),
                  },
                });
              },
              commit: () => {
                setState({
                  screen: {
                    ...screenState,
                    sheet: { kind: "commit", message: "" },
                  },
                });
              },
            }
          : {}),
        /**
         * 파일 하나를 연다.
         *
         * 물어볼 곳은 이 화면이 이미 정한 것을 그대로 물려준다 — 목록과 패치가
         * 다른 컴퓨터에서 오면 화면은 멀쩡해 보이면서 틀린 내용을 그린다.
         */
        openFile: (file) => {
          const next: Extract<Screen, { kind: "file-diff" }> = {
            kind: "file-diff",
            ...(screenState.hubId === undefined ? {} : { hubId: screenState.hubId }),
            ...(screenState.ask === undefined ? {} : { ask: screenState.ask }),
            sessionId: screenState.sessionId,
            path: file.path,
            ...(file.uncommitted === undefined ? {} : { uncommitted: file.uncommitted }),
            patch: { kind: "loading" },
            returnTo: screenState,
          };
          setState({ screen: next });
          void loadFileDiff(next);
        },
      },
    );
  }

  /**
   * Ask for one file's patch, and put the answer on the screen that asked.
   *
   * The same two-path shape as [`loadChanges`], and for the same reason: the
   * paired laptop answers when it knows the session, and the box itself
   * answers when the laptop says the session is elsewhere. Asking only one
   * would make this screen work for some rows of a list whose other rows it
   * opened fine.
   */
  async function loadFileDiff(screenState: Extract<Screen, { kind: "file-diff" }>): Promise<void> {
    const { hubId, sessionId, path, commit, ask } = screenState;
    const generation = ++patchGeneration;
    const settle = (patch: FilePatch): void => {
      const open = state.screen;
      if (generation !== patchGeneration) return;
      // 같은 파일인지까지 본다. 뒤로 갔다가 다른 파일을 연 사람에게 앞의 답이
      // 붙으면, 화면은 제목과 본문이 서로 다른 파일인 상태가 된다.
      if (open.kind !== "file-diff" || open.sessionId !== sessionId || open.path !== path) return;
      setState({ screen: { ...open, patch } });
    };
    if (hubId === undefined && ask === undefined) {
      settle({
        kind: "failed",
        detail: t("이 세션에 닿을 수 있는 경로가 없습니다"),
      });
      return;
    }
    try {
      let outcome =
        hubId === undefined
          ? await ipc.sshFileDiff(ask!.serverId, sessionId, ask!.workspaceId, path, commit)
          : await ipc.hubFileDiff(hubId, sessionId, path, commit);
      if (outcome.code === "session_elsewhere") {
        if (ask === undefined) {
          settle({
            kind: "failed",
            detail: t("그 세션은 다른 컴퓨터에서 돌고, 이 폰의 목록에는 그 상자가 없습니다"),
          });
          return;
        }
        outcome = await ipc.sshFileDiff(ask.serverId, sessionId, ask.workspaceId, path, commit);
      }
      settle(patchFromOutcome(outcome));
    } catch (error) {
      if (isCommandError(error) && error.code === "server_not_found" && ask !== undefined) {
        settle({
          kind: "failed",
          detail: t("이 세션은 {box} 에서 돕니다. 이 폰은 그 상자와 아직 짝을 짓지 않았습니다", {
            box: ask.label,
          }),
        });
        return;
      }
      settle({ kind: "failed", detail: describeError(error) });
    }
  }

  function renderFileDiffScreen(screenState: Extract<Screen, { kind: "file-diff" }>): HTMLElement {
    // 돌아갈 곳이 목록 화면일 때만 선택과 확인 시트를 건드릴 수 있다. 다른
    // 곳에서 열린 파일 화면(커밋 상세 등)은 그 화면의 선택을 바꿀 수 없다.
    const back = screenState.returnTo.kind === "source-control" ? screenState.returnTo : undefined;
    return renderFileDiff(
      {
        path: screenState.path,
        ...(screenState.commit === undefined ? {} : { commit: screenState.commit }),
        patch: screenState.patch,
      },
      {
        back: nativeBack.bind(() => setState({ screen: screenState.returnTo })),
        // 두 컨트롤은 실제로 할 수 있을 때만 선다: 짝지은 노트북이 답한 경로이고
        // (SSH 상자의 페어링 키는 읽기 전용), 그 파일에 커밋되지 않은 변경이
        // 있을 때. 아니면 눌러도 아무 일이 없는 버튼이 된다.
        ...(back?.kind === "source-control" &&
        screenState.hubId !== undefined &&
        screenState.uncommitted === true
          ? {
              /**
               * 확인은 목록 화면이 띄운다.
               *
               * 여기서 직접 물어보면 "되돌릴 수 없다" 는 문장이 두 곳에 생기고,
               * 언젠가 한쪽만 고쳐진다. 이 버튼이 하는 일은 그 화면으로 돌아가며
               * 무엇을 버릴지 말하는 것뿐이다.
               */
              discard: () =>
                setState({
                  screen: {
                    ...back,
                    sheet: { kind: "discard", paths: [screenState.path] },
                  },
                }),
              include: () => {
                const selection = new Set(back.selection ?? []);
                selection.add(screenState.path);
                setState({ screen: { ...back, selection } });
              },
              included: (back.selection ?? new Set<string>()).has(screenState.path),
            }
          : {}),
      },
    );
  }

  /** 커밋할 것이 있는 줄들. 화면과 같은 규칙으로 센다. */
  function committableOf(changes: SourceControlChanges): readonly string[] {
    if (changes.kind !== "read") return [];
    return changes.files.filter((file) => file.uncommitted === true).map((file) => file.path);
  }

  /**
   * 저장소를 바꿔 달라고 부탁하고, 돌아온 **바뀐 뒤의 목록**을 화면에 놓는다.
   *
   * 답이 곧 새 상태다 — 한 번 더 묻지 않는 이유이고, 그 사이에 노트북 화면이
   * 닫혀 있을 수 있기 때문이기도 하다.
   *
   * 실패하면 시트 위에 이유가 남는다. 시트를 닫아 버리면 사람이 방금 쓴 커밋
   * 메시지가 같이 사라진다.
   */
  async function applyScmWrite(
    screenState: Extract<Screen, { kind: "source-control" }>,
    action: ScmWriteAction,
    onRefused: (
      open: Extract<Screen, { kind: "source-control" }>,
      detail: string,
    ) => Extract<Screen, { kind: "source-control" }>,
  ): Promise<void> {
    const { hubId, sessionId } = screenState;
    if (hubId === undefined) return;
    const generation = ++changesGeneration;
    // 이 **누름**의 이름. 답이 오는 길이 끊겨 다시 물었을 때 노트북이 같은
    // 누름인 줄 알아야 커밋이 둘 생기지 않는다.
    const actionId = `${sessionId}-${generation}`;
    setState({ screen: { ...screenState, busy: true } });
    const reopen = (): Extract<Screen, { kind: "source-control" }> | undefined => {
      const open = state.screen;
      if (generation !== changesGeneration) return undefined;
      if (open.kind !== "source-control" || open.sessionId !== sessionId) return undefined;
      return open;
    };
    try {
      const outcome = await ipc.hubScmWrite(hubId, sessionId, actionId, action);
      const open = reopen();
      if (open === undefined) return;
      const changes = changesFromOutcome(outcome);
      if (changes.kind === "failed") {
        setState({
          screen: { ...onRefused({ ...open, busy: false }, changes.detail) },
        });
        return;
      }
      // 성공했으면 시트는 닫히고 선택은 비워진다 — 방금 커밋한 파일은 더 이상
      // 고를 수 있는 것이 아니고, 남겨 두면 다음 커밋이 그것을 다시 시도한다.
      setState({
        screen: {
          ...open,
          busy: false,
          sheet: undefined,
          selection: new Set<string>(),
          changes,
        },
      });
    } catch (error) {
      const open = reopen();
      if (open === undefined) return;
      setState({
        screen: {
          ...onRefused({ ...open, busy: false }, describeError(error)),
        },
      });
    }
  }

  /** 소스 컨트롤 화면 위에 열려 있는 시트 하나. Figma 3050:81250, 3048:81145. */
  function renderScmSheet(
    screenState: Extract<Screen, { kind: "source-control" }>,
  ): HTMLElement | undefined {
    const sheet = screenState.sheet;
    if (sheet === undefined) return undefined;
    const busy = screenState.busy === true;
    const close = nativeBack.bind(
      () => setState({ screen: { ...screenState, sheet: undefined } }), busy,
    );

    if (sheet.kind === "commit") {
      const chosen = [...(screenState.selection ?? [])];
      const branch = sourceControlBranch(screenState);
      return renderCommitSheet(
        {
          files: chosen.length,
          ...(branch === undefined ? {} : { branch }),
          message: sheet.message,
          ...(busy ? { busy: true } : {}),
          ...(sheet.error === undefined ? {} : { error: sheet.error }),
        },
        {
          dismiss: close,
          // Keep the native field and its IME composition alive while typing.
          edit: (message) =>
            writeState({
              screen: {
                ...screenState,
                sheet: { ...sheet, message, error: undefined },
              },
            }),
          submit: () => {
            // Edits do not render, so the captured sheet is an older draft.
            const open = state.screen;
            if (open.kind !== "source-control" || open.busy || open.sheet?.kind !== "commit") return;
            void applyScmWrite(
              open,
              { kind: "commit", paths: [...(open.selection ?? [])], message: open.sheet.message },
              (open, detail) => ({
                ...open,
                // 시트 위에 남는다. 닫아 버리면 방금 쓴 메시지가 사라지고,
                // 다시 쓰게 만드는 실패는 실패보다 나쁘다.
                sheet:
                  open.sheet?.kind === "commit" ? { ...open.sheet, error: detail } : open.sheet,
              }),
            );
          },
        },
      );
    }

    const paths = sheet.paths;
    return renderConfirmDialog(
      {
        title: t("변경을 버릴까요?"),
        description:
          paths.length === 1
            ? t("{path} 의 변경이 사라집니다. 되돌릴 수 없습니다.", {
                path: paths[0] ?? "",
              })
            : t("파일 {count}개의 변경이 사라집니다. 되돌릴 수 없습니다.", {
                count: paths.length,
              }),
        // 버튼에 동사를 싣는다. "확인" 은 두 버튼 모두에서 "그래, 계속" 으로
        // 읽히고, 그중 하나는 작업을 지운다.
        confirmLabel: t("버리기"),
        ...(busy ? { busy: true } : {}),
      },
      {
        cancel: close,
        confirm: () =>
          void applyScmWrite(
            screenState,
            { kind: "discard", paths: [...paths] },
            (open, detail) => ({
              ...open,
              sheet: open.sheet?.kind === "discard" ? { ...open.sheet, error: detail } : open.sheet,
            }),
          ),
      },
    );
  }

  /**
   * 목록 위에 떠 있는 "더하기".
   *
   * 헤더의 "+" 는 컴퓨터를 연결하는 자리로 남긴다. 세션을 하나 더 만드는 일을
   * 거기 얹으면 같은 글자가 두 가지를 뜻하게 된다.
   *
   * 아무것도 없는 첫 화면에서는 그리지 않는다 — 그 화면은 짝짓기 하나만
   * 말하고, 그 위에 뜬 버튼은 다른 길이 있다고 말하게 된다.
   */
  function launchFab(): HTMLElement[] {
    if (state.servers.length === 0 && state.hubs.length === 0) return [];
    const fab = element("button", "fab");
    fab.type = "button";
    // 3096:86268 drops the word. `aria-label` is now this button's only name,
    // so it carries the one the pill used to show.
    fab.setAttribute("aria-label", t("새로 만들기"));
    fab.append(glyph(iconPlusLarge, 24));
    fab.addEventListener("click", () => setState({ addSheet: true, banner: undefined }));
    return [fab];
  }

  /**
   * Every session on the home list, as the list itself derives them.
   *
   * The same merge `currentBranch` uses — the remembered listings folded in, so
   * a machine that stopped answering still yields its rows. A menu opened over
   * one of those rows has to find it again, and finding nothing would close a
   * menu that is standing over a row still on screen.
   */
  function listedRows() {
    return flattenRows({
      census: state.reports ? mergeSessions(state.reports, state.serverListings) : [],
      hubs: Object.values(state.hubSessions),
    });
  }

  /**
   * The long-press menu. Figma 3356:85387 (reachable) and 3356:85535 (not).
   *
   * The row is looked up again from the current listing rather than captured at
   * press time: a census can land between the press and the tap, and a menu
   * acting on a row that no longer exists is how a phone attaches to a session
   * that ended. If it is gone, the menu closes rather than offering an action
   * with nothing behind it.
   */
  function rowMenu(open: RowMenu): HTMLElement | undefined {
    const row = listedRows().find((candidate) => candidate.sessionId === open.sessionId);
    if (!row) {
      queueMicrotask(() => setState({ rowMenu: undefined }));
      return undefined;
    }
    const close = nativeBack.bind(() => setState({ rowMenu: undefined }));
    const items: RowMenuItem[] = [];
    if (sourceOpenable(row.source)) {
      items.push({
        id: "open",
        label: t("세션 열기"),
        icon: iconArrowUpRight,
        run: () => {
          close();
          actionsOpenSession(row.source);
        },
      });
    } else {
      items.push({
        id: "reconnect",
        label: t("지금 재연결"),
        icon: iconRefreshCw,
        run: () => {
          close();
          void census();
        },
      });
      items.push({
        id: "attach",
        label: t("세션 연결"),
        icon: iconArrowUpRight,
        run: () => {
          close();
          actionsOpenSession(row.source, "reconnect");
        },
      });
    }
    return renderSessionRowMenu(
      {
        anchor: open.anchor,
        title: row.title,
        subtitle: row.branch,
        items,
      },
      { dismiss: close },
    );
  }

  /** Where 추가's two rows lead. The sheet itself is `addSheetView.ts`. */
  function addSheet(): HTMLElement {
    return renderAddSheet({
      dismiss: nativeBack.bind(() => setState({ addSheet: false })),
      startAgent: () => {
        setState({ addSheet: false });
        void openLaunch();
      },
      // The form, not the server list: the row promises a new connection, and
      // 설정 would land the person one tap short of it.
      addHost: () =>
        setState({
          addSheet: false,
          screen: {
            kind: "ssh-host-add",
            form: EMPTY_SSH_HOST_FORM,
            // Back to the list the sheet was drawn over, not to 설정 — the
            // person never opened 설정, and landing there reads as the app
            // having wandered off.
            returnTo: { kind: "home" },
          },
        }),
    });
  }

  /**
   * "새 에이전트" 시트를 열고, 그 컴퓨터에게 고를 수 있는 것을 묻는다.
   *
   * 시트를 먼저 세우고 나서 묻는다. 답을 기다렸다가 세우면, 노트북이 느린 날
   * 사람은 자기가 누른 것이 먹혔는지 알 수 없다.
   */
  async function openLaunch(hubId?: string): Promise<void> {
    const hub = hubId
      ? state.hubs.find((candidate) => candidate.id === hubId)
      : sortHubs(state.hubs)[0];
    if (!hub) {
      setState({
        screen: { kind: "home" },
        banner: t("짝지은 컴퓨터가 없습니다"),
      });
      return;
    }
    const opened = {
      kind: "launch" as const,
      hubId: hub.id,
      boxLabel: hubTitle(hub),
      stage: { kind: "loading" as const },
      form: emptyForm(),
      menu: undefined,
    };
    setState({ screen: opened, banner: undefined });
    try {
      const offer = await ipc.hubLaunchOffer(hub.id);
      // 그 사이 사람이 시트를 닫았거나 다른 컴퓨터를 골랐으면 버린다. 늦게 온
      // 답이 지금 보고 있는 목록을 갈아 끼우면, 고르는 중이던 것이 사라진다.
      if (state.screen.kind !== "launch" || state.screen.hubId !== hub.id) return;
      setState({
        screen: {
          ...state.screen,
          stage: { kind: "ready", offer },
          form: { ...state.screen.form, ...preselect(offer) },
        },
      });
    } catch (error) {
      if (state.screen.kind !== "launch" || state.screen.hubId !== hub.id) return;
      setState({
        screen: {
          ...state.screen,
          stage: { kind: "failed", message: describeError(error) },
        },
      });
    }
  }

  /**
   * 띄워 달라고 보내고 답을 기다린다.
   *
   * `actionId` 를 화면 상태에 남긴 뒤에 보낸다. 답이 오는 길이 끊겨 사람이 다시
   * 누를 때 같은 값이 다시 나가야, 노트북이 재시도인 줄 알아보고 에이전트를
   * 하나만 띄운다.
   */
  async function startAgent(screen: Extract<Screen, { kind: "launch" }>): Promise<void> {
    if (screen.stage.kind !== "ready") return;
    const { targetId, kindId, useWorktree, branch, folderPath } = screen.form;
    if (!targetId || !kindId) return;
    const actionId = actionIdFor(screen.press, screen.form);
    const sending = {
      ...screen,
      press: { ...screen.form, actionId, targetId, kindId },
      stage: { kind: "starting" as const, offer: screen.stage.offer },
    };
    setState({ screen: sending, banner: undefined });
    try {
      const outcome = await ipc.hubStartAgent(
        screen.hubId,
        targetId,
        kindId,
        actionId,
        useWorktree,
        useWorktree ? branch : null,
        folderPath,
      );
      if (state.screen.kind !== "launch" || state.screen.hubId !== screen.hubId) return;
      setState({
        screen: {
          ...sending,
          stage: { kind: "done", offer: sending.stage.offer, outcome },
        },
      });
    } catch (error) {
      if (state.screen.kind !== "launch" || state.screen.hubId !== screen.hubId) return;
      // 보내지 못한 것은 거절이 아니다. 같은 `actionId` 를 들고 ready 로 돌아가,
      // 다시 누르면 노트북이 같은 누름으로 알아본다.
      setState({
        screen: {
          ...sending,
          stage: { kind: "ready", offer: sending.stage.offer },
        },
        banner: describeError(error),
      });
    }
  }

  function renderLaunch(screen: Extract<Screen, { kind: "launch" }>): HTMLElement {
    const offer =
      screen.stage.kind === "loading" || screen.stage.kind === "failed"
        ? undefined
        : screen.stage.offer;
    const edit = (form: LaunchForm) => setState({ screen: { ...screen, form } });
    const actions = {
        // 보내 놓고 나가는 것은 막지 않는다 — 사람이 기다릴 이유가 없다. 다만
        // 답이 오면 이 화면이 없어서 아무 데도 못 그리므로, 나가면서 그렇게
        // 말한다. 조용히 사라지면 뜬 것도 안 뜬 것도 모르게 된다.
        close: nativeBack.bind(() =>
          setState({
            screen: { kind: "home" },
            banner:
              screen.stage.kind === "starting"
                ? t("띄우는 중입니다. 곧 목록에 나타납니다")
                : undefined,
          })),
        openMenu: (menu) => setState({ screen: { ...screen, menu } }),
        selectSpace: (spaceLabel) => {
          if (!offer) return;
          setState({
            screen: {
              ...screen,
              form: selectSpaceIn(offer, screen.form, spaceLabel),
              menu: undefined,
            },
          });
        },
        selectFolder: (targetId) =>
          setState({
            screen: {
              ...screen,
              form: {
                ...screen.form,
                targetId,
                folderPath: undefined,
                folderLabel: undefined,
                folderHint: undefined,
              },
              menu: undefined,
            },
          }),
        selectKind: (kindId) => edit({ ...screen.form, kindId }),
        toggleWorktree: (on) => edit({ ...screen.form, useWorktree: on }),
        // 다시 그리지 **않고** 적는다. 한 글자마다 화면을 갈아 끼우면 입력
        // 칸이 새 노드가 되어 포커스가 날아가고, 폰에서는 그것이 키보드가
        // 닫히는 것으로 보인다(2026-09-04 사용자 보고). 이 값에 매달린 유일한
        // 화면 요소인 시작 버튼은 `launchView` 가 그 자리에서 갱신한다.
        editBranch: (branch) =>
          writeState({ screen: { ...screen, form: { ...screen.form, branch } } }),
        addFolder: () =>
          folderBrowserFlow.open(
            screen,
            state.hubs.map((hub) => ({ id: hub.id, label: hubTitle(hub) })),
          ),
        // 상태를 **다시 읽는다**. 브랜치 칸은 다시 그리지 않고 쓰므로(위
        // `editBranch`), 이 자리에 닫혀 있는 `screen` 은 마지막으로 그린
        // 폼이다 — 그것을 보내면 방금 친 이름이 사라진다.
        start: () => {
          const live = state.screen;
          void startAgent(live.kind === "launch" ? live : screen);
        },
        // 다시 고를 때는 대개 누름의 이름을 버린다 — 이제부터는 새 누름이고,
        // 같은 이름으로 다시 보내면 노트북은 아까 띄운 그 에이전트를 돌려준다.
        //
        // 노트북이 "모르겠다" 고 한 경우만 이름을 지킨다. 그 요청은 이미 닿아서
        // 에이전트가 뜨는 중일 수 있고, 그때 새 이름을 지으면 하나 더 뜬다.
        again: () =>
          setState({
            screen: {
              ...screen,
              press:
                screen.stage.kind === "done" && retryKeepsActionId(screen.stage.outcome.code)
                  ? screen.press
                  : undefined,
              stage:
                screen.stage.kind === "done"
                  ? { kind: "ready", offer: screen.stage.offer }
                  : screen.stage,
            },
          }),
        open: (sessionId) => void openStartedAgent(screen.hubId, sessionId),
    } satisfies Parameters<typeof renderLaunchScreen>[1];
    if (screen.menu) nativeBack.bind(() => actions.openMenu(undefined));
    return renderLaunchScreen({
      stage: screen.stage, form: screen.form, menu: screen.menu, boxLabel: screen.boxLabel,
    }, actions);
  }

  /**
   * 방금 뜬 에이전트를 연다.
   *
   * 먼저 목록을 다시 읽는다. 노트북이 돌려준 세션 id 는 방금 생긴 것이라 이
   * 폰의 목록에는 아직 없고, 없는 줄을 열려고 하면 "그 세션을 찾지 못했습니다"
   * 가 된다 — 사실은 방금 잘 뜬 세션인데.
   *
   * 그래도 못 찾으면 목록으로 돌려보내고 그렇게 말한다. 세션 id 는 제공자에
   * 따라 붙는 데 시간이 걸리고, 그동안 빈 터미널을 여는 것보다 낫다.
   */
  /** A plain report: up for the desktop's 2.5 seconds, then gone on its own. */
  function report(text: string): void {
    setState({ report: text });
    window.setTimeout(() => {
      if (!disposed && state.report === text) setState({ report: undefined });
    }, REPORT_MS);
  }

  async function openStartedAgent(hubId: string, sessionId: string): Promise<void> {
    setState({ screen: { kind: "home" } });
    await census();
    const hub = state.hubSessions[hubId];
    const session = hub?.sessions.find((candidate) => candidate.session_id === sessionId);
    if (!hub || !session) {
      report(t("에이전트를 띄웠습니다. 곧 목록에 나타납니다"));
      return;
    }
    await openSession(
      {
        kind: "hub",
        id: hubId,
        label: session.box_label.trim() || hub.hubLabel,
        boxId: session.box_id,
      },
      session,
      { kind: "home" },
    );
  }

  function renderCensus(): HTMLElement {
    // Nothing paired yet: the first-run screen replaces this one whole, header
    // and all. Figma 2863:76314 gives it its own bar and its own guide, and
    // keeping the session header above it would show a refresh button for a
    // census with nothing to ask.
    if (state.servers.length === 0 && state.hubs.length === 0) {
      return renderFirstRun({
        scan: () => void startScan(),
        paste: () =>
          setState({
            screen: {
              kind: "pair",
              stage: { kind: "paste", deviceLabel: t("내 폰"), payload: "" },
              busy: false,
            },
          }),
      });
    }

    const reports = state.reports;
    return renderHomeScreen(
      {
        census: reports ? mergeSessions(reports, state.serverListings) : [],
        hubs: Object.values(state.hubSessions),
        layout: mergeLayouts(state.hubLayouts),
        failures: reports ? failures(reports) : [],
        busy: state.censusBusy,
        desktop: state.desktop,
        viewOptions: state.homeOptions ?? loadHomeViewOptions(),
        viewMenu: state.homeMenu,
        opening: state.opening,
        // Not having asked and having asked and found nothing are different
        // facts, and so is "no server answered". `census.ts` owns that
        // distinction; this passes its answer through.
        emptyMessage:
          reports === undefined
            ? t("아직 세션 목록을 받지 않았습니다")
            : reports.length > 0
              ? t(emptyMessage(reports))
              : t("실행 중인 세션이 없습니다"),
      },
      {
        open: actionsOpenSession,
        selectDesktop: (label) => setState({ desktop: label }),
        viewMenu: (homeMenu) => setState({ homeMenu }),
        changeView: (homeOptions) => {
          const previous = state.homeOptions ?? loadHomeViewOptions();
          saveHomeViewOptions(homeOptions);
          setState({ homeOptions, desktop: previous.groupBy === homeOptions.groupBy ? state.desktop : undefined });
        },
        pair: () => void startScan(),
        settings: () => setState({ screen: { kind: "settings" } }),
        refresh: () => void census(),
        hold: (row, anchor) => setState({ rowMenu: { sessionId: row.sessionId, anchor } }),
      },
    );
  }

  /** Attaching from the list, wherever the press came from. */
  function actionsOpenSession(source: UnifiedSource, intent: "open" | "reconnect" = "open"): void {
    const origin: SessionSource =
      source.kind === "ssh"
        ? { kind: "ssh", id: source.serverId, label: source.serverLabel }
        : {
            kind: "hub",
            id: source.hubId,
            label: source.session.box_label.trim() || source.hubLabel,
            boxId: source.session.box_id,
          };
    void openSession(origin, source.session, { kind: "sessions" }, intent);
  }

  /**
   * Attaches a session and changes the screen only after it succeeds.
   *
   * The attach command retires the previous transport before dialing. A failed
   * reattach therefore returns to the supplied non-terminal screen; retaining
   * the old terminal would leave the UI pointing at an attachment that can no
   * longer deliver frames.
   */
  async function attach(
    source: SessionSource,
    session: RemoteSession,
    writable: boolean,
    returnTo: Screen,
    generation: number,
    isCurrent: () => boolean,
    watchReason?: string,
  ): Promise<boolean | undefined> {
    if (!isCurrent()) return undefined;
    try {
      const attached =
        source.kind === "ssh"
          ? await ipc.attachSession(source.id, session, writable)
          : await ipc.attachHubSession(source.id, source.boxId, session, writable);
      if (!isCurrent()) {
        if (generation === sessionOpenGeneration) {
          await leaveTerminal(attached.terminal.attachment_id);
        }
        return undefined;
      }
      // 붙은 *뒤에* 기록한다. 붙기 전에 남기면 거부된 시도가 재개 목록에
      // 쌓이고, 홈이 갈 수 없는 곳을 권하게 된다.
      const visited =
        source.kind === "ssh"
          ? recents.withVisit(state.recents, {
              serverId: source.id,
              serverLabel: source.label,
              sessionId: session.session_id,
              title: sessionTitle(session),
              visitedAtUnixMs: Date.now(),
            })
          : state.recents;
      if (source.kind === "ssh") recents.save(visited);
      setState({
        banner: undefined,
        recents: visited,
        terminalUnavailable: undefined,
        screen: {
          kind: "terminal",
          source,
          session,
          attached,
          returnTo,
          ...(watchReason === undefined ? {} : { watchReason }),
        },
      });
      return true;
    } catch (error) {
      if (!isCurrent() || (isCommandError(error) && error.code === "terminal_attach_superseded")) {
        return undefined;
      }
      setState({ screen: returnTo, banner: describeError(error) });
      return false;
    }
  }

  /**
   * 세션을 연다: 쓰기로 시도하고, 거부되면 관찰로라도 붙는다.
   *
   * 쓰기가 기본이 된 뒤로 이 되돌리기가 필수다. 세션의 쓰기 리스는 하나뿐이고
   * 노트북이 쥐고 있으면 ControllerConflict가 나는데 — 이 앱에서 가장 흔한
   * 거부다 — 되돌리지 않으면 폰은 그 세션을 *구경조차* 못 하고 목록으로
   * 튕긴다. 그리고 `attach_session`은 실패보다 먼저 기존 attach를 끊으므로,
   * 터미널 화면에서 시도했다면 화면은 죽은 attach 위에 남는다.
   */
  async function openSession(
    source: SessionSource,
    session: RemoteSession,
    returnTo: Screen,
    intent: "open" | "reconnect" = "open",
  ): Promise<void> {
    const generation = ++sessionOpenGeneration;
    const openedFrom = state.screen;
    const isCurrent = (): boolean =>
      !disposed &&
      generation === sessionOpenGeneration &&
      (state.screen === openedFrom || state.screen === returnTo);
    setState({ banner: undefined, opening: session.session_id });
    try {
      if (intent === "reconnect") {
        // Only explicit reconnect refreshes discovery. Keep the old transcript
        // until selection succeeds; ordinary opens already carry a listed target.
        const listed = source.kind === "ssh"
          ? await ipc.discoverSessions(source.id)
          : (await ipc.hubOpen(source.id)).sessions.filter((candidate) => candidate.box_id === source.boxId);
        if (!isCurrent()) return;
        let current = currentSession(session, listed);
        if (!current) {
          const resolution = source.kind === "ssh"
            ? await ipc.resolveSessionSuccessor(source.id, session)
            : await ipc.resolveHubSessionSuccessor(source.id, source.boxId, session);
          if (!isCurrent()) return;
          if (resolution.state !== "resolved") {
            setState({ banner: resolution.state === "pending"
              ? t("terminal.reconnect.rehostPending") : t("이 세션에 닿을 수 있는 경로가 없습니다") });
            return;
          }
          current = resolution.session;
        }
        session = current;
      }
      const writable = await attach(source, session, true, returnTo, generation, isCurrent);
      if (writable !== false) return;
      const refusal = state.banner;
      // 이유는 세션 화면의 읽기 전용 줄이 들고 간다. 위쪽 빨간 배너로 남기면
      // **열린** 세션 위에 실패가 얹히고, 그 화면이 이미 제대로 말하고 있는 것을
      // 프로토콜 문장으로 한 번 더 말하게 된다.
      await attach(
        source,
        session,
        false,
        returnTo,
        generation,
        isCurrent,
        watchingBecause(refusal),
      );
    } catch (error) {
      if (isCurrent()) setState({ banner: isCommandError(error) && error.code === "hmux_protocol_version_unsupported"
        ? t("terminal.reconnect.updateRequired") : describeError(error) });
    } finally {
      // The attempt owns this marker even when rehost changes its runtime ID.
      // A late attempt must not clear a newer selection's loading state.
      if (generation === sessionOpenGeneration) {
        setState({ opening: undefined });
      }
    }
  }

  // ---------------------------------------------------------------- pairing

  /** What the laptop records for this phone when nobody typed a name. */
  function defaultDeviceLabel(): string {
    return t("내 폰");
  }

  function pairScreen(stage: PairStage, busy = false): Screen {
    return { kind: "pair", stage, busy };
  }

  function renderPair(screen: Extract<Screen, { kind: "pair" }>): HTMLElement {
    const stage = screen.stage;
    const busy = screen.busy;
    switch (stage.kind) {
      case "scan":
        return renderScan(
          { notice: stage.notice },
          {
            close: nativeBack.bind(() => {
              stopScan();
              setState({ screen: { kind: "home" } });
            }),
            paste: () => {
              stopScan();
              setState({
                screen: pairScreen({
                  kind: "paste",
                  deviceLabel: defaultDeviceLabel(),
                  payload: "",
                }),
              });
            },
          },
        );
      case "paste":
        return renderPaste(
          {
            deviceLabel: stage.deviceLabel,
            payload: stage.payload,
            notice: stage.notice,
            busy,
          },
          {
            back: nativeBack.bind(() => setState({ screen: { kind: "home" } }), busy),
            submit: (deviceLabel, payload) => {
              // Put what was typed into state before anything can fail. A
              // rejected payload must not also cost the person the code they
              // pasted — they would have to walk back to the laptop for it.
              const typed: PairStage = { kind: "paste", deviceLabel, payload };
              setState({ screen: pairScreen(typed, true), banner: undefined });
              void handleScanned(payload, deviceLabel, typed);
            },
          },
        );
      case "confirm":
        return renderConfirm(
          {
            boxLabel: stage.offer.box_label,
            endpoint: stage.offer.endpoint,
            reach: t(reachOf(stage.offer.relay_offered)),
            fingerprint: stage.offer.fingerprint,
            busy,
          },
          {
            // Both ways out land back where the code came from, so a
            // fingerprint that did not match does not also erase the payload.
            back: nativeBack.bind(() => leaveTo(stage.origin), busy),
            cancel: () => leaveTo(stage.origin),
            connect: () => {
              setState({ screen: pairScreen(stage, true), banner: undefined });
              void connectHub(stage);
            },
          },
        );
      case "code":
        return renderCodeEntry(
          { code: stage.code, notice: stage.notice, busy },
          {
            back: nativeBack.bind(() => leaveTo(stage.origin), busy),
            submit: (code) => {
              const next: PairStage = { ...stage, code };
              setState({ screen: pairScreen(next, true), banner: undefined });
              void completeOffline(next, code);
            },
          },
        );
      case "done":
        return renderPairResult(stage.outcome);
    }
  }

  /**
   * Open the camera, then hand whatever it read to the shared path.
   *
   * The screen changes first and the camera opens second. In windowed mode the
   * webview has to be transparent before the camera is behind it, and `render`
   * is what clears the background — so the scan screen must already be the
   * current screen when `scan()` is called.
   */
  async function startScan(): Promise<void> {
    const generation = ++scanGeneration;
    setState({ screen: pairScreen({ kind: "scan" }), banner: undefined });
    let outcome: ScanOutcome;
    try {
      outcome = await scanPairingCode(await cameraBridge());
    } catch (error) {
      outcome = { kind: "unavailable", detail: describeError(error) };
    }
    // An answer to a scan the person already left does not get to move the
    // screen they are on now.
    if (generation !== scanGeneration) return;
    switch (outcome.kind) {
      case "scanned":
        // Nothing on this screen asks for a device name, so the laptop gets
        // the default. The paste screen is where a name can be typed.
        await handleScanned(outcome.content, defaultDeviceLabel(), {
          kind: "scan",
        });
        break;
      case "cancelled":
        // Backing out of the camera is not an error and leaves no banner.
        setState({ screen: { kind: "home" } });
        break;
      case "unavailable":
        setState({
          screen: pairScreen({
            kind: "scan",
            notice: "이 기기에는 카메라 스캐너가 없습니다 — 코드 붙여넣기로 연결하세요",
          }),
        });
        break;
      case "permission_denied":
        setState({
          screen: pairScreen({
            kind: "scan",
            notice: "카메라 권한이 필요합니다",
          }),
        });
        break;
      case "permission_blocked":
        setState({
          screen: pairScreen({
            kind: "scan",
            notice: "카메라 권한이 꺼져 있습니다 — 설정 앱에서 켜주세요",
          }),
        });
        break;
      case "failed":
        // Stays on the scan screen. A banner over the home screen would name a
        // failure of the screen the person is now looking at.
        setState({
          screen: pairScreen({ kind: "scan", notice: outcome.detail }),
        });
        break;
    }
  }

  /**
   * Leave the scan screen: stop the camera, and disown its answer.
   *
   * Both halves matter. The plugin keeps reading until it is told to stop, and
   * the outstanding promise resolves as cancelled — which, unguarded, would
   * send the person home from whatever screen they moved to.
   */
  function stopScan(): void {
    scanGeneration += 1;
    void cameraBridge()
      .then((bridge) => bridge.cancel?.())
      .catch(() => {
        // No plugin on this platform: there was no camera to stop.
      });
  }

  /**
   * Back out of a screen to wherever its input came from.
   *
   * Going back to the camera means opening it again, not redrawing the scan
   * screen: a viewfinder over a camera that is no longer running looks live and
   * reads nothing.
   */
  function leaveTo(origin: PairOrigin): void {
    if (origin.kind === "scan") {
      void startScan();
      return;
    }
    setState({ screen: pairScreen(origin) });
  }

  /**
   * One scanned or pasted string, routed to the flow it belongs to.
   *
   * Rust decides which flow it is. Re-implementing the prefix comparison in the
   * screen would mean two places to change the day the scheme moves, and
   * missing one turns a v2 QR into "cannot reach the laptop".
   */
  async function handleScanned(
    scanned: string,
    deviceLabel: string,
    origin: PairOrigin,
  ): Promise<void> {
    const label = deviceLabel.trim() || defaultDeviceLabel();
    let flow: "online" | "offline" | "hub" | "link";
    try {
      flow = await ipc.pairingFlowFor(scanned);
    } catch (error) {
      failPairing(error);
      return;
    }

    if (flow === "link") {
      // 노트북 1단계의 설치 페이지 QR이다. 이 앱이 이미 깔린 폰이 그것을 대면
      // 다음에 할 일은 노트북에서 한 걸음 나아가는 것이므로, 그 문장을 준다 —
      // "페어링 코드가 아닙니다"는 맞지만 아무 데도 데려가지 않는다.
      setState({
        screen: state.screen.kind === "pair" ? { ...state.screen, busy: false } : state.screen,
        banner: t("앱을 내려받는 주소입니다. 노트북에서 '이 컴퓨터와 페어링'을 눌러 다음 코드를 띄우세요."),
      });
      return;
    }

    if (flow === "offline") {
      setState({
        screen: pairScreen({
          kind: "code",
          payload: scanned,
          code: "",
          origin,
        }),
        banner: undefined,
      });
      return;
    }

    if (flow === "hub") {
      // Read the offer without connecting, and show the fingerprint first.
      // `hubProbe` connects and saves in one step, so asking it would put the
      // confirmation after the connection it is meant to authorise.
      let offer: HubOfferPreview;
      try {
        offer = await ipc.hubPreview(scanned);
      } catch (error) {
        failPairing(error);
        return;
      }
      setState({
        screen: pairScreen({
          kind: "confirm",
          scanned,
          deviceLabel: label,
          offer,
          origin,
        }),
        banner: undefined,
      });
      return;
    }

    await pairOnline(scanned, label);
  }

  /** Put the screen back in reach after a failed step, with the reason. */
  function failPairing(error: unknown): void {
    const screen = state.screen;
    setState({
      screen: screen.kind === "pair" ? { ...screen, busy: false } : screen,
      banner:
        isCommandError(error) && error.code === "pairing_not_a_code"
          ? `${t("pairing.error.notCode")} (${error.code})`
          : describeError(error),
    });
  }

  /**
   * The hub path, after the fingerprint has been confirmed.
   *
   * Does not join the SSH server list — a different transport, and different
   * things work over it.
   *
   * On success it goes straight to that computer's sessions. Saying "connected"
   * in a banner and staying here would make the person back out and come in
   * again to see the list they just fetched; the result of a scan is the list,
   * not a sentence.
   */
  async function connectHub(stage: Extract<PairStage, { kind: "confirm" }>): Promise<void> {
    try {
      const probe = await ipc.hubProbe(stage.scanned, stage.deviceLabel);
      await refresh();
      // Rust saved after it connected, so this `hub_list` already contains the
      // computer. The screen takes its identity from the stored row rather than
      // inventing one, so leaving and coming back points at the same thing.
      const hubs = await ipc.hubList().catch(() => state.hubs);
      const hub = hubs.find((row) => row.id === probe.id);
      if (!hub) {
        // Connected, but not in the list — the save failed. The screen reports
        // the outcome instead of drawing a row that does not exist.
        setState({
          hubs,
          screen: pairScreen({ ...stage }),
          banner: t("{box}에 {device}(으)로 연결했습니다 · 세션 {count}개", {
            box: probe.box_label,
            device: probe.device_label,
            count: probe.sessions.length,
          }),
        });
        return;
      }
      setState({
        hubs,
        hubLayouts: rememberLayout(hub.id, probe),
        hubSessions: rememberSessions(hub, probe),
        screen: { kind: "home" },
        banner: probe.direct_pairing_error
          ? describeError(probe.direct_pairing_error)
          : probe.direct_pairing && probe.direct_pairing.refused.length > 0
            ? t("이 기기가 쓸 수 없는 서버 {count}대", {
                count: probe.direct_pairing.refused.length,
              })
            : undefined,
      });
      syncPush();
      void census();
    } catch (error) {
      failPairing(error);
    }
  }

  /** The v1 (online) path: the laptop installs this device's key on each server. */
  async function pairOnline(scanned: string, deviceLabel: string): Promise<void> {
    try {
      const outcome = await ipc.pairFromScan(scanned, deviceLabel);
      await refresh();
      setState({ screen: pairScreen({ kind: "done", outcome }) });
    } catch (error) {
      failPairing(error);
    }
  }

  /** v2: finish pairing with the typed code. */
  async function completeOffline(
    stage: Extract<PairStage, { kind: "code" }>,
    typed: string,
  ): Promise<void> {
    // Check the shape before starting the derivation. Rust checks it too, but
    // doing it here returns the answer without spending 0.2 seconds first.
    const normalized = await ipc.pairingCodeNormalize(typed).catch(() => null);
    if (!normalized) {
      const length = await ipc.pairingCodeLength().catch(() => 6);
      setState({
        screen: pairScreen({
          ...stage,
          notice: t("코드는 {length}글자입니다 — 노트북 화면의 글자를 다시 확인하세요", {
            length,
          }),
        }),
      });
      return;
    }

    try {
      const outcome = await ipc.pairOffline(stage.payload, normalized);
      await refresh();
      setState({ screen: pairScreen({ kind: "done", outcome }) });
    } catch (error) {
      // Failure keeps the payload and stays on the code screen. Making the
      // person rescan the QR when one character was wrong sends them back to
      // the laptop.
      setState({
        screen: pairScreen({ ...stage, notice: describeError(error) }),
      });
    }
  }

  function renderPairResult(outcome: PairingOutcome): HTMLElement {
    const host = element("div", "pair-screen");
    host.append(element("header", "pair-bar"));
    const block = element("div", "pair__result");
    block.append(
      element(
        "p",
        "pair__summary",
        t("서버 {count}대를 등록했습니다 · 기기 키 {algorithm}", {
          count: outcome.adopted.length,
          algorithm: outcome.key_algorithm,
        }),
      ),
    );

    // Revoking needs this value, so the screen keeps it: `hmux pair revoke <id>`
    // on the laptop.
    block.append(
      element(
        "p",
        "form__hint",
        t("기기 id {id} — 노트북에서 `hmux pair revoke`에 씁니다", {
          id: outcome.device_id,
        }),
      ),
    );

    const list = element("ul", "list");
    for (const server of outcome.adopted) {
      const item = element("li", "list__item");
      const summary = element("div", "list__open");
      summary.append(element("span", "list__label", server.label));
      summary.append(element("span", "list__endpoint", formatEndpoint(server)));
      const note = confinementNote(server);
      if (note) summary.append(element("span", "list__note", t(note)));
      item.append(summary);
      list.append(item);
    }
    block.append(list);

    // A server the laptop could not install into, or could install into without
    // this device being able to pin its host key, is named. Dropping it quietly
    // hides the very machine the person walked to the desk for.
    if (outcome.refused.length > 0) {
      block.append(
        element(
          "p",
          "failures__title",
          t("이 기기가 쓸 수 없는 서버 {count}대", {
            count: outcome.refused.length,
          }),
        ),
      );
      const refused = element("ul", "failures__list");
      for (const server of outcome.refused) {
        const item = element("li", "failures__item");
        item.append(
          element("span", "failures__server", `${server.label} (${server.host}:${server.port})`),
        );
        item.append(element("span", "failures__detail", server.detail));
        refused.append(item);
      }
      block.append(refused);
    }

    const done = element(
      "button",
      "pair-button pair-button--solid pair-button--block",
      t("세션 보기"),
    );
    done.type = "button";
    done.addEventListener("click", nativeBack.bind(() => {
      // Home: the servers just adopted are rows there, and the census fills in
      // each row's session count. What the pairing produced should be visible
      // on one screen.
      setState({ screen: { kind: "home" } });
      void refresh();
      void census();
    }));
    block.append(done);
    host.append(block);
    return host;
  }

  // ------------------------------------------------------------------- 서버

  /**
   * Where keyboard focus lands after a settings redraw: `setState` replaces
   * the tree, so the row that had focus is detached. `checked-choice` is the
   * choice screen's checked row; `row` is a settings row by its stable id.
   */
  type SettingsRefocus = { kind: "checked-choice" } | { kind: "row"; id: string };

  function refocusSettings(refocus: SettingsRefocus | undefined): void {
    if (!refocus) return;
    if (refocus.kind === "row") {
      settingsRow(refocus.id)?.focus();
      return;
    }
    view.querySelector<HTMLButtonElement>('.settings-choice__row[aria-checked="true"]')?.focus();
  }

  /** The refocus a settings row earns: only when it holds focus before the write. */
  function rowRefocus(id: string): SettingsRefocus | undefined {
    return document.activeElement === settingsRow(id) ? { kind: "row", id } : undefined;
  }

  function updateSettings(next: SettingsPreferences, refocus?: SettingsRefocus): void {
    const changedLanguage = next.language !== state.settings.language;
    saveSettingsPreferences(next);
    setState({ settings: next });
    if (changedLanguage) syncPush();
    refocusSettings(refocus);
  }

  /** A choice made from the keyboard keeps focus on the checked row. */
  const choiceRefocus = (viaKeyboard: boolean): SettingsRefocus | undefined =>
    viaKeyboard ? { kind: "checked-choice" } : undefined;

  function renderSettingsChoice(
    page: Extract<Screen, { kind: "settings-choice" }>["page"],
  ): HTMLElement {
    const back = nativeBack.bind(() => setState({ screen: { kind: "settings" } }));
    if (page === "language") {
      const systemLanguage = languageName(resolveSettingsLanguage("auto"));
      return renderSettingsChoiceScreen<SettingsPreferences["language"]>({
        title: "언어",
        options: [
          {
            value: "auto",
            label: "자동",
            detail: t("시스템 언어 따름 · {language}", {
              language: systemLanguage,
            }),
            selected: state.settings.language === "auto",
          },
          {
            value: "ko",
            label: "한국어",
            selected: state.settings.language === "ko",
          },
          {
            value: "en",
            label: "English",
            selected: state.settings.language === "en",
          },
        ],
        back,
        select: (language, viaKeyboard) =>
          updateSettings({ ...state.settings, language }, choiceRefocus(viaKeyboard)),
      });
    }
    if (page === "notifications") {
      return renderSettingsChoiceScreen<SettingsPreferences["notifications"]>({
        title: "알림",
        options: [
          {
            value: "all",
            label: "모두",
            detail: "승인과 턴 완료를 알립니다",
            selected: state.settings.notifications === "all",
          },
          {
            value: "approvals",
            label: "승인만",
            detail: "에이전트가 승인을 기다릴 때만 알립니다",
            selected: state.settings.notifications === "approvals",
          },
          {
            value: "off",
            label: "끔",
            detail: "알리지 않습니다",
            selected: state.settings.notifications === "off",
          },
        ],
        note: notificationNote(),
        back,
        select: (notifications, viaKeyboard) => {
          const refocus = choiceRefocus(viaKeyboard);
          updateSettings({ ...state.settings, notifications }, refocus);
          // Asked when a choice needs it, never at launch: the system sheet
          // is the person's to trigger. Choosing again is the retry.
          if (notifications !== "off") {
            void notificationPermission(true).then((permission) => {
              syncPush();
              // Redraws only on a change, and keeps the row a keyboard
              // reached: the second draw must not drop what the first placed.
              if (state.notificationPermission === permission) return;
              setState({ notificationPermission: permission });
              refocusSettings(refocus);
            });
          } else {
            syncPush();
          }
        },
      });
    }
    if (page === "font-size") {
      return renderSettingsChoiceScreen<SettingsPreferences["fontSize"]>({
        title: "글꼴 크기",
        options: ([11, 12, 13, 14, 15] as const).map((fontSize) => ({
          value: fontSize,
          label: String(fontSize),
          selected: state.settings.fontSize === fontSize,
        })),
        note: "터미널 본문에 적용됩니다.",
        back,
        select: (fontSize, viaKeyboard) =>
          updateSettings({ ...state.settings, fontSize }, choiceRefocus(viaKeyboard)),
      });
    }
    return renderSettingsChoiceScreen<SettingsPreferences["scrollSpeed"]>({
      title: "스크롤",
      options: [
        {
          value: "slow",
          label: "느리게",
          selected: state.settings.scrollSpeed === "slow",
        },
        {
          value: "normal",
          label: "보통",
          selected: state.settings.scrollSpeed === "normal",
        },
        {
          value: "fast",
          label: "빠르게",
          selected: state.settings.scrollSpeed === "fast",
        },
      ],
      note: "터미널을 손가락으로 넘기는 동안의 속도에 적용됩니다. 손을 뗀 뒤의 관성은 시스템이 정합니다.",
      back,
      select: (scrollSpeed, viaKeyboard) =>
        updateSettings({ ...state.settings, scrollSpeed }, choiceRefocus(viaKeyboard)),
    });
  }

  async function resetDevice(): Promise<void> {
    if (state.screen.kind !== "settings" || state.screen.reset === "busy") return;
    connectionEpoch += 1;
    setState({
      screen: { kind: "settings", reset: "busy" },
      censusBusy: false,
      banner: undefined,
    });
    try {
      await ipc.resetDevice();
    } catch (error) {
      // A failed reset leaves the phone exactly as it was: the local stores
      // below are cleared only once the Rust side has forgotten its half.
      setState({ screen: { kind: "settings" }, banner: describeError(error) });
      queueMicrotask(() => settingsRow("reset")?.focus());
      return;
    }
    // This phone forgets everything, not just its hosts. The origin holds only
    // the four app-owned stores (settings, commands, recents, key strip) and no
    // dependency writes there, so a whole-origin clear is the one authority for
    // "this phone forgets" and covers a fifth store without another edit.
    // `Webview::clear_all_browsing_data()` would do the same from Rust, but it
    // is fire-and-forget on both platforms and unobservable in jsdom.
    try {
      localStorage.clear();
    } catch {
      // Private mode or a blocked store: nothing was kept to forget.
    }
    setState({
      screen: { kind: "home" },
      hubs: [],
      hubLayouts: {},
      hubSessions: {},
      servers: [],
      serverListings: {},
      reports: undefined,
      hostChecks: {},
      checkingHost: undefined,
      banner: undefined,
      settings: DEFAULT_SETTINGS_PREFERENCES,
      recents: [],
      commands: [],
      tray: keyTray.DEFAULT_GROUP,
      panel: "none",
      armed: undefined,
    });
  }

  /**
   * Asks the device which sensor it has, the first time the settings screen is
   * drawn. The answer is a fact about the phone and is kept for the run; the
   * row reads as unavailable until it lands.
   */
  let probingBiometry = false;
  function probeBiometryOnce(): void {
    if (state.biometry !== undefined || probingBiometry) return;
    probingBiometry = true;
    void biometricBridge()
      .then(probeBiometry, () => "unavailable" as const)
      .then((biometry) => {
        probingBiometry = false;
        setState({ biometry });
      });
  }

  /**
   * Reads the permission state whenever the settings screen is drawn, so a
   * refusal — or an allowance made in the system settings while the app was
   * away — reaches the row without a restart. Only reads; the system sheet
   * belongs to a choice. Redraws only on a change, or the redraw would probe again.
   */
  let probingNotifications = false;
  function probeNotificationPermission(): void {
    if (state.settings.notifications === "off" || probingNotifications) return;
    probingNotifications = true;
    void notificationPermission(false).then((permission) => {
      probingNotifications = false;
      if (state.notificationPermission !== permission) {
        setState({ notificationPermission: permission });
        syncPush();
      }
    });
  }

  /** A settings row by its stable id — where focus returns after a dialog on that row closes. */
  function settingsRow(id: string): HTMLButtonElement | null {
    return view.querySelector<HTMLButtonElement>(`.settings__row[data-row="${id}"]`);
  }

  /**
   * Hands a link to the system browser and, if that fails, says so where the
   * person is looking — the opener names the reason (a scope miss reads
   * "Not allowed to open url …"), and hiding it would leave a tap that does nothing.
   */
  async function openLink(url: string): Promise<void> {
    const failure = await openExternal(url);
    if (failure) setState({ banner: t("링크를 열지 못했습니다: {message}", { message: failure }) });
  }

  function renderSettings(): HTMLElement {
    const hosts = state.servers.map((server) => server.label);
    return renderSettingsScreen(
      {
        computers: sortHubs(state.hubs).map(hubTitle),
        hosts,
        preferences: state.settings,
        keyStripCount: keyTray.groupKeys(state.tray).length,
        commandCount: state.commands.length,
        biometry: state.biometry ?? "unavailable",
        // Drawn as granted until the probe answers: the row warns only on a known state.
        notificationPermission: state.notificationPermission ?? "granted",
      },
      {
        back: nativeBack.bind(() => setState({ screen: { kind: "home" } })),
        openComputers: () => setState({ screen: { kind: "computers" } }),
        openHosts: () => setState({ screen: { kind: "servers" } }),
        resetDevice: () => setState({ screen: { kind: "settings", reset: "confirm" } }),
        openLanguage: () => setState({ screen: { kind: "settings-choice", page: "language" } }),
        openNotifications: () =>
          setState({
            screen: { kind: "settings-choice", page: "notifications" },
          }),
        openFontSize: () => setState({ screen: { kind: "settings-choice", page: "font-size" } }),
        openScroll: () => setState({ screen: { kind: "settings-choice", page: "scroll" } }),
        clearCommands: () => setState({ screen: { kind: "settings", clearCommands: "confirm" } }),
        openKeyStrip: () =>
          setState({
            screen: { kind: "key-strip", returnTo: { kind: "settings" } },
          }),
        openHelp: () => void openLink(HELP_URL),
        sendFeedback: () =>
          void openLink(
            feedbackUrl({ version: packageMetadata.version, userAgent: navigator.userAgent }),
          ),
        toggleHaptics: () => {
          const haptics = !state.settings.haptics;
          updateSettings({ ...state.settings, haptics }, rowRefocus("haptics"));
          // The one preview a setting with no visible effect can give.
          keyTapFeedback(haptics);
        },
        toggleApprovalBiometric: () => void toggleApprovalBiometric(),
      },
    );
  }

  /**
   * Arming and disarming the gate both go through the sheet: if turning it
   * off were a plain tap, the lock would remove itself for whoever holds the
   * phone.
   */
  async function toggleApprovalBiometric(): Promise<void> {
    const current = state.settings.approvalBiometric;
    const refocus = rowRefocus("face-id");
    const check = await confirmOwner(
      await biometricBridge(),
      t(
        current
          ? "settings.security.disableApprovalBiometricReason"
          : "settings.security.enableApprovalBiometricReason",
      ),
    );
    if (check === "passed") {
      updateSettings({ ...state.settings, approvalBiometric: !current }, refocus);
      return;
    }
    if (check === "cancelled") return;
    setState({ banner: t("settings.security.biometricFailed") });
  }

  /**
   * Adding a host by hand, and reaching it.
   *
   * The save is what proves the address answers — there is nothing to check
   * before it, because the host key this phone will pin is the host's to give.
   * A failure stays on the screen as the frame's card (3177:82150) rather than
   * the app's banner: the fix is in the fields under it or on the host, and a
   * banner at the top would read as a fact about the screen.
   */
  function renderSshHostAdd(
    screen: Extract<Screen, { kind: "ssh-host-add" }>,
  ): HTMLElement {
    const returnTo: Screen = screen.returnTo ?? { kind: "servers" };
    return renderSshHostAddScreen(
      { form: screen.form, saving: screen.saving, failure: screen.failure },
      {
        back: nativeBack.bind(() => setState({ screen: returnTo }), screen.saving),
        importKey: () => pickPrivateKey(),
        // Recorded, not rendered — a render between two keystrokes replaces the
        // field being typed into. The failure goes with the same keystroke: it
        // was about the address as it stood, and that is what is changing.
        edit: (form) => writeState({ screen: { ...screen, form, failure: undefined } }),
        save: (form) => void addSshHost({ ...screen, form }, returnTo),
      },
    );
  }

  /**
   * The system file picker, and the one file it grants.
   *
   * A failed read is a banner rather than the form's card: the card is about
   * reaching the host, and this did not get that far — the file is the thing
   * that was wrong.
   */
  async function pickPrivateKey(): Promise<
    { privateKeyPem: string; fileName: string } | undefined
  > {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, directory: false });
      if (typeof path !== "string") return undefined;
      const privateKeyPem = await ipc.readSshPrivateKey(path);
      return { privateKeyPem, fileName: path.split("/").pop() ?? path };
    } catch (error) {
      setState({ banner: describeError(error) });
      return undefined;
    }
  }

  async function addSshHost(
    screen: Extract<Screen, { kind: "ssh-host-add" }>,
    returnTo: Screen,
  ): Promise<void> {
    const fields = sshHostFields(screen.form);
    if (!fields || screen.saving) return;
    setState({ screen: { ...screen, saving: true, failure: undefined } });
    try {
      const { auth, ...rest } = fields;
      const id = crypto.randomUUID();
      const added = await ipc.addSshHost({
        id,
        ...rest,
        // The file name is the screen's business, not the host's.
        auth:
          auth.kind === "imported"
            ? { kind: "imported", privateKeyPem: auth.privateKeyPem }
            : auth,
      });
      // 추가한 상자는 그 자리에서 목록에 선다. 저장이 끝났는데 목록이 예전
      // 것이면, 방금 한 일이 되지 않은 것으로 보인다.
      //
      // A key this phone just made is one the host has never seen: the next
      // screen is the public key, so the line can be registered before the
      // first connect. A password installed it already; an imported key was
      // the host's to begin with. Both go back where they came from.
      setState({
        screen:
          auth.kind === "device"
            ? { kind: "keys", serverId: id, drafts: EMPTY_HOST_KEYS_DRAFT, returnTo }
            : returnTo,
        servers: sortServers(added.listing.servers),
        banner: undefined,
      });
      if (auth.kind === "device") readPublicKey(id);
      // 방금 추가한 상자가 무엇을 들고 있는지 바로 묻는다 — 목록에만 서고
      // 세션이 비어 있으면, 붙었는지 아닌지를 사람이 판단할 수 없다.
      void census();
    } catch (error) {
      setState({
        screen: {
          ...screen,
          saving: false,
          failure: {
            title: t("{label}에 연결할 수 없음 — 포트 {port} 응답 없음", {
              label: fields.label,
              port: String(fields.port),
            }),
            detail: t("호스트가 켜져 있는지, 공개 키가 등록됐는지 확인하세요."),
          },
        },
        // 카드가 무엇이 잘못됐는지 말하고, 배너는 그것이 정확히 무엇이었는지
        // 말한다 — 포트가 닫힌 것과 키가 거부된 것은 고치는 곳이 다르다.
        banner: describeError(error),
      });
    }
  }

  function renderServers(): HTMLElement {
    return renderHostListScreen(
      {
        hosts: state.servers.map((server) => {
          const report = state.reports?.find((candidate) => candidate.server_id === server.id);
          const check = state.hostChecks[server.id];
          return {
            id: server.id,
            label: server.label,
            endpoint: formatEndpoint(server),
            disconnected: check
              ? !check.reachable
              : report !== undefined && report.outcome.state !== "listed",
          };
        }),
      },
      {
        back: nativeBack.bind(() => setState({ screen: { kind: "settings" } })),
        open: openHostDetail,
        add: () => setState({ screen: { kind: "ssh-host-add", form: EMPTY_SSH_HOST_FORM } }),
      },
    );
  }

  /**
   * One host's detail, and the check that tells whether it answers.
   *
   * No check for a row without a pin: the relay refuses to dial without one,
   * so the 5 s retry loop would only ever fail, and the status line already
   * says why.
   */
  function openHostDetail(id: string, returnTo?: Screen): void {
    const server = state.servers.find((candidate) => candidate.id === id);
    if (!server) return;
    setState({
      screen: { kind: "form", draft: entryToDraft(server), returnTo },
    });
    if (server.host_key_fingerprint.trim() === "") return;
    const check = state.hostChecks[id];
    if (!check) void checkHost(id);
    else if (!check.reachable) scheduleHostRetry(id);
  }

  /**
   * 설정 › 호스트 › SSH 키. The public key is read back from the stored
   * private key rather than carried anywhere: the key is one fact with one
   * owner, and a copy kept beside it could only agree or lie.
   */
  function openHostKeys(id: string, returnTo?: Screen): void {
    setState({ screen: { kind: "keys", serverId: id, drafts: EMPTY_HOST_KEYS_DRAFT, returnTo } });
    readPublicKey(id);
  }

  /**
   * Reads the public half of the stored attach key into the keys screen —
   * when it opens, and again after a save replaces that key, so the line on
   * screen is always the key the phone dials with.
   */
  function readPublicKey(id: string): void {
    void ipc.serverPublicKey(id).then(
      (publicKey) => {
        if (state.screen.kind !== "keys" || state.screen.serverId !== id) return;
        setState({ screen: { ...state.screen, publicKey } });
      },
      (error) => {
        if (state.screen.kind !== "keys" || state.screen.serverId !== id) return;
        setState({ screen: { ...state.screen, publicKeyFailure: describeError(error) } });
      },
    );
  }

  /** Recorded, not rendered: a redraw between two keystrokes would replace the textarea. */
  function editKeysDraft(id: string, role: KeyRole, text: string): void {
    if (state.screen.kind !== "keys" || state.screen.serverId !== id) return;
    writeState({ screen: { ...state.screen, drafts: withDraft(state.screen.drafts, role, text) } });
  }

  async function copyPublicKey(id: string): Promise<void> {
    if (state.screen.kind !== "keys" || state.screen.serverId !== id) return;
    const line = state.screen.publicKey;
    if (line === undefined) return;
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(line);
      if (state.screen.kind !== "keys" || state.screen.serverId !== id) return;
      setState({ screen: { ...state.screen, copied: true }, banner: undefined });
    } catch {
      // The selectable block above the button is the copy that always works.
      setState({ banner: t("복사하지 못했습니다 — 길게 눌러 선택하세요") });
    }
  }

  async function saveHostKey(id: string, role: KeyRole): Promise<void> {
    if (state.screen.kind !== "keys" || state.screen.serverId !== id) return;
    const pem = state.screen.drafts[role];
    try {
      const listing = await ipc.saveIdentity(id, role, pem);
      const screen = state.screen;
      const onKeys = screen.kind === "keys" && screen.serverId === id;
      // A saved attach key is a different key from the one whose public half
      // is on screen: that line — and its 복사됨 — go, and the new one is read.
      const rereadPublicKey = onKeys && role === "attach";
      setState({
        servers: sortServers(listing.servers),
        screen: onKeys
          ? {
              ...screen,
              drafts: clearDraft(screen.drafts, role),
              ...(rereadPublicKey
                ? { publicKey: undefined, publicKeyFailure: undefined, copied: undefined }
                : {}),
            }
          : screen,
        banner: undefined,
      });
      if (rereadPublicKey) readPublicKey(id);
    } catch (error) {
      setState({ banner: describeError(error) });
    }
  }

  /**
   * 호스트 제거, once confirmed or when no confirmation is due.
   *
   * The epoch bump is what stops a census or check already in flight from
   * writing this host back after the delete; the reset flow does the same.
   */
  async function removeHost(draft: ServerDraft): Promise<void> {
    if (!draft.id) return;
    if (state.screen.kind === "form" && state.screen.remove === "busy") return;
    if (hostRetryTimer !== undefined) window.clearTimeout(hostRetryTimer);
    hostRetryTimer = undefined;
    connectionEpoch += 1;
    const epoch = connectionEpoch;
    setState({
      screen:
        state.screen.kind === "form" && state.screen.remove
          ? { ...state.screen, remove: "busy" }
          : state.screen,
      checkingHost: draft.id,
      censusBusy: false,
    });
    try {
      const listing = await ipc.deleteServer(draft.id);
      if (epoch !== connectionEpoch) return;
      const visits = recents.forServers(
        state.recents,
        listing.servers.map((server) => server.id),
      );
      recents.save(visits);
      setState({
        screen: { kind: "servers" },
        servers: sortServers(listing.servers),
        recents: visits,
        checkingHost: undefined,
        reports: state.reports?.filter((report) => report.server_id !== draft.id),
        serverListings: Object.fromEntries(
          Object.entries(state.serverListings).filter(([id]) => id !== draft.id),
        ),
        hostChecks: Object.fromEntries(
          Object.entries(state.hostChecks).filter(([id]) => id !== draft.id),
        ),
        banner: undefined,
      });
    } catch (error) {
      if (epoch !== connectionEpoch) return;
      setState({
        screen:
          state.screen.kind === "form" && state.screen.remove
            ? { ...state.screen, remove: undefined }
            : state.screen,
        checkingHost: undefined,
        banner: describeError(error),
      });
    }
  }

  /**
   * 잊기 on a paired computer.
   *
   * The epoch bump comes first: the census snapshots `state.hubs` when it
   * starts and writes that computer's sessions back under the epoch guard
   * alone, so a forget without the bump gets its sessions resurrected by an
   * answer already on the way. The store snapshot is the authority on the
   * list afterwards — `refreshHubs` reads it rather than filtering locally.
   */
  async function forgetHub(id: string): Promise<void> {
    if (state.screen.kind !== "computers" || !state.screen.forget || state.screen.forget.busy) {
      return;
    }
    connectionEpoch += 1;
    setState({ screen: { kind: "computers", forget: { id, busy: true } }, censusBusy: false });
    try {
      await ipc.hubForget(id);
      const { [id]: _forgotten, ...hubSessions } = state.hubSessions;
      setState({ hubSessions });
      await refreshHubs();
      setState({ screen: { kind: "computers" }, banner: undefined });
    } catch (error) {
      setState({ screen: { kind: "computers" }, banner: describeError(error) });
    }
  }

  function scheduleHostRetry(id: string): void {
    if (hostRetryTimer !== undefined) window.clearTimeout(hostRetryTimer);
    hostRetryTimer = window.setTimeout(() => {
      hostRetryTimer = undefined;
      if (state.screen.kind === "form" && state.screen.draft.id === id) void checkHost(id);
    }, 5_000);
  }

  async function checkHost(id: string): Promise<void> {
    if (state.checkingHost === id) return;
    if (hostRetryTimer !== undefined) window.clearTimeout(hostRetryTimer);
    hostRetryTimer = undefined;
    const epoch = connectionEpoch;
    setState({ checkingHost: id });
    let reachable = true;
    try {
      await ipc.discoverSessions(id);
    } catch {
      reachable = false;
    }
    if (epoch !== connectionEpoch) return;
    setState({
      checkingHost: undefined,
      hostChecks: {
        ...state.hostChecks,
        [id]: { reachable, checkedAt: Date.now() },
      },
    });
    if (!reachable) scheduleHostRetry(id);
  }

  async function persistServerDraft(next: ServerDraft, returnTo: Screen): Promise<void> {
    const normalized = {
      ...next,
      label: next.label.trim() || next.host.trim(),
    };
    const result = draftToEntry(normalized, () => crypto.randomUUID());
    if (!result.ok) {
      // The detail screen has no field for the fingerprint, so a malformed
      // stored pin is the one error it cannot show inline — the banner says it.
      const first = result.errors[0];
      setState({
        screen: { kind: "form", draft: next, returnTo },
        banner: first ? errorText(first) : state.banner,
      });
      return;
    }
    if (hostRetryTimer !== undefined) window.clearTimeout(hostRetryTimer);
    hostRetryTimer = undefined;
    connectionEpoch += 1;
    const epoch = connectionEpoch;
    setState({
      screen:
        state.screen.kind === "form" ? { ...state.screen, draft: next } : state.screen,
      checkingHost: result.entry.id,
      censusBusy: false,
    });
    try {
      const listing = await ipc.saveServer(result.entry);
      if (epoch !== connectionEpoch) return;
      setState({
        screen: returnTo,
        servers: sortServers(listing.servers),
        checkingHost: undefined,
        reports: state.reports?.filter((report) => report.server_id !== result.entry.id),
        // Forget what it listed too. A server the user just edited away must
        // not keep haunting the list through the memory that exists for
        // servers that are merely quiet.
        serverListings: Object.fromEntries(
          Object.entries(state.serverListings).filter(([id]) => id !== result.entry.id),
        ),
        hostChecks: Object.fromEntries(
          Object.entries(state.hostChecks).filter(([id]) => id !== result.entry.id),
        ),
        banner: undefined,
      });
    } catch (error) {
      if (epoch !== connectionEpoch) return;
      setState({ checkingHost: undefined, banner: describeError(error) });
    }
  }

  /**
   * 그 상자에서 세션 하나를 시작하고, 되면 바로 붙는다.
   *
   * 노트북을 거치지 않는다 — 폰은 이 상자에 SSH 로 직접 닿고, 시작만 노트북을
   * 거치던 것은 게이트웨이가 강제 명령 키의 생성을 거절했기 때문이다. 운영자가
   * 그 줄에 `--allow-create` 를 켜면 열린다.
   *
   * 거절은 배너로 그대로 보여준다. 가장 흔한 거절이 "켜지 않았다"이고, 그
   * 문장이 어느 플래그인지 말하므로 우리 말로 바꿔 적으면 정보가 준다.
   */
  async function startSessionOn(draft: ServerDraft): Promise<void> {
    const serverId = draft.id;
    if (!serverId || state.startingServer) return;
    setState({ startingServer: serverId, banner: undefined });
    try {
      const outcome = await ipc.sshCreateSession(serverId);
      if (!outcome.started || !outcome.session) {
        setState({
          startingServer: undefined,
          banner: outcome.detail ?? t("이 서버에서 세션을 시작하지 못했습니다"),
        });
        return;
      }
      setState({ startingServer: undefined });
      await openSession(
        { kind: "ssh", id: serverId, label: draft.label || draft.host },
        outcome.session,
        { kind: "form", draft, returnTo: { kind: "servers" } },
      );
    } catch (error) {
      setState({ startingServer: undefined, banner: describeError(error) });
    }
  }

  function renderForm(draft: ServerDraft, returnTo: Screen = { kind: "servers" }): HTMLElement {
    const id = draft.id ?? "";
    const check = state.hostChecks[id];
    // Checking first: a save in flight must never read as unpinned.
    const status =
      state.checkingHost === id
        ? "checking"
        : draft.hostKeyFingerprint.trim() === ""
          ? "unpinned"
          : check?.reachable
            ? "connected"
            : check
              ? "retrying"
              : "checking";
    return renderHostDetailScreen(
      {
        draft,
        status,
        checkedAt: check?.checkedAt,
        starting: state.startingServer === id,
      },
      {
        back: nativeBack.bind(() => setState({ screen: returnTo })),
        save: (next) => void persistServerDraft(next, returnTo),
        retry: () => void checkHost(id),
        startSession: () => void startSessionOn(draft),
        openKeys: () => openHostKeys(id, returnTo),
        // A paired entry asks first: its key was installed by the laptop and
        // cannot be put back from here. One typed in can be typed in again.
        remove: () => {
          if (draft.paired && state.screen.kind === "form") {
            setState({ screen: { ...state.screen, remove: "confirm" } });
            return;
          }
          void removeHost(draft);
        },
      },
    );
  }


  /**
   * 서버 한 대의 세션 목록. 그림은 `sessionListView`가 그리고 여기는 배선만 한다.
   *
   * 홈에서 서버를 누르면 조사에서 받아 둔 목록을 들고 들어오므로, 보통 이 화면은
   * 이미 채워진 상태로 열린다. 조회 버튼은 그것을 갱신하는 용도로 남는다.
   */
  function renderServerSessions(
    screenState: Extract<Screen, { kind: "server-sessions" }>,
  ): HTMLElement {
    const { server, sessions, filter, busy } = screenState;

    async function discover(): Promise<void> {
      setState({
        screen: {
          kind: "server-sessions",
          server,
          sessions,
          filter,
          busy: true,
        },
        banner: undefined,
      });
      try {
        const discovered = await ipc.discoverSessions(server.id);
        setState({
          screen: {
            kind: "server-sessions",
            server,
            sessions: discovered,
            filter,
            busy: false,
          },
        });
      } catch (error) {
        // 이전 목록을 그대로 남긴다. 갱신에 실패한 것을 목록이 사라지는 것으로
        // 표현하면, 사용자는 세션이 죽었다고 읽는다 — 무엇이 실패했는지는
        // 배너가 말한다.
        setState({
          screen: {
            kind: "server-sessions",
            server,
            sessions,
            filter,
            busy: false,
          },
          banner: describeError(error),
        });
      }
    }

    return renderSessionList(
      { server, sessions, filter, busy, opening: state.opening },
      {
        back: nativeBack.bind(() => setState({ screen: { kind: "home" } })),
        refresh: () => void discover(),
        setFilter: (next) =>
          setState({
            screen: {
              kind: "server-sessions",
              server,
              sessions,
              filter: next,
              busy,
            },
          }),
        open: (session) =>
          void openSession(
            { kind: "ssh", id: server.id, label: server.label },
            session,
            screenState,
          ),
      },
    );
  }

  // ----------------------------------------------------------------- 터미널

  /** 그림은 `sessionScreen`이 그리고 여기는 배선만 한다. */
  function renderTerminal(screenState: Extract<Screen, { kind: "terminal" }>): HTMLElement {
    const { source, session, attached, returnTo } = screenState;
    const attachmentId = attached.terminal.attachment_id;
    const canInput = () =>
      attached.role === "controller" && liveAttachment(state.screen) === attachmentId &&
      state.terminalUnavailable?.attachmentId !== attachmentId;

    return renderSessionScreen(
      {
        machineLabel: source.label,
        trail: sessionTrail(session.session_id),
        branch: currentBranch(session.session_id),
        ...(screenState.watchReason === undefined ? {} : { watchReason: screenState.watchReason }),
        session,
        attached,
        runtime: state.terminalRuntime?.attachmentId === attachmentId
          ? state.terminalRuntime.runtime : undefined,
        unavailable: state.terminalUnavailable?.attachmentId === attachmentId
          ? state.terminalUnavailable.detail : undefined,
        panel: state.panel,
        tray: keyTray.groupKeys(state.tray),
        armed: state.armed,
        history: state.commands,
        siblings: siblingSessions(session.session_id),
        viewOptions: state.homeOptions ?? loadHomeViewOptions(),
        nowMs: Date.now(),
        opening: state.opening,
        haptics: state.settings.haptics,
      },
      {
        back: nativeBack.bind(() => {
          void (async () => {
            await leaveTerminal(attached.terminal.attachment_id);
            setState({ screen: returnTo, panel: "none", armed: undefined });
          })();
        }),
        transcript: stage => transcriptHost(attached, session, stage),
        enableInput: () => {
          void openSession(source, session, returnTo, "reconnect");
        },
        press: (keyId) => {
          if (!canInput()) return;
          const outcome = pressKey(keyId, state.armed);
          sendPress(outcome);
          if (outcome.armed === state.armed) return;
          // Painted, not rendered: a render replaces the tree, and the field
          // holding the OS keyboard up goes with it. Arming Ctrl is a press
          // somebody makes *while* typing, so it must not put the keys away.
          writeState({ armed: outcome.armed });
          paintArmedKey(document, outcome.armed);
        },
        type: (text) => {
          if (canInput()) sendText(text);
        },
        paste: content => { if (canInput()) return surface?.paste(content); },
        nativeKey: (event) => {
          if (canInput()) sendNativeKey(event);
        },
        draft: () => commandDraft,
        submit: () => {
          if (!canInput()) return;
          sendEnter();
        },
        runCommand: (text) => {
          if (canInput()) sendLine(text);
        },
        togglePanel: (panel) => openTrayPanel(state.panel === panel ? "none" : panel),
        openSession: (row) => {
          const origin: SessionSource =
            row.source.kind === "ssh"
              ? {
                  kind: "ssh",
                  id: row.source.serverId,
                  label: row.source.serverLabel,
                }
              : {
                  kind: "hub",
                  id: row.source.hubId,
                  label: row.source.session.box_label.trim() || row.source.hubLabel,
                  boxId: row.source.session.box_id,
                };
          void openSession(origin, row.source.session, returnTo);
        },
        openSourceControl: () => {
          // 이 줄이 어느 목록에서 왔는지가 아니라, 이 세션을 아는 컴퓨터가
          // 누구인지로 정한다.
          const hubId =
            hubKnowing(Object.values(state.hubSessions), session.session_id) ??
            (source.kind === "hub" ? source.id : undefined);
          // 이 줄이 아는 상자를 그대로 들고 간다.
          //
          // 허브 줄도 어느 상자인지 이미 안다 — `box_id` 는 노트북이 그 호스트에
          // 붙인 id 이고, 페어링이 폰의 `ServerEntry.id` 로 **같은 값**을 넣어
          // 준다(`inventory.rs` → `pairing.rs`). 그래서 노트북이 "그 세션은 다른
          // 컴퓨터에서 돈다" 고 답할 때 물어볼 상자는 이미 이 줄에 있다. 이걸
          // 화면에서 버리면 그 폴백은 영영 걸리지 않는다.
          //
          // 조사 목록을 뒤지지 않는 이유: 이 값은 줄을 만들 때 확정됐고,
          // 목록은 낡을 수 있다. 워크스페이스 id 는 그 목록이 준 값을 쓴다.
          const ask = {
            serverId: source.kind === "ssh" ? source.id : source.boxId,
            workspaceId: session.workspace_id,
            label: source.label,
          };
          const screen: Extract<Screen, { kind: "source-control" }> = {
            kind: "source-control",
            title: sessionTitle(session),
            ...(hubId === undefined ? {} : { hubId }),
            ask,
            sessionId: session.session_id,
            changes: { kind: "loading" },
            returnTo: state.screen,
          };
          setState({ screen });
          void loadChanges(screen);
        },
      },
    );
  }

  /** Put the reset question away, optionally alongside the answer to it. */
  function closeKeyStripConfirm(also: Partial<State> = {}): void {
    if (state.screen.kind !== "key-strip") return;
    setState({ ...also, screen: { ...state.screen, confirm: undefined } });
  }

  function renderKeyStrip(screenState: Extract<Screen, { kind: "key-strip" }>): HTMLElement {
    const { added, scrollTop } = screenState;
    return renderKeyStripScreen(
      { group: state.tray, added, scrollTop },
      {
        back: nativeBack.bind(() => setState({ screen: screenState.returnTo })),
        // Written without a redraw — rebuilding the screen under a scrolling
        // finger is what `writeState` exists to avoid.
        remember: (top) => {
          if (state.screen.kind !== "key-strip") return;
          writeState({ screen: { ...state.screen, scrollTop: top } });
        },
        // Saved before the redraw: the screen's preview *is* the saved strip,
        // and a preview drawn from something not yet written is a second strip.
        // The screen state is read fresh rather than closed over, because
        // `remember` has been writing to it since this screen was drawn.
        edit: (next, justAdded) => {
          if (state.screen.kind !== "key-strip") return;
          keyTray.save(next);
          setState({
            tray: next,
            screen: { ...state.screen, added: justAdded },
          });
        },
        askReset: () => {
          if (state.screen.kind !== "key-strip") return;
          setState({ screen: { ...state.screen, confirm: true } });
        },
      },
    );
  }

  /**
   * Send one typed line and remember it.
   *
   * History records attempts, not delivery acknowledgements. A transport
   * rejection can arrive after recording; that uncertain attempt stays, but
   * reconnecting never runs it again without an explicit history-row press.
   */
  function sendLine(text: string): void {
    const screen = state.screen;
    if (screen.kind !== "terminal") return;
    if (screen.attached.role !== "controller") return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (!surface) return;
    sendText(trimmed);
    sendEnter();
  }

  /**
   * Remember a line for the command drawer.
   *
   * Split out of `sendLine` because a line typed on the OS keyboard reaches the
   * session character by character — there is no single send to hang this on,
   * only the Enter that ends it.
   */
  function recordCommand(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const kept = commandHistory.withCommand(state.commands, trimmed, Date.now());
    commandHistory.save(kept);
    // A line is recorded by the Enter that ends it, which is a keystroke —
    // rendering here would replace the field it was typed in and take the
    // keyboard down between one command and the next. Nothing on screen shows
    // the list unless its drawer is open, so only that case redraws.
    writeState({ commands: kept });
    if (state.panel === "history") render();
  }

  /**
   * The other sessions this phone could open, grouped as the sidebar groups
   * them. The one being looked at stays in the list — a switcher that hides
   * where you are reads as one that lost it.
   */
  function siblingSessions(currentId: string) {
    const projected = projectHome({
      census: state.reports ? mergeSessions(state.reports, state.serverListings) : [],
      hubs: Object.values(state.hubSessions),
      layout: mergeLayouts(state.hubLayouts),
    }, state.homeOptions ?? loadHomeViewOptions(), Date.now());
    return projected.groups.map(group => ({...group, rows: group.rows.filter(
      ({row}) => row.sessionId === currentId || sourceOpenable(row.source),
    )})).filter(group => group.rows.length > 0);
  }

  /**
   * The transcript node for this attach, created once and reused.
   *
   * The mount is deferred to a microtask because the surface measures the node
   * to choose a grid, and a node that is not in a laid-out document measures
   * zero.
   */
  function transcriptHost(attached: AttachedSession, session: RemoteSession, stage: HTMLElement): HTMLElement {
    const id = attached.terminal.attachment_id;
    const existing = transcriptNode;
    if (existing && transcriptAttachment === id) {
      if (surface) stage.append(surface.scrollToBottomButton);
      return existing;
    }
    surface?.dispose();
    surface = undefined;
    approvalGate?.reset();
    approvalGate = undefined;
    const host = element("div", "terminal session__terminal");
    transcriptNode = host;
    transcriptAttachment = id;
    queueMicrotask(() => mountSession(attached, session, host));
    return host;
  }

  function mountSession(
    attached: AttachedSession,
    session: RemoteSession,
    host: HTMLElement,
  ): void {
    const terminal = attached.terminal;
    if (transcriptAttachment !== terminal.attachment_id ||
      liveAttachment(state.screen) !== terminal.attachment_id) return;
    // One gate per attachment: the approval it proves belongs to this agent,
    // and the surface it guards is disposed with the attachment.
    const gate = createApprovalGate({
      enabled: () => state.settings.approvalBiometric,
      confirm: async () =>
        confirmOwner(await biometricBridge(), t("approval.biometricRequired")),
      // Named by outcome: a sheet the system could not show, or a face it did
      // not accept, is not something the owner cancelled.
      refused: (check) =>
        setState({
          banner:
            check === "cancelled"
              ? t("approval.biometricCancelled")
              : check === "unavailable"
                ? t("approval.biometricUnavailable")
                : t("approval.biometricFailedToSend"),
        }),
    });
    approvalGate = gate;
    // Same records, read for what changed while the app was off screen.
    const notifier = createNotificationObserver({
      preference: () => state.settings.notifications,
      hidden: () => state.pushSync?.kind === "unsupported" && document.visibilityState === "hidden",
      session: sessionTitle(session),
      notify: (notification) => void sendLocalNotification(notification),
    });
    surface = mountStructuredTerminal(
      host,
      terminal,
      {
        next: () => ipc.nextTerminalRecord(terminal.attachment_id),
        send: (record) => ipc.sendTerminalRecord(terminal.attachment_id, record),
      },
      {
        writable: attached.role === "controller",
        grantedCapabilities: attached.granted_capabilities,
        pasteActive: () => state.screen.kind === "terminal" && liveAttachment(state.screen) === terminal.attachment_id,
        stageClipboardImage: async file => {
          const hubId = hubKnowing(Object.values(state.hubSessions), session.session_id) ??
            (state.screen.kind === "terminal" && state.screen.source.kind === "hub" ? state.screen.source.id : undefined);
          if (!hubId) throw new Error(t("terminal.paste.desktopRequired"));
          return ipc.hubStageSessionFile(hubId, session.session_id, file);
        },
        onPasteText: text => { commandDraft += text; },
        onUnavailable: (detail) => {
          if (transcriptAttachment !== terminal.attachment_id ||
            liveAttachment(state.screen) !== terminal.attachment_id) return;
          gate.reset();
          setState({ terminalUnavailable: { attachmentId: terminal.attachment_id, detail } });
        },
        onAgentRuntimeState: (runtime) => {
          if (transcriptAttachment !== terminal.attachment_id ||
            liveAttachment(state.screen) !== terminal.attachment_id ||
            state.terminalUnavailable?.attachmentId === terminal.attachment_id) return;
          writeState({ terminalRuntime: { attachmentId: terminal.attachment_id, runtime } });
          if (state.screen.kind === "terminal") paintSessionState(view, { session, runtime });
          gate.observe(runtime);
          notifier.observe(runtime);
        },
        guardInput: gate.admit,
        trackpadDirection: (direction, fast) => showTrackpadDirection(document, direction, fast),
        // Looked up on each tap rather than captured: the tray is redrawn and
        // this surface is not, so a held reference would be to a field that
        // left the tree — and a detached field raises no keyboard.
        focusField: () => {
          const box = document.querySelector<HTMLTextAreaElement>(".tray__box");
          if (!box || box.disabled) return false;
          box.focus();
          return true;
        },
      },
    );
    host.parentElement?.append(surface.scrollToBottomButton);
  }

  function sendText(text: string): void {
    if (!surface) return;
    commandDraft += text;
    surface.sendText(text);
  }

  function sendPress(press: KeyPress): void {
    const intent = press.intent;
    if (!surface || !intent) return;
    if (intent.kind === "text") {
      sendText(intent.text);
      return;
    }
    // `code` is the physical key and therefore the Host's lookup authority;
    // `key` is only the text that key produced.
    sendNativeKey({
      key: intent.key,
      code: intent.code,
      ctrlKey: intent.ctrlKey,
      altKey: intent.altKey,
      shiftKey: intent.shiftKey,
      metaKey: false,
      repeat: false,
      getModifierState: () => false,
    });
  }

  function sendNativeKey(event: Parameters<NonNullable<typeof surface>["sendKey"]>[0]): void {
    if (!surface) return;
    if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      if (event.key === "Enter") { sendEnter(); return; }
      if (event.key === "Backspace") commandDraft = [...commandDraft].slice(0, -1).join("");
    }
    surface.sendKey(event);
  }

  function sendEnter(): void {
    const screen = state.screen;
    if (!surface || screen.kind !== "terminal") return;
    const line = commandDraft;
    commandDraft = "";
    surface.sendKey({
      key: "Enter",
      code: "Enter",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      repeat: false,
      getModifierState: () => false,
    });
    if (state.terminalUnavailable?.attachmentId !== screen.attached.terminal.attachment_id) {
      recordCommand(line);
    }
  }

  // 기기를 돌리거나 키보드가 오르내리면 보이는 크기가 바뀐다. 화면 전환마다
  // 붙였다 떼는 대신 앱 수명 동안 하나만 건다 — `surface`가 없으면 아무 일도
  // 하지 않고, 있으면 맞추고 그 결과가 세션까지 간다.
  //
  // `visualViewport`는 키보드가 덮은 높이까지 반영하는 유일한 신호다. iOS에서
  // `window.resize`는 키보드가 올라올 때 오지 않는다.
  /**
   * How tall the part of the page a person can actually see is.
   *
   * The OS keyboard covers the bottom of the window without changing `100vh`,
   * so a screen sized in `vh` puts its tray underneath the keyboard — exactly
   * the row somebody needs while typing. `visualViewport` is the only signal
   * that shrinks with the keyboard.
   *
   * Published as a variable rather than applied to a node so the session
   * screen can use it and every other screen keeps scrolling the document the
   * way it always has.
   */
  const publishViewport = () => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement.style;
    root.setProperty("--app-viewport-height", `${Math.round(viewport.height)}px`);
    // # Why the offset matters as much as the height
    //
    // A page that cannot scroll gives iOS nowhere to put the focused field, so
    // it slides the *visual* viewport over the layout viewport instead. Nothing
    // in the document moves and `scrollY` stays 0, but everything drawn at
    // layout y=0 is now above the visible area — a screen sized to the visible
    // height then ends that far short of the keyboard. That gap is this number.
    root.setProperty("--app-viewport-top", `${Math.round(viewport.offsetTop)}px`);

    // The slide as it stands, which is not the same question as "are the keys
    // up": the drawer hands its space over *while* the keyboard arrives, so it
    // needs the number long before it clears the threshold. `keyboardCoverage`
    // answers the other question, below.
    const slide = window.innerHeight - viewport.height;
    // The tray pill lights one of its three at a time, and the drawer stands
    // in the strip the keyboard is taking. Whoever raises the keyboard wins —
    // the transcript's own field included — so the drawer yields as the
    // keyboard comes, and the model says so the moment it is gone.
    const tray = state.screen.kind === "terminal" && state.panel !== "none";
    if (tray && yieldTrayDrawer(document, slide)) {
      writeState({ panel: "none" });
    }
    const covered = keyboardCoverage();
    keyboardHeight.observe(covered);
    if (covered > 0) {
      document.documentElement.setAttribute("data-keyboard", "on");
      finishHandoverSoon();
    } else {
      document.documentElement.removeAttribute("data-keyboard");
      cancelHandover();
      // The space is free now, so a drawer that was waiting for it opens.
      if (pendingPanel !== undefined) {
        const panel = pendingPanel;
        pendingPanel = undefined;
        setState({ panel });
      }
    }

    // The keys change what stands on the transcript twice over — they cover the
    // window, and the tray above them stops clearing a home indicator they are
    // already covering — and neither goes through a render. Republished after
    // the attribute, so the tray measured here is the one the keys leave.
    publishTranscriptLift(document.documentElement, {
      tray: document.querySelector(".tray"),
      drawer: document.querySelector(".tray__panel"),
      covered,
      stage: document.querySelector(".session__stage"),
    });
  };
  publishViewport();

  const refit = () => {
    publishViewport();
    // iOS scrolls the window itself to bring a focused field into view. On the
    // session screen there is nothing to bring into view — the layout already
    // shrank to the keyboard — and the leftover scroll is what shows up as the
    // whole page sitting a few dozen pixels too high.
    if (document.documentElement.getAttribute("data-screen") === "session") {
      window.scrollTo(0, 0);
    }
    if (state.screen.kind !== "terminal") return;
    surface?.fit();
  };
  window.addEventListener("resize", refit);
  window.visualViewport?.addEventListener("resize", refit);
  // The visual viewport slides without resizing — that move is the whole of the
  // gap above the keyboard, so it has to be followed too. Through `refit` and
  // not `publishViewport` alone: a slide is where the keyboard is noticed, and
  // noticing it changes the tray's own inset, so the size the session was given
  // is stale from that moment until something else resizes.
  window.visualViewport?.addEventListener("scroll", refit);

  render();
  void (async () => {
    // 컴퓨터 목록이 먼저다. 로컬 파일 하나를 읽는 일이라 즉시 끝나고, 이게
    // 없으면 앱을 켤 때마다 첫 화면이 "컴퓨터를 연결하세요"로 떠서 이미
    // 페어링한 사람이 다시 스캔하러 간다.
    await refreshHubs();
    if (disposed) return;
    await refresh();
    if (disposed) return;
    if (state.servers.length > 0 || state.hubs.length > 0) await census();
  })();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    nativeBack.dispose();
    pushSync.dispose();
    document.removeEventListener("visibilitychange", refreshPushOnForeground);
    connectionEpoch += 1;
    sessionCensus.dispose();
    window.removeEventListener("resize", refit);
    window.visualViewport?.removeEventListener("resize", refit);
    window.visualViewport?.removeEventListener("scroll", refit);
    surface?.dispose();
    approvalGate?.reset();
    clearTimeout(hostRetryTimer);
    cancelHandover();
  };
  import.meta.hot?.dispose(dispose);
  return dispose;
}

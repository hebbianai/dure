/**
 * Design QA harness — renders the redesigned phone screens side by side at the
 * mockup's 402 x 874 so they can be compared against Figma without a hub, a
 * laptop, or the Tauri IPC layer behind them.
 *
 * Not shipped — `vite build` bundles `index.html` at the package root, and this
 * page is not reachable from it. It is still typechecked and linted with
 * everything else (`tsconfig.json` include, `biome lint src qa`), because
 * TypeScript nobody compiles is TypeScript that rots.
 *
 * It lives here rather than in a scratch directory because it imports the real
 * view modules — a harness that reproduced their markup would drift from them
 * and start passing while the app was broken.
 *
 * Run: `pnpm --dir mobile qa:design`
 */

import "../src/styles.css";
import type { HubSessions } from "../src/allSessions";
import type { CensusActions, CensusModel } from "../src/censusView";
import { renderHomeScreen } from "../src/censusView";
import type { HubProbeSession } from "../src/ipc";
import iconPlusLarge from "../src/assets/icon-plus-lg.svg";
import { glyph } from "../src/dom";
import { renderAddSheet } from "../src/addSheetView";
import { renderKeyStripScreen } from "../src/keyStripView";
import { renderConfirmDialog } from "../src/confirmDialog";
import { DEFAULT_GROUP } from "../src/keyTray";
import type {
  ChangedFile,
  SourceControlActions,
  SourceControlModel,
} from "../src/sourceControlView";
import { renderSourceControl } from "../src/sourceControlView";
import type { FileDiffActions } from "../src/fileDiffView";
import { renderFileDiff } from "../src/fileDiffView";
import { renderCommitSheet } from "../src/scmSheets";
import type { LaunchOffer } from "../src/ipc";
import type { LaunchActions, LaunchModel } from "../src/launchView";
import { renderLaunchScreen } from "../src/launchView";
import type { FolderBrowserModel } from "../src/folderBrowser";
import type { FolderBrowserActions } from "../src/folderBrowserView";
import { renderFolderBrowserScreen } from "../src/folderBrowserView";

function session(id: string, name: string): HubProbeSession {
  return {
    session_id: id,
    session_name: name,
    workspace_id: "workspace_1",
    session_class: "standalone",
    lifecycle: "starting",
    provider_id: "claude-code",
    launch_program: null,
    runner_principal: "user",
    runner_instance: "i",
    channel_epoch: "e",
    host_instance_id: "h",
    terminal_epoch: "t",
    capabilities: [],
    ready: true,
    box_id: "this-laptop",
    box_label: "맥북",
  } satisfies HubProbeSession;
}

const TITLE = "결제 API 리트라이 로직 수정";

function hub(id: string, reachable: boolean, ids: string[]): HubSessions {
  return {
    hubId: id,
    hubLabel: "mac-studio.local",
    reachable,
    sessions: ids.map((sessionId) => session(sessionId, TITLE)),
  };
}

function seats(ids: string[], project: string) {
  return Object.fromEntries(
    ids.map((id, order) => [
      id,
      { desktop: "Workspace", project, order, branch: "worktree/card-tokens" },
    ]),
  );
}

const LIVE = ["a1", "a2", "a3", "a4"];
const OFF = ["b1", "b2", "b3", "b4"];
const MORE = ["c1", "c2", "c3", "c4"];

const noActions: CensusActions = {
  open: () => {},
  selectDesktop: () => {},
  pair: () => {},
  settings: () => {},
  refresh: () => {},
  hold: () => {},
};

function home(overrides: Partial<CensusModel> = {}): CensusModel {
  return {
    census: [],
    hubs: [hub("h1", true, LIVE), hub("h2", false, OFF), hub("h3", true, MORE)],
    layout: {
      placements: {
        ...seats(LIVE, "HebbianIDE"),
        ...seats(OFF, "HebbianIDE 2"),
        ...seats(MORE, "HebbianIDE 3"),
      },
      desktop_order: ["Workspace"],
    },
    failures: [],
    busy: false,
    emptyMessage: "실행 중인 세션이 없습니다",
    ...overrides,
  };
}

function frame(caption: string, ...nodes: HTMLElement[]): void {
  const figure = document.createElement("figure");
  const box = document.createElement("div");
  box.className = "frame";
  box.append(...nodes);
  figure.append(box);
  const label = document.createElement("figcaption");
  label.textContent = caption;
  figure.append(label);
  document.getElementById("rail")?.append(figure);
}

function fab(): HTMLElement {
  const button = document.createElement("button");
  button.className = "fab";
  button.type = "button";
  button.setAttribute("aria-label", "새로 만들기");
  button.append(glyph(iconPlusLarge, 24));
  return button;
}

frame(
  "3096:86209 home/default (재연결 중)",
  renderHomeScreen(home({ busy: true }), noActions),
  fab(),
);
frame("3096:86271 home/retry (다시 시도)", renderHomeScreen(home(), noActions), fab());
frame(
  "3096:86335 home/empty",
  renderHomeScreen(
    home({
      hubs: [{ hubId: "h1", hubLabel: "mac-studio.local", reachable: true, sessions: [] }],
      layout: { placements: {}, desktop_order: [] },
    }),
    noActions,
  ),
  fab(),
);
frame(
  "3096:86354 home + 추가",
  renderHomeScreen(home(), noActions),
  fab(),
  renderAddSheet({ dismiss: () => {}, startAgent: () => {}, addHost: () => {} }),
);

const LAUNCH_OFFER: LaunchOffer = {
  published: true,
  targets: [
    {
      id: "main hebbian",
      space_label: "Main",
      folder_label: "HebbianIDE",
      box_label: "",
      path_hint: "~/dev/hebbian-ide",
      startable: true,
    },
    {
      id: "main payments",
      space_label: "Main",
      folder_label: "Payments",
      box_label: "",
      path_hint: "~/dev/payments",
      startable: true,
    },
    {
      id: "main dure",
      space_label: "Main",
      folder_label: "Dure",
      box_label: "",
      path_hint: "~/dev/dure",
      startable: true,
    },
  ],
  kinds: [
    { id: "claude", label: "Claude Code", installed: true },
    { id: "codex", label: "Codex", installed: true },
    { id: "gemini", label: "Gemini", installed: true },
  ],
};

const launchActions: LaunchActions = {
  close: () => {},
  openMenu: () => {},
  selectSpace: () => {},
  selectFolder: () => {},
  selectKind: () => {},
  toggleWorktree: () => {},
  editBranch: () => {},
  addFolder: () => {},
  start: () => {},
  again: () => {},
  open: () => {},
};

function launchModel(menu?: LaunchModel["menu"]): LaunchModel {
  return {
    stage: { kind: "ready", offer: LAUNCH_OFFER },
    form: {
      spaceLabel: "Main",
      targetId: "main hebbian",
      kindId: "claude",
      useWorktree: true,
      branch: "agent/mobile-folder",
    },
    menu,
    boxLabel: "mac-mini",
  };
}

frame("3172:81560 새 에이전트", renderLaunchScreen(launchModel(), launchActions));
frame(
  "3177:82234 새 에이전트 · 폴더 선택",
  renderLaunchScreen(launchModel("folder"), launchActions),
);

const folderActions: FolderBrowserActions = {
  close: () => {},
  toggleHost: () => {},
  selectHost: () => {},
  browse: () => {},
  choose: () => {},
  openCreate: () => {},
  editCreateName: () => {},
  cancelCreate: () => {},
  createFolder: () => {},
};

function folderModel(overrides: Partial<FolderBrowserModel> = {}): FolderBrowserModel {
  return {
    hubId: "mac",
    boxLabel: "mac-mini",
    hosts: [
      { id: "mac", label: "mac-mini" },
      { id: "dure", label: "Dure" },
      { id: "sdd", label: "sdd" },
    ],
    hostOpen: false,
    stage: {
      kind: "ready",
      rootPath: "/Users/joon",
      path: "/Users/joon/Dev",
      entries: [
        { name: "HebbianIDE", path: "/Users/joon/Dev/HebbianIDE" },
        { name: "Payments", path: "/Users/joon/Dev/Payments" },
        { name: "Playground", path: "/Users/joon/Dev/Playground" },
      ],
    },
    ...overrides,
  };
}

frame(
  "3369:35182 다른 폴더 열기 · 호스트 선택",
  renderFolderBrowserScreen(folderModel({ hostOpen: true }), folderActions),
);
frame(
  "3372:85638 다른 폴더 열기",
  renderFolderBrowserScreen(folderModel(), folderActions),
);
frame(
  "3372:85748 다른 폴더 열기 · 새 폴더",
  renderFolderBrowserScreen(
    folderModel({ create: { name: "", busy: false } }),
    folderActions,
  ),
);

frame(
  "3272:85021 설정 · 키 스트립",
  renderKeyStripScreen(
    { group: DEFAULT_GROUP },
    { back: () => {}, edit: () => {}, askReset: () => {}, remember: () => {} },
  ),
);

frame(
  "3202:81879 키 스트립 · 기본값으로 재설정",
  renderKeyStripScreen(
    { group: DEFAULT_GROUP },
    { back: () => {}, edit: () => {}, askReset: () => {}, remember: () => {} },
  ),
  renderConfirmDialog(
    {
      title: "기본값으로 재설정할까요?",
      description: "직접 고른 키는 사라지고 기본 스트립이 돌아옵니다.",
      confirmLabel: "재설정",
    },
    { cancel: () => {}, confirm: () => {} },
  ),
);

// ── Source control ─────────────────────────────────────────────────────────
//
// Figma 3042:80841, 3046:84875, 3051:81535, 3048:81027, 3050:81250, 3048:81145.
//
// More rows than fit in 874px on purpose. Both list tabs have to scroll, and a
// list short enough to fit proves nothing about the one that does not.

function changed(path: string, status: string, added: number, deleted: number): ChangedFile {
  return { path, status, added, deleted, uncommitted: true };
}

const CHANGED_FILES: ChangedFile[] = [
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

function scm(overrides: Partial<SourceControlModel> = {}): SourceControlModel {
  return {
    title: TITLE,
    branch: "fix/payment-retry",
    changes: {
      kind: "read",
      files: CHANGED_FILES,
      filesRead: true,
      branch: "fix/payment-retry",
      ahead: 2,
      behind: 0,
      baseRef: "main",
    },
    selection: new Set([".gitignore", "src/payments/retry.ts", "src/payments/backoff.ts"]),
    ...overrides,
  };
}

const scmActions: SourceControlActions = {
  back: () => {},
  refresh: () => {},
  openFile: () => {},
  toggleFile: () => {},
  toggleAll: () => {},
  commit: () => {},
};

const PATCH = [
  "@@ -12,6 +12,12 @@",
  " build/",
  " .gradle/",
  " ",
  "+# 빌드 산출물 임시 파일",
  "+.kotlin/errors/",
  "+.omo/tmp/",
  " ",
  " local.properties",
].join("\n");

function diffScreen(actions: FileDiffActions): HTMLElement {
  return renderFileDiff(
    {
      path: ".gitignore",
      patch: { kind: "read", patch: PATCH, truncated: false, added: 6, deleted: 0 },
    },
    actions,
  );
}

frame("3042:80841 source-control/changes", renderSourceControl(scm(), scmActions));
frame("3048:81027 file-diff", diffScreen({ back: () => {}, discard: () => {}, include: () => {} }));
frame(
  "3048:81145 file-diff + 되돌리기 확인",
  diffScreen({ back: () => {}, discard: () => {}, include: () => {} }),
  renderConfirmDialog(
    {
      title: "이 파일의 변경을 되돌릴까요?",
      description: "커밋하지 않은 변경이 사라집니다. 되돌릴 수 없습니다.",
      confirmLabel: "되돌리기",
    },
    { cancel: () => {}, confirm: () => {} },
  ),
);
frame(
  "3050:81250 커밋 시트",
  diffScreen({ back: () => {} }),
  renderCommitSheet(
    {
      files: 3,
      branch: "fix/payment-retry",
      message: "결제 재시도를 지수 백오프로 교체\n최대 5회, 상한 30초. 4xx는 재시도 대상에서 제외.",
    },
    { dismiss: () => {}, edit: () => {}, submit: () => {} },
  ),
);
frame(
  "3050:81351 커밋 시트 (보내는 중)",
  diffScreen({ back: () => {} }),
  renderCommitSheet(
    {
      files: 3,
      branch: "fix/payment-retry",
      message: "결제 재시도를 지수 백오프로 교체\n최대 5회, 상한 30초. 4xx는 재시도 대상에서 제외.",
      busy: true,
    },
    { dismiss: () => {}, edit: () => {}, submit: () => {} },
  ),
);

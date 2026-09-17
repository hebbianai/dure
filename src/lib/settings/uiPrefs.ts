import { DEFAULT_TERMINAL_LINE_HEIGHT } from "@/lib/terminal/renderer/terminalFont";
import {
  DEFAULT_SPACES_VIEW_OPTIONS,
  type SpacesViewOptions,
} from "@/lib/spaces/spacesViewOptions";
import {
  DEFAULT_SESSIONS_VIEW_OPTIONS,
  type SessionsViewOptions,
} from "@/lib/sessions/sessionsViewOptions";
import type { Provider } from "@/types";
import type { QuickCommand } from "@/lib/workspace/pane/quickCommands";

/** 외관 설정 (설정 창 '외관' 페이지) — store에서 추출(god-file 다이어트). */
export interface UiPrefs {
  /** Canvas coordinates are IDE presentation, separate from workflow versions. */
  automationLayouts?: import("@/lib/automations/graphPresentation").GraphLayouts;
  /** Saved text presets, shared by pane menus through the existing preference store. */
  quickCommands?: QuickCommand[];
  /** Stored interface-mode preference. The effective build-constrained mode
   *  is resolved only by lib/workspace/pane/interfaceMode.ts. */
  interfaceMode?: "basic" | "pro";
  /** Client selection only; connection credentials and tasks remain on the server. */
  slackTeamProfileId?: string;
  /** Pro terminal presentation; native input and runtime remain available. */
  agentFinalResponseOnly: boolean;
  /** 툴바 우클릭 "숨기기"가 쌓는 컨트롤별 오버라이드 — 모드 베이스라인 위에
   *  얹히고, 복원은 항목 삭제다. 알 수 없는 id는 무해하게 무시된다. */
  hiddenToolbarControls?: string[];
  /** 앱 테마 — system은 OS 다크모드를 따른다 */
  theme: "system" | "dark" | "light";
  /** 다크/라이트 각각에 적용할 컬러 스킴 id (lib/theme/themeRegistry).
   *  미지정 또는 모르는 id는 기본 룩(스킴 주입 없음). */
  themeScheme?: { dark?: string; light?: string };
  /** Which agent a new-agent surface pre-selects. Unset means Auto (the
   *  first available provider). Resolved only by lib/agents/defaultProvider.ts,
   *  which ignores a stored value that is no longer installed. */
  defaultProvider?: Provider;
  /** 터미널 고정폭 글꼴군 ("" = 기본 스택) */
  terminalFontFamily: string;
  /** Terminal and code-view row height as a multiplier of font size. */
  terminalLineHeight: number;
  /** 상단 바 Claude 사용량 미터 표시 */
  showClaudeUsage: boolean;
  /** 상단 바 Codex 사용량 미터 표시 */
  showCodexUsage: boolean;
  /** 터미널 포커스 시 앱 전역 단축키를 터미널로 넘길지(=Terminal 먼저). false면 앱 먼저 */
  shortcutTerminalFirst: boolean;
  /** 첫 실행 가이드를 사용자가 닫았는지. 저장하는 온보딩 상태는 이 한 비트뿐
   *  이다 — 단계별 완료를 저장하면 실제 상태(폴더·CLI 유무)와 어긋나 화면이
   *  거짓말을 한다. 각 단계는 열릴 때마다 라이브로 판정한다. */
  onboardingDismissed: boolean;
  /** diff 창 좌측 파일 목록 패널 폭(px). 창을 다시 열어도 유지된다 — 매번
   *  다시 끌게 만들면 조절 기능이 없는 것과 크게 다르지 않다. */
  diffFileListWidth: number;
  /** 통계 및 사용량에서 로그를 스캔할 공급자. 미지정이면 전부 스캔한다 —
   *  기본을 꺼짐으로 두면 기존 사용자의 집계가 갑자기 사라진다.
   *  해석 규칙은 lib/usageScope.ts. */
  usageScanProviders?: string[];
  /** 통계 및 사용량의 집계 기간(일). 미지정이면 DEFAULT_SCAN_DAYS.
   *  긴 기간은 첫 스캔이 분 단위로 걸리므로 명시적으로 고른 사람만 받는다. */
  usageScanDays?: number;

  // ── 설정 > 일반 · 탐색 ──────────────────────────────────────────────
  /** 탭 정렬 기준 */
  tabOrder: "recent" | "manual";
  /** Spaces list projection. Read and update through the Spaces cluster hook. */
  spacesViewOptions: SpacesViewOptions;
  /** Recent provider-session projection. Read through the Sessions cluster hook. */
  sessionsViewOptions: SessionsViewOptions;
  /** 고정된 탭을 닫기 전에 확인 대화상자를 표시 */
  confirmClosePinnedTab: boolean;

  // ── 설정 > 일반 · 편집기 ────────────────────────────────────────────
  /** 잠시 후 편집·diff 변경 사항을 자동 저장 */
  autoSaveFiles: boolean;
  /** 마지막 편집 후 자동 저장까지 기다리는 시간(ms) */
  autoSaveDelayMs: number;
  /** git diff 기본 표시 형식 */
  defaultDiffView: "inline" | "split";
  /** diff 편집기에서 긴 줄 줄바꿈 */
  diffWordWrap: boolean;
  /** Last external workspace target that completed a native launch. */
  defaultExternalOpenTargetId?: string;
  /** 결합된 차이점 보기를 열 때 파일 트리 표시 여부 */
  defaultDiffFileTree: "shown" | "hidden";
  /** 파일 편집 시 미니맵 개요 표시 */
  minimap: boolean;
  /** 로컬 markdown 메모 컨트롤 표시 */
  markdownReviewNotes: boolean;

  // ── 설정 > 외관 · 분할 패널 ─────────────────────────────────────────
  /** 분할된 창 사이 간격(px). dockview 테마의 gap으로 그대로 들어간다. */
  splitterSize: number;

  // ── 설정 > 외관 · 파일 탐색기 ───────────────────────────────────────
  /** .gitignore가 무시하는 파일을 파일 트리에 보일지. 끄면 목록마다
   *  git check-ignore를 한 번 돌려 걸러낸다. */
  showGitIgnored: boolean;

  // ── 설정 > 외관 · 상태 표시줄 ───────────────────────────────────────
  /** 상단 바 자원 위젯(CPU·메모리·세션·디스크). 켜면 4초마다 표본을 뜬다. */
  showResourceMonitor: boolean;
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  // New preferences begin in Basic. Existing bytes are preserved verbatim;
  // production availability is enforced by the effective-mode resolver.
  interfaceMode: "basic",
  agentFinalResponseOnly: false,
  theme: "dark", // 기존 동작 유지 (라이트는 아직 하드코딩 다크 표면이 남음)
  terminalFontFamily: "",
  terminalLineHeight: DEFAULT_TERMINAL_LINE_HEIGHT,
  showClaudeUsage: true,
  showCodexUsage: true,
  shortcutTerminalFirst: false,
  onboardingDismissed: false,
  diffFileListWidth: 264,
  // 기본은 수동 — 끌어다 놓은 순서가 유지되는 기존 동작이다. '가장 최근'은
  // 탭이 스스로 앞으로 튀어나오므로 명시적으로 고른 사람만 받게 한다.
  tabOrder: "manual",
  // Repository-first is the default (owner decision 2026-09-03): the repository
  // you work in is the first thing to find; which space holds the pane comes
  // second. Space-first stays selectable for people who think in layouts.
  spacesViewOptions: DEFAULT_SPACES_VIEW_OPTIONS,
  sessionsViewOptions: DEFAULT_SESSIONS_VIEW_OPTIONS,
  confirmClosePinnedTab: true,
  // 자동 디스크 쓰기는 기본 꺼짐 — 편집기가 사용자 몰래 파일을 쓰는 건
  // 옵트인이어야 한다 (VS Code files.autoSave: off와 같은 판단).
  autoSaveFiles: false,
  autoSaveDelayMs: 1000,
  defaultDiffView: "inline",
  // diff 편집기는 원래 무조건 줄바꿈이었다 — 배선하면서 기존 동작을 기본으로 둔다.
  diffWordWrap: true,
  defaultDiffFileTree: "shown",
  minimap: true,
  markdownReviewNotes: true,
  splitterSize: 4,
  // 기본은 보이기 — 지금까지 보이던 파일이 업데이트만으로 사라지면 안 된다.
  showGitIgnored: true,
  // 기본은 꺼짐 — 상단 바에 없던 위젯이 업데이트만으로 생기지 않게 한다.
  // 켜야 폴링도 시작한다.
  // Default-on: the widget itself only renders in the pro interface mode
  // (ResourceMonitor.tsx), so basic never sees it; pro sees it out of the
  // box and this setting is the opt-out (owner request 2026-09-01).
  showResourceMonitor: true,
};

/** Every preference a caller outside the settings UI may read or write — the
 *  CLI's surface. Optional keys belong here too: `themeScheme` is the one most
 *  worth setting from a script, and it has no entry in DEFAULT_UI_PREFS.
 *
 *  The assertion below fails to compile when a new UiPrefs field is not listed,
 *  so the CLI cannot silently fall behind the type. */
export const UI_PREFS_KEYS = [
  "automationLayouts",
  "quickCommands",
  "interfaceMode",
  "slackTeamProfileId",
  "agentFinalResponseOnly",
  "hiddenToolbarControls",
  "theme",
  "themeScheme",
  "terminalFontFamily",
  "terminalLineHeight",
  "showClaudeUsage",
  "showCodexUsage",
  "shortcutTerminalFirst",
  "onboardingDismissed",
  "diffFileListWidth",
  "usageScanProviders",
  "usageScanDays",
  "tabOrder",
  "spacesViewOptions",
  "sessionsViewOptions",
  "confirmClosePinnedTab",
  "autoSaveFiles",
  "autoSaveDelayMs",
  "defaultDiffView",
  "diffWordWrap",
  "defaultExternalOpenTargetId",
  "defaultDiffFileTree",
  "minimap",
  "markdownReviewNotes",
  "splitterSize",
  "showGitIgnored",
  "showResourceMonitor",
  "defaultProvider",
] as const satisfies readonly (keyof UiPrefs)[];

export type UiPrefsKey = (typeof UI_PREFS_KEYS)[number];

type UnlistedUiPrefsKey = Exclude<keyof UiPrefs, UiPrefsKey>;
/** Compile-time only: a new UiPrefs field that is not in UI_PREFS_KEYS makes
 *  this type `never`, and the assignment below stops compiling. */
const _everyUiPrefsKeyIsListed: [UnlistedUiPrefsKey] extends [never] ? true : never =
  true;
void _everyUiPrefsKeyIsListed;

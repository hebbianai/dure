import { type AgentChatSubmission, normalizeAgentChatSubmissions } from "@/lib/agents/chat/agentChatSubmission";
import { isDureBackendProfileIdV1 } from "@/lib/ipc/dureProtocolIdentity";
// 영속 슬라이스와 그 정규화 — store에서 추출(god-file 다이어트).
//
// localStorage 내용은 신뢰하지 않는 입력으로 다룬다: 손으로 고쳤을 수도,
// 구버전 스키마일 수도 있다. 여기서 한 번 걸러 store가 항상 온전한 모양으로
// 시작하게 한다. zustand·Tauri를 몰라 vitest에서 그대로 검증할 수 있다.

import { DEFAULT_SPACE, migrateLegacyDesktopName } from "@/lib/workspace/desktop/desktopNames";
import { normalizePersistedActiveAccounts } from "@/lib/persistence/persistedAccounts";
import { normalizePersistedAgents } from "@/lib/persistence/persistedAgents";
import type { KeyChord, ShortcutOverride } from "@/lib/settings/shortcutBindings";
import { normalizeSessionsViewOptions } from "@/lib/sessions/sessionsViewOptions";
import { normalizeQuickCommands } from "@/lib/workspace/pane/quickCommands";
import {
  DEFAULT_NOTIFY_PREFS,
  normalizedNotificationSoundPreference,
  type AppStats,
  type NotifyPrefs,
} from "@/lib/settings/notifyPrefs";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  normalizeTerminalLineHeight,
} from "@/lib/terminal/renderer/terminalFont";
import {
  normalizeTerminalPrefs,
  type TerminalPrefs,
} from "@/lib/terminal/terminalPrefs";
import { DEFAULT_UI_PREFS, type UiPrefs } from "@/lib/settings/uiPrefs";
import { normalizeSpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import { parseThemeDefinition, type ThemeDefinition } from "@/lib/theme/themeDefinition";
import { normalizePersistedThemeScheme } from "@/lib/theme/themeIdCompatibility";
import { normalizePersistedPaneLayouts } from "@/lib/workspace/layout/persistedPaneLayout";
import {
  normalizeSshHostCredential,
} from "@/lib/ssh/sshCredentialClaim";
import type { LangSetting } from "@/lib/i18n";
import {
  type AccountProfile,
  type Agent,
  type Desktop,
  PROVIDERS,
  type Project,
  type Provider,
  type Space,
  type SshHostConfig,
} from "@/types";

/**
 * 재시작 뒤에도 살아남아야 하는 상태.
 *
 * AppState에서 Pick 하지 않고 독립 선언한다 — store.ts가 이 모듈을 import
 * 하므로 반대 방향 의존이 생기면 순환이 된다. AppState가 구조적으로 이
 * 필드들을 포함하므로 persistedSlice(state)는 그대로 통한다.
 */
// interface가 아니라 type 별칭이다 — interface에는 암묵적 인덱스 시그니처가
// 없어서 zustand persist의 Record<string, unknown> 제약을 만족하지 못한다.
export type PersistedAppState = {
  chatSubmissions?: Record<string, AgentChatSubmission>;
  spaces: Space[];
  spaceVisits: Record<string, number>;
  pinnedPanes: Record<string, boolean>;
  shortcutOverrides: Record<string, ShortcutOverride>;
  layouts: Record<string, unknown>;
  fileTreeSelected: Record<string, string>;
  terminalFontSize: number;
  terminalPrefs: TerminalPrefs;
  uiPrefs: UiPrefs;
  notifyPrefs: NotifyPrefs;
  stats: AppStats;
  projects: Project[];
  pinnedProjects: string[];
  agents: Agent[];
  sshHosts: SshHostConfig[];
  accounts: AccountProfile[];
  activeAccounts: Partial<Record<Provider, string>>;
  customThemes: ThemeDefinition[];
  autoSwitchAccounts: boolean;
  /** Legacy migration input only. Backend projections are never persisted. */
  skipPermissions?: Partial<Record<Provider, boolean>>;
  language: LangSetting;
};

/** persist의 partialize — 런타임 전용 필드를 빼고 저장 대상만 고른다. */
export function persistedSlice(
  state: PersistedAppState & {
    legacySkipPermissions?: Partial<Record<Provider, boolean>>;
  },
): PersistedAppState {
  return {
    ...(state.chatSubmissions ? { chatSubmissions: state.chatSubmissions } : {}),
    spaces: state.spaces,
    spaceVisits: state.spaceVisits,
    pinnedPanes: state.pinnedPanes,
    shortcutOverrides: state.shortcutOverrides,
    layouts: normalizePersistedPaneLayouts(state.layouts),
    fileTreeSelected: state.fileTreeSelected,
    terminalFontSize: state.terminalFontSize,
    terminalPrefs: state.terminalPrefs,
    uiPrefs: state.uiPrefs,
    notifyPrefs: state.notifyPrefs,
    stats: state.stats,
    projects: state.projects,
    pinnedProjects: state.pinnedProjects,
    agents: state.agents,
    sshHosts: state.sshHosts,
    accounts: state.accounts,
    activeAccounts: state.activeAccounts,
    customThemes: state.customThemes,
    autoSwitchAccounts: state.autoSwitchAccounts,
    ...(state.legacySkipPermissions
      ? { skipPermissions: state.legacySkipPermissions }
      : {}),
    language: state.language,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 문자열 키 → 숫자 값만 남긴다 (Space 방문 시각). */
function numberRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(recordValue(value)).flatMap(([key, at]) =>
      typeof at === "number" && Number.isFinite(at) ? [[key, at] as const] : [],
    ),
  );
}

/** true인 항목만 남긴다 (고정된 pane). false 찌꺼기는 버린다. */
function trueRecord(value: unknown): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(recordValue(value)).flatMap(([key, on]) =>
      on === true ? [[key, true] as const] : [],
    ),
  );
}

/** 단축키 재지정 — 저장분이 손상됐을 수 있으니 모양이 맞는 항목만 남긴다.
 *  null은 "일부러 비운 할당"이라 유효한 값이므로 그대로 통과시킨다. */
function shortcutOverrideRecord(value: unknown): Record<string, ShortcutOverride> {
  const entries: [string, ShortcutOverride][] = [];
  for (const [id, chord] of Object.entries(recordValue(value))) {
    if (chord === null) {
      entries.push([id, null]);
      continue;
    }
    const candidate = chord as Partial<KeyChord> | null;
    if (
      candidate &&
      typeof candidate.key === "string" &&
      candidate.key !== "" &&
      typeof candidate.mod === "boolean" &&
      typeof candidate.shift === "boolean" &&
      typeof candidate.alt === "boolean"
    ) {
      entries.push([id, candidate as KeyChord]);
    }
  }
  return Object.fromEntries(entries);
}

function owns(raw: Record<string, unknown>, key: string): boolean {
  return Object.getOwnPropertyDescriptor(raw, key) !== undefined;
}

function normalizeSpaces(raw: Record<string, unknown>): Space[] {
  // canonical key가 존재하면 legacy 복사본은 보지 않는다. 두 mutable authority가
  // 생기지 않도록 mixed snapshot의 우선순위를 필드별로 고정한다.
  const value = owns(raw, "spaces") ? raw.spaces : raw.desktops;
  const spaces = Array.isArray(value)
    ? value.flatMap((entry) => {
        const candidate = recordValue(entry);
        const legacyCandidate = candidate as Partial<Desktop>;
        if (
          typeof candidate.id !== "string" ||
          typeof candidate.name !== "string"
        ) {
          return [];
        }
        const originSpaceId =
          typeof candidate.originSpaceId === "string"
            ? candidate.originSpaceId
            : typeof legacyCandidate.originDesktopId === "string"
              ? legacyCandidate.originDesktopId
              : undefined;
        const space: Space = {
          id: candidate.id,
          name: candidate.name,
          ...(candidate.kind === "popout" ? { kind: "popout" } : {}),
          ...(originSpaceId ? { originSpaceId } : {}),
          ...(owns(candidate, "returnLayout")
            ? { returnLayout: candidate.returnLayout }
            : {}),
        };
        return [space];
      })
    : [];
  return spaces.length > 0 ? spaces : [DEFAULT_SPACE];
}

export type HydratedPersistedAppState = PersistedAppState & {
  skipPermissions: Partial<Record<Provider, boolean>>;
  legacySkipPermissions?: Partial<Record<Provider, boolean>>;
};

function providerBooleanRecord(
  value: unknown,
): Partial<Record<Provider, boolean>> {
  return Object.fromEntries(
    Object.entries(recordValue(value)).flatMap(([provider, enabled]) =>
      provider in PROVIDERS && typeof enabled === "boolean"
        ? [[provider, enabled] as const]
        : [],
    ),
  ) as Partial<Record<Provider, boolean>>;
}

function normalizeCanonicalPersistedState(
  value: unknown,
): HydratedPersistedAppState {
  const raw = recordValue(value);
  const spaces = normalizeSpaces(raw);
  const language: LangSetting = ["system", "ko", "en"].includes(String(raw.language))
    ? (raw.language as LangSetting)
    : "system";

  const accounts = Array.isArray(raw.accounts) ? (raw.accounts as AccountProfile[]) : [];
  const activeAccounts = normalizePersistedActiveAccounts(raw.activeAccounts, accounts);
  // 저장분은 신뢰하지 않는 입력으로 취급한다 — parseThemeDefinition을 다시
  // 통과시켜, localStorage를 손으로 건드렸거나 스키마가 바뀐 구버전 항목이
  // 검증 없이 활성 스킴으로 쓰이는 일을 막는다.
  const customThemes = Array.isArray(raw.customThemes)
    ? raw.customThemes.flatMap((entry) => {
        const parsed = parseThemeDefinition(entry);
        return parsed.theme ? [parsed.theme] : [];
      })
    : [];
  const uiPrefs = { ...recordValue(raw.uiPrefs) };
  delete uiPrefs.surfaceOpacity;
  if (!isDureBackendProfileIdV1(uiPrefs.slackTeamProfileId)) delete uiPrefs.slackTeamProfileId;
  uiPrefs.terminalLineHeight = normalizeTerminalLineHeight(uiPrefs.terminalLineHeight);
  uiPrefs.spacesViewOptions = normalizeSpacesViewOptions(
    uiPrefs.spacesViewOptions,
    uiPrefs.spacesGroupBy,
  );
  uiPrefs.quickCommands = normalizeQuickCommands(uiPrefs.quickCommands);
  uiPrefs.sessionsViewOptions = normalizeSessionsViewOptions(
    uiPrefs.sessionsViewOptions,
  );
  delete uiPrefs.spacesGroupBy;
  const themeScheme = normalizePersistedThemeScheme(uiPrefs.themeScheme);
  if (themeScheme) uiPrefs.themeScheme = themeScheme;
  else delete uiPrefs.themeScheme;

  const legacySkipPermissions = owns(raw, "skipPermissions")
    ? providerBooleanRecord(raw.skipPermissions)
    : undefined;
  return {
    ...(owns(raw, "chatSubmissions") ? { chatSubmissions: normalizeAgentChatSubmissions(raw.chatSubmissions) } : {}),
    spaces,
    layouts: normalizePersistedPaneLayouts(recordValue(raw.layouts)),
    spaceVisits: numberRecord(
      owns(raw, "spaceVisits") ? raw.spaceVisits : raw.desktopVisits,
    ),
    pinnedPanes: trueRecord(raw.pinnedPanes),
    shortcutOverrides: shortcutOverrideRecord(raw.shortcutOverrides),
    fileTreeSelected: Object.fromEntries(
      Object.entries(recordValue(raw.fileTreeSelected)).flatMap(([root, path]) =>
        typeof path === "string" ? [[root, path] as const] : [],
      ),
    ),
    terminalFontSize: typeof raw.terminalFontSize === "number"
      ? raw.terminalFontSize
      : DEFAULT_TERMINAL_FONT_SIZE,
    terminalPrefs: normalizeTerminalPrefs(raw.terminalPrefs),
    uiPrefs: { ...DEFAULT_UI_PREFS, ...uiPrefs } as UiPrefs,
    notifyPrefs: {
      ...DEFAULT_NOTIFY_PREFS,
      ...recordValue(raw.notifyPrefs),
      sound: normalizedNotificationSoundPreference(recordValue(raw.notifyPrefs).sound),
    } as NotifyPrefs,
    stats: {
      agentsStarted: 0,
      prsCreated: 0,
      activeMs: 0,
      since: Date.now(),
      ...recordValue(raw.stats),
    } as AppStats,
    projects: Array.isArray(raw.projects) ? (raw.projects as Project[]) : [],
    pinnedProjects: Array.isArray(raw.pinnedProjects)
      ? raw.pinnedProjects.filter((id): id is string => typeof id === "string")
      : [],
    agents: normalizePersistedAgents(
      raw.agents,
      Array.isArray(raw.projects) ? (raw.projects as Project[]) : [],
    ),
    sshHosts: Array.isArray(raw.sshHosts)
      ? (raw.sshHosts as SshHostConfig[]).map(normalizeSshHostCredential)
      : [],
    accounts,
    activeAccounts,
    customThemes,
    autoSwitchAccounts:
      typeof raw.autoSwitchAccounts === "boolean" ? raw.autoSwitchAccounts : true,
    skipPermissions: legacySkipPermissions ?? {},
    ...(legacySkipPermissions ? { legacySkipPermissions } : {}),
    language,
  };
}

/** Hydrates canonical or legacy durable state into the Space-native store. */
export function normalizePersistedState(value: unknown): HydratedPersistedAppState {
  return normalizeCanonicalPersistedState(value);
}

export function migratePersistedState(
  value: unknown,
  fromVersion: number,
): HydratedPersistedAppState {
  // Interface mode deliberately has no migration writer. Existing mode bytes
  // stay intact, including `pro` values already stamped by the former v8
  // migration. Their origin is now ambiguous, so a later selectable release
  // may reopen Pro; adding provenance as a second preference is out of scope.
  const wired = migrateWiredUiDefaults(value, fromVersion);
  const sized = migrateSplitterSize(wired, fromVersion);
  const raw = migrateTabOrder({ ...recordValue(sized) }, fromVersion) as Record<string, unknown>;
  if (fromVersion < 2) {
    const identityKey = owns(raw, "spaces") ? "spaces" : "desktops";
    const identities = raw[identityKey];
    if (Array.isArray(identities)) {
      raw[identityKey] = identities.map((identity) => {
        if (!identity || typeof identity !== "object") return identity;
        const candidate = identity as { name?: unknown };
        return typeof candidate.name === "string"
          ? { ...candidate, name: migrateLegacyDesktopName(candidate.name) }
          : candidate;
      });
    }
  }
  return normalizeCanonicalPersistedState(raw);
}

/**
 * v5: 배선되면서 비로소 의미가 생긴 uiPrefs 값들을 저장분에서도 옮긴다.
 *
 * 셋 다 "읽는 곳이 없던 시절의 기본값"이 그대로 저장돼 있을 뿐이라 사용자가
 * 고른 값이 아니다. 그냥 기본값만 바꾸면 uiPrefs를 통째로 저장하는 기존
 * 설치에는 도달하지 않아, 배선과 동시에 모든 사용자가 원치 않는 동작을 받는다
 * (자동 디스크 쓰기가 켜지고, diff 줄바꿈이 꺼진다).
 *
 * (paneInactiveOpacity도 여기서 옮겼었으나 비활성 흐리기 자체가 제거됐다 —
 * 소유자 요청 2026-08-01. 저장에 남은 키는 읽는 곳이 없어 무해하다.)
 */
function migrateWiredUiDefaults(value: unknown, fromVersion: number): unknown {
  if (fromVersion >= 5) return value;
  const raw = recordValue(value);
  const uiPrefs = recordValue(raw.uiPrefs);
  const next = { ...uiPrefs };
  let changed = false;
  if (next.autoSaveFiles === true) {
    next.autoSaveFiles = DEFAULT_UI_PREFS.autoSaveFiles;
    changed = true;
  }
  if (next.diffWordWrap === false) {
    next.diffWordWrap = DEFAULT_UI_PREFS.diffWordWrap;
    changed = true;
  }
  return changed ? { ...raw, uiPrefs: next } : value;
}

/**
 * v9 retired the briefly shipped 6px default. v10 replaces the former 2px
 * default with 4px. Move those old defaults once; preserve other saved widths
 * and any width explicitly chosen after the migration.
 */
function migrateSplitterSize(value: unknown, fromVersion: number): unknown {
  const raw = recordValue(value);
  const uiPrefs = recordValue(raw.uiPrefs);
  const retiredDefault =
    (fromVersion < 9 && uiPrefs.splitterSize === 6) ||
    (fromVersion < 10 && uiPrefs.splitterSize === 2);
  if (!retiredDefault) return value;
  return {
    ...raw,
    uiPrefs: { ...uiPrefs, splitterSize: DEFAULT_UI_PREFS.splitterSize },
  };
}

/**
 * v4: 탭 순서 기본값을 recent -> manual로 내리면서, 이미 저장된 "recent"도 함께
 * 내린다.
 *
 * 저장된 "recent"는 사용자가 고른 값이 아니다 — 그 설정은 여태 아무 동작도 하지
 * 않았고(읽는 곳이 없었다) 기본값이 recent였을 뿐이다. 그대로 두면 이번 배선과
 * 동시에 모든 기존 사용자의 탭 스트립이 말없이 최근순으로 재정렬된다.
 * 명시적으로 "manual"을 저장해 둔 사람은 그대로 둔다.
 */
function migrateTabOrder(value: unknown, fromVersion: number): unknown {
  if (fromVersion >= 4) return value;
  const raw = recordValue(value);
  const uiPrefs = recordValue(raw.uiPrefs);
  if (uiPrefs.tabOrder !== "recent") return value;
  return { ...raw, uiPrefs: { ...uiPrefs, tabOrder: "manual" } };
}

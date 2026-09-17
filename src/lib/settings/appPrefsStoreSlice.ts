// App preferences store slice — persisted user preferences (terminal font and
// behavior, appearance, notifications, language, custom themes, shortcut
// overrides) plus the cumulative usage stats. Extracted from store.ts as a
// composition slice (precedent: sessionRuntimeStoreSlice); implementations
// moved verbatim so update and merge semantics are unchanged.
import type { LangSetting } from "@/lib/i18n";
import { normalizeSessionsViewOptions } from "@/lib/sessions/sessionsViewOptions";
import {
	type AppStats,
	DEFAULT_NOTIFY_PREFS,
	type NotifyPrefs,
} from "@/lib/settings/notifyPrefs";
import {
	type ShortcutOverride,
	withoutShortcutOverride,
	withShortcutOverride,
} from "@/lib/settings/shortcutBindings";
import { DEFAULT_UI_PREFS, type UiPrefs } from "@/lib/settings/uiPrefs";
import { normalizeSpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@/lib/terminal/renderer/terminalFont";
import {
	DEFAULT_TERMINAL_PREFS,
	type TerminalPrefs,
} from "@/lib/terminal/terminalPrefs";
import {
	addCustomTheme as addCustomThemeReducer,
	clearThemeSchemeSlotsForId,
	removeCustomTheme as removeCustomThemeReducer,
} from "@/lib/theme/customThemeSet";
import type { ThemeDefinition } from "@/lib/theme/themeDefinition";
import { allThemes } from "@/lib/theme/themeRegistry";
import { normalizeQuickCommands } from "@/lib/workspace/pane/quickCommands";

export interface AppPrefsStoreSlice {
	/** 사용자가 다시 지정한 단축키 (명령 id → 조합, null=할당 없음, lib/shortcutBindings) */
	shortcutOverrides: Record<string, ShortcutOverride>;
	terminalFontSize: number;
	/** 터미널 동작 설정 (설정 창 '터미널' 페이지) — 새/기존 터미널에 적용 */
	terminalPrefs: TerminalPrefs;
	/** 외관 설정 (테마·글꼴·pane 표시) */
	uiPrefs: UiPrefs;
	/** 알림 설정 */
	notifyPrefs: NotifyPrefs;
	/** 누적 활동 통계 (통계 및 사용량 페이지) */
	stats: AppStats;
	/** 유저가 가져온 컬러 스킴 (설정 > 외관, lib/theme/themeDefinition 검증 통과분만) */
	customThemes: ThemeDefinition[];
	/** UI 언어 — system이면 OS 언어 따라감 */
	language: LangSetting;

	setShortcutOverride: (id: string, chord: ShortcutOverride) => void;
	resetShortcutOverride: (id: string) => void;
	setTerminalFontSize: (n: number | ((cur: number) => number)) => void;
	setTerminalPrefs: (p: Partial<TerminalPrefs>) => void;
	setUiPrefs: (p: Partial<UiPrefs>) => void;
	setNotifyPrefs: (p: Partial<NotifyPrefs>) => void;
	/** 통계 누적 갱신 (agentsStarted/prsCreated 증가, activeMs 추가) */
	bumpStats: (
		p: Partial<Pick<AppStats, "agentsStarted" | "prsCreated" | "activeMs">>,
	) => void;
	/** id 충돌(내장·번들·기존 커스텀 전부와)이면 던진다 — 조용한 덮어쓰기 금지 */
	addCustomTheme: (theme: ThemeDefinition) => void;
	removeCustomTheme: (id: string) => void;
	setLanguage: (l: LangSetting) => void;
}

type SliceSet = (
	updater: (
		state: AppPrefsStoreSlice,
	) => AppPrefsStoreSlice | Partial<AppPrefsStoreSlice>,
) => void;

export function createAppPrefsStoreSlice(set: SliceSet): AppPrefsStoreSlice {
	return {
		shortcutOverrides: {},
		terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
		terminalPrefs: DEFAULT_TERMINAL_PREFS,
		uiPrefs: DEFAULT_UI_PREFS,
		notifyPrefs: DEFAULT_NOTIFY_PREFS,
		stats: { agentsStarted: 0, prsCreated: 0, activeMs: 0, since: Date.now() },
		customThemes: [],
		language: "system",

		setShortcutOverride: (id, chord) =>
			set((s) => ({
				shortcutOverrides: withShortcutOverride(s.shortcutOverrides, id, chord),
			})),

		resetShortcutOverride: (id) =>
			set((s) => {
				const next = withoutShortcutOverride(s.shortcutOverrides, id);
				return next === s.shortcutOverrides ? {} : { shortcutOverrides: next };
			}),

		setTerminalFontSize: (n) =>
			set((s) => {
				const next = typeof n === "function" ? n(s.terminalFontSize) : n;
				return {
					terminalFontSize: Math.min(30, Math.max(8, Math.round(next * 2) / 2)),
				};
			}),

		setTerminalPrefs: (p) =>
			set((s) => ({ terminalPrefs: { ...s.terminalPrefs, ...p } })),

		setUiPrefs: (p) =>
			set((s) => {
				const uiPrefs = { ...DEFAULT_UI_PREFS, ...s.uiPrefs, ...p };
				const spacesViewOptions = p.spacesViewOptions !== undefined
					? normalizeSpacesViewOptions(p.spacesViewOptions)
					: s.uiPrefs.spacesViewOptions;
				const sessionsViewOptions =
					p.sessionsViewOptions !== undefined
						? normalizeSessionsViewOptions(p.sessionsViewOptions)
						: s.uiPrefs.sessionsViewOptions;
				return {
					uiPrefs: {
						...uiPrefs,
						...(p.quickCommands !== undefined ? { quickCommands: normalizeQuickCommands(p.quickCommands) } : {}),
						spacesViewOptions,
						sessionsViewOptions,
					},
				};
			}),

		setNotifyPrefs: (p) =>
			set((s) => ({
				notifyPrefs: { ...DEFAULT_NOTIFY_PREFS, ...s.notifyPrefs, ...p },
			})),

		bumpStats: (p) =>
			set((s) => ({
				stats: {
					...s.stats,
					agentsStarted: s.stats.agentsStarted + (p.agentsStarted ?? 0),
					prsCreated: s.stats.prsCreated + (p.prsCreated ?? 0),
					activeMs: s.stats.activeMs + (p.activeMs ?? 0),
				},
			})),

		addCustomTheme: (theme) =>
			set((s) => ({
				customThemes: addCustomThemeReducer(s.customThemes, allThemes(), theme),
			})),

		removeCustomTheme: (id) =>
			set((s) => ({
				customThemes: removeCustomThemeReducer(s.customThemes, id),
				uiPrefs: {
					...DEFAULT_UI_PREFS,
					...s.uiPrefs,
					themeScheme: clearThemeSchemeSlotsForId(s.uiPrefs?.themeScheme, id),
				},
			})),

		setLanguage: (l) => set(() => ({ language: l })),
	};
}

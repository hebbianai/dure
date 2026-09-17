// 설정 › 외관 페이지 — 테마·컬러 스킴·언어·터미널 글꼴(설치된 글꼴 열거
// 포함)·상태 표시줄.
//
// 시안 2524:68410 개편: 720px 카드를 걷어내고 일반·터미널 페이지와 같은 섹션
// 문법(구획 + hairline)으로 세운다. 앞 세 구획(테마·컬러 스킴·언어)은 시안이
// 이름을 붙이지 않아 라벨 없는 구획이고, 터미널 글꼴·상태 표시줄만 작은
// 라벨을 갖는다.
import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { NumberField } from "@/components/settings/NumberField";
import { PageTitle } from "@/components/settings/PageTitle";
import { Segmented } from "@/components/ui/segmented";
import { SettingRow, SettingsSection } from "@/components/settings/SettingsSection";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { ThemeSchemePicker } from "@/components/settings/ThemeSchemePicker";
import { TerminalFontPreview } from "@/components/terminal/TerminalFontPreview";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { type FontFamily, systemFontFamilies } from "@/lib/ipc";
import {
  MAX_SPLITTER_SIZE,
  MIN_SPLITTER_SIZE,
  normalizeSplitterSize,
} from "@/lib/settings/paneLayout";
import {
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT,
  normalizeTerminalLineHeight,
  TERMINAL_LINE_HEIGHT_STEP,
} from "@/lib/terminal/renderer/terminalFont";
import {
  DEFAULT_UI_PREFS,
  useAppearancePageState,
} from "@/components/settings/useAppearancePageState";

/** 앱에 번들된 고정폭 글꼴 — 설치 여부와 무관하게 항상 고를 수 있다. */
const BUNDLED_FONT_VALUE = "Geist Mono Variable";

/** 외관 (시안 2524:68410) */
export function AppearancePage() {
  // Pane spacing is adjustable in Pro.
  const interfaceMode = useInterfaceMode();
  const { fontSize, setFontSize, ui, setUi } = useAppearancePageState();

  // 이 기기에 실제로 설치된 글꼴을 읽어온다. 예전에는 7개를 하드코딩해서,
  // 그중 번들된 Geist Mono 말고는 설치돼 있어야만 먹었고 설치된 다른 글꼴은
  // 아예 고를 수 없었다. 고정폭/그 외로 나누지 않고 이름순 한 목록으로 둔다 —
  // 찾는 글꼴 이름을 알고 여는 화면이라, 분류가 오히려 어디를 볼지 헷갈리게 한다.
  const [installedFonts, setInstalledFonts] = useState<FontFamily[]>([]);
  useEffect(() => {
    systemFontFamilies()
      .then(setInstalledFonts)
      .catch(() => setInstalledFonts([]));
  }, []);
  // 저장된 글꼴이 목록에 없을 수 있다: 아직 열거 전(빈 목록)이거나, 그 글꼴을
  // 지웠거나, SF Mono처럼 보호된 시스템 글꼴이라 열거되지 않는데 렌더는 되는
  // 경우다. 항목이 없으면 Radix Select는 트리거를 빈칸으로 그리고 다시 고를
  // 방법도 사라지므로, 저장값을 위한 항목을 따로 만들어 준다.
  const stored = ui.terminalFontFamily;
  const storedMissing =
    stored !== "" &&
    stored !== BUNDLED_FONT_VALUE &&
    !installedFonts.some((f) => f.name === stored);

  return (
    <>
      <PageTitle title={t("settings.appearance.title")} desc={t("settings.appearance.description")} />
      <div className="flex w-full flex-col">
        <SettingsSection first>
          <SettingRow
            title={t("settings.appearance.theme.title")}
            desc={t("settings.appearance.theme.desc")}
            align="center"
          >
            <Segmented
              variant="pills"
              value={ui.theme}
              onChange={(v) => setUi({ theme: v })}
              options={[
                { value: "system", label: t("settings.appearance.theme.system") },
                { value: "dark", label: t("settings.appearance.theme.dark") },
                { value: "light", label: t("settings.appearance.theme.light") },
              ]}
            />
          </SettingRow>

          {/* 스킴 갤러리는 제목·설명·카드 격자를 자기가 그린다 — 행 하나가 아니다. */}
          <ThemeSchemePicker />
        </SettingsSection>

        <SettingsSection label={t("settings.appearance.section.terminalFont")}>
          {/* 왼쪽 두 줄과 오른쪽 미리보기(320px)가 같은 높이로 선다 */}
          <div className="flex w-full items-stretch gap-6">
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              <SettingRow title={t("settings.appearance.fontFamily.title")} desc={t("settings.appearance.fontFamily.desc")} align="center">
                <SelectField
                  value={ui.terminalFontFamily || "__default"}
                  onValueChange={(v) =>
                    setUi({ terminalFontFamily: v === "__default" ? "" : v })
                  }
                  className="w-[166px]"
                  contentClassName="max-h-[320px]"
                  aria-label={t("settings.appearance.fontFamily.title")}
                >
                  <SelectOption value="__default">
                    {t("settings.appearance.fontFamily.systemDefault")}
                  </SelectOption>
                  {/* 번들 글꼴은 설치 여부와 무관하게 항상 쓸 수 있다. */}
                  <SelectOption value={BUNDLED_FONT_VALUE}>Geist Mono</SelectOption>
                  {storedMissing && (
                    <SelectOption value={stored}>
                      {t("settings.appearance.fontFamily.notInstalled", { name: stored })}
                    </SelectOption>
                  )}
                  {installedFonts.map((f) => (
                    <SelectOption key={f.name} value={f.name}>
                      {f.name}
                    </SelectOption>
                  ))}
                </SelectField>
              </SettingRow>

              <Separator />

              <SettingRow title={t("settings.appearance.fontSize.title")} desc={t("settings.appearance.fontSize.desc")} align="center">
                <div className="flex items-center gap-2">
                  {/* The stepper's two buttons are Button outline at the icon
                      size, and the readout between them wears the same face so
                      the three still read as one control (owner, 2026-09-13:
                      pre-September frames follow the primitives). */}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("settings.appearance.fontSize.decrease")}
                    onClick={() => setFontSize((n) => n - 1)}
                  >
                    <Minus className="size-[15px]" />
                  </Button>
                  <span className="flex h-8 w-14 items-center justify-center rounded-md border border-border bg-background text-sm font-medium text-foreground dark:border-input dark:bg-input/30">
                    {fontSize}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("settings.appearance.fontSize.increase")}
                    onClick={() => setFontSize((n) => n + 1)}
                  >
                    <Plus className="size-[15px]" />
                  </Button>
                  <span className="pl-2 text-xs text-muted-foreground">px</span>
                </div>
              </SettingRow>

              <Separator />

              <SettingRow
                title={t("settings.appearance.lineHeight.title")}
                desc={t("settings.appearance.lineHeight.desc")}
                align="center"
              >
                <div className="flex items-center gap-2">
                  <NumberField
                    className="h-8 w-16 text-xs"
                    min={MIN_TERMINAL_LINE_HEIGHT}
                    max={MAX_TERMINAL_LINE_HEIGHT}
                    step={TERMINAL_LINE_HEIGHT_STEP}
                    value={ui.terminalLineHeight}
                    onCommit={(raw) =>
                      setUi({ terminalLineHeight: normalizeTerminalLineHeight(raw) })
                    }
                    ariaLabel={t("settings.appearance.lineHeight.title")}
                  />
                  <span className="text-xs text-muted-foreground">×</span>
                </div>
              </SettingRow>
            </div>
            <TerminalFontPreview />
          </div>
        </SettingsSection>

        {interfaceMode === "pro" && (
        <SettingsSection label={t("settings.appearance.section.splitPanes")}>
          <SettingRow
            title={t("settings.appearance.splitter.title")}
            desc={t("settings.appearance.splitter.desc")}
            align="center"
          >
            <div className="flex items-center gap-2">
              <NumberField
                className="h-8 w-16 text-xs"
                min={MIN_SPLITTER_SIZE}
                max={MAX_SPLITTER_SIZE}
                step={1}
                value={ui.splitterSize}
                ariaLabel={t("settings.appearance.splitter.title")}
                onCommit={(raw) =>
                  setUi({
                    splitterSize: normalizeSplitterSize(raw, DEFAULT_UI_PREFS.splitterSize),
                  })
                }
              />
              <span className="text-xs text-muted-foreground">px</span>
            </div>
          </SettingRow>
        </SettingsSection>
        )}

        <SettingsSection label={t("common.fileExplorer")}>
          <SettingRow
            title={t("settings.appearance.showGitIgnored.title")}
            desc={t("settings.appearance.showGitIgnored.desc")}
          >
            <Switch
              checked={ui.showGitIgnored}
              aria-label={t("settings.appearance.showGitIgnored.title")}
              onCheckedChange={(v) => setUi({ showGitIgnored: v })}
            />
          </SettingRow>
        </SettingsSection>

        <SettingsSection label={t("settings.appearance.section.statusBar")}>
          <SettingRow
            title={t("settings.appearance.claudeUsage.title")}
            desc={t("settings.appearance.claudeUsage.desc")}
          >
            <Switch
              checked={ui.showClaudeUsage}
              aria-label={t("settings.appearance.claudeUsage.title")}
              onCheckedChange={(v) => setUi({ showClaudeUsage: v })}
            />
          </SettingRow>

          {/* The widget itself is pro-only — a toggle basic cannot observe
              would be a dead control there. */}
          {interfaceMode === "pro" && (
            <SettingRow
              title={t("settings.appearance.resourceMonitor.title")}
              desc={t("settings.appearance.resourceMonitor.desc")}
            >
              <Switch
                checked={ui.showResourceMonitor}
                aria-label={t("settings.appearance.resourceMonitor.title")}
                onCheckedChange={(v) => setUi({ showResourceMonitor: v })}
              />
            </SettingRow>
          )}

          <SettingRow
            title={t("settings.appearance.codexUsage.title")}
            desc={t("settings.appearance.codexUsage.desc")}
          >
            <Switch
              checked={ui.showCodexUsage}
              aria-label={t("settings.appearance.codexUsage.title")}
              onCheckedChange={(v) => setUi({ showCodexUsage: v })}
            />
          </SettingRow>
        </SettingsSection>
      </div>
    </>
  );
}

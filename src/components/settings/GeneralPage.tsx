// 설정 › 일반 페이지 — SettingsDialog(god-file)에서 추출.
//
// 시안 2524:64419 개편: 페이지를 감싸던 720px 카드를 걷어내고, 섹션마다
// 작은 라벨(11px muted) 하나와 행들을 세운 뒤 섹션 사이를 hairline으로 나눈다.
// 섹션 라벨 아래 붙어 있던 설명 줄("Dure가 파일 편집을 유지하는 방법을
// 구성합니다.", "에이전트 실행 방법을 구성합니다.")은 없앴다 — 라벨이 이미
// 하는 말을 한 번 더 하고 있었고, 시안도 라벨만 둔다.
import { AppUpdatesSection } from "@/components/settings/AppUpdatesSection";
import { AgentLaunchPreferences } from "@/components/settings/AgentLaunchPreferences";
import { LanguageSelectOptions } from "@/components/settings/LanguageSelectOptions";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/settings/NumberField";
import { PageTitle } from "@/components/settings/PageTitle";
import { Segmented } from "@/components/ui/segmented";
import { SettingRow, SettingsSection } from "@/components/settings/SettingsSection";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { type LangSetting, t } from "@/lib/i18n";
import { normalizeAutoSaveDelay } from "@/lib/settings/autoSave";
import {
  hiddenAgentToolbarControlDescriptors,
  withAgentToolbarControlRestored,
} from "@/lib/workspace/pane/agentToolbarControls";
import { resolveEffectiveInterfaceMode } from "@/lib/workspace/pane/interfaceMode";
import {
  DEFAULT_UI_PREFS,
  useGeneralPageState,
} from "@/components/settings/useGeneralPageState";
import type { UiPrefs } from "@/store";

/** 자동 저장 지연 인풋을 비웠을 때 되돌아갈 값. */
const DEFAULT_AUTO_SAVE_DELAY = DEFAULT_UI_PREFS.autoSaveDelayMs;

/** 일반 (시안 2524:64419) */
export function GeneralPage() {
  const {
    language,
    setLanguage,
    autoSwitch,
    setAutoSwitch,
    ui,
    setUi,
  } = useGeneralPageState();
  const interfaceMode = resolveEffectiveInterfaceMode(ui.interfaceMode);
  const hiddenControls = hiddenAgentToolbarControlDescriptors({
    hiddenToolbarControls: ui.hiddenToolbarControls,
  });
  const showInterfaceSection = interfaceMode.selectable || hiddenControls.length > 0;

  return (
    <>
      <PageTitle title={t("settings.common.general")} desc={t("settings.general.description")} />
      <div className="flex w-full flex-col">
        <AppUpdatesSection />
        {showInterfaceSection && (
          <SettingsSection label={t("settings.general.section.interface")}>
            {interfaceMode.selectable && (
              <SettingRow
                title={t("settings.general.interfaceMode.title")}
                desc={t("settings.general.interfaceMode.desc")}
                align="center"
              >
                <Segmented
                  variant="pills"
                  value={interfaceMode.mode}
                  onChange={(v) => setUi({ interfaceMode: v })}
                  options={[
                    { value: "basic", label: t("settings.general.interfaceMode.basic") },
                    { value: "pro", label: t("settings.general.interfaceMode.pro") },
                  ]}
                />
              </SettingRow>
            )}
            {hiddenControls.length > 0 && (
              <SettingRow
                title={t("settings.general.hiddenControls.title")}
                desc={t("settings.general.hiddenControls.desc")}
              >
                <div className="flex flex-col items-end gap-1">
                  {hiddenControls.map((control) => (
                    <div key={control.id} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {t(control.labelKey)}
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          setUi({
                            hiddenToolbarControls: withAgentToolbarControlRestored(
                              ui.hiddenToolbarControls,
                              control.id,
                            ),
                          })
                        }
                      >
                        {t("settings.general.hiddenControls.restore")}
                      </Button>
                    </div>
                  ))}
                </div>
              </SettingRow>
            )}
          </SettingsSection>
        )}

        <SettingsSection label={t("settings.general.section.navigation")}>
          <SettingRow title={t("settings.general.tabOrder.title")} align="center">
            <SelectField
              value={ui.tabOrder}
              onValueChange={(v) => setUi({ tabOrder: v as UiPrefs["tabOrder"] })}
              className="w-[180px]"
            >
              <SelectOption value="recent">
                {t("settings.general.tabOrder.recent")}
              </SelectOption>
              <SelectOption value="manual">
                {t("settings.general.tabOrder.manual")}
              </SelectOption>
            </SelectField>
          </SettingRow>

          <SettingRow
            title={t("settings.general.confirmClosePinnedTab.title")}
            desc={t("settings.general.confirmClosePinnedTab.desc")}
          >
            <Switch
              checked={ui.confirmClosePinnedTab}
              aria-label={t("settings.general.confirmClosePinnedTab.title")}
              onCheckedChange={(v) => setUi({ confirmClosePinnedTab: v })}
            />
          </SettingRow>
        </SettingsSection>

        <SettingsSection label={t("common.editor")}>
          <SettingRow
            title={t("settings.general.autoSaveFiles.title")}
            desc={t("settings.general.autoSaveFiles.desc")}
          >
            <Switch
              checked={ui.autoSaveFiles}
              aria-label={t("settings.general.autoSaveFiles.title")}
              onCheckedChange={(v) => setUi({ autoSaveFiles: v })}
            />
          </SettingRow>

          <SettingRow
            title={t("settings.general.autoSaveDelay.title")}
            desc={t("settings.general.autoSaveDelay.desc")}
            align="center"
          >
            <div className="flex items-center gap-2">
              {/* 확정할 때만 정규화 — 매 글자 클램프하면 200 밑으로 못 치고, 빈 칸은 기본값으로 */}
              <NumberField
                className="h-8 w-[108px] text-xs"
                value={ui.autoSaveDelayMs}
                onCommit={(raw) =>
                  setUi({ autoSaveDelayMs: normalizeAutoSaveDelay(raw, DEFAULT_AUTO_SAVE_DELAY) })
                }
              />
              <span className="text-xs text-muted-foreground">ms</span>
            </div>
          </SettingRow>

          <SettingRow
            title={t("settings.general.defaultDiffView.title")}
            desc={t("settings.general.defaultDiffView.desc")}
            align="center"
          >
            <Segmented
              variant="pills"
              value={ui.defaultDiffView}
              onChange={(v) => setUi({ defaultDiffView: v })}
              options={[
                { value: "inline", label: t("settings.general.defaultDiffView.inline") },
                { value: "split", label: t("settings.general.defaultDiffView.split") },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t("settings.general.diffWordWrap.title")}
            desc={t("settings.general.diffWordWrap.desc")}
            align="center"
          >
            <Segmented
              variant="pills"
              value={ui.diffWordWrap ? "on" : "off"}
              onChange={(v) => setUi({ diffWordWrap: v === "on" })}
              options={[
                { value: "off", label: "Off" },
                { value: "on", label: "On" },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t("settings.general.diffFileTree.title")}
            desc={t("settings.general.diffFileTree.desc")}
            align="center"
          >
            <Segmented
              variant="pills"
              value={ui.defaultDiffFileTree}
              onChange={(v) => setUi({ defaultDiffFileTree: v })}
              options={[
                { value: "shown", label: t("settings.general.diffFileTree.shown") },
                { value: "hidden", label: t("common.hidden") },
              ]}
            />
          </SettingRow>

          <SettingRow title={t("settings.general.minimap.title")} desc={t("settings.general.minimap.desc")}>
            <Switch
              checked={ui.minimap}
              aria-label={t("settings.general.minimap.title")}
              onCheckedChange={(v) => setUi({ minimap: v })}
            />
          </SettingRow>

          <SettingRow
            title={t("settings.general.markdownReviewNotes.title")}
            desc={t("settings.general.markdownReviewNotes.desc")}
          >
            <Switch
              checked={ui.markdownReviewNotes}
              aria-label={t("settings.general.markdownReviewNotes.title")}
              onCheckedChange={(v) => setUi({ markdownReviewNotes: v })}
            />
          </SettingRow>
        </SettingsSection>

        {/* Language lives here and only here — the Appearance copy of this
            control was removed 2026-08-24 (one fact, one writer). */}
        <SettingsSection label={t("settings.common.app")}>
          <SettingRow
            title={t("settings.general.language.title")}
            desc={t("settings.general.language.desc")}
            align="center"
          >
            <SelectField
              value={language}
              onValueChange={(v) => setLanguage(v as LangSetting)}
              className="w-[180px]"
            >
              <LanguageSelectOptions />
            </SelectField>
          </SettingRow>
        </SettingsSection>

        <SettingsSection label={t("common.agent")}>
          <SettingRow
            title={t("settings.general.autoSwitchOnLimit.title")}
            desc={t("settings.general.autoSwitchOnLimit.desc")}
          >
            <Switch checked={autoSwitch}
              aria-label={t("settings.general.autoSwitchOnLimit.title")} onCheckedChange={setAutoSwitch} />
          </SettingRow>

          <AgentLaunchPreferences />
        </SettingsSection>
      </div>
    </>
  );
}

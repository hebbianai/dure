// 언어 선택 옵션 — 언어 이름은 해당 언어의 endonym으로 표기(관례상 번역하지
// 않는다). SettingsDialog에서 추출(랫칫).
//
// 순서: English → 中文 → 그 외 (사용자 지시 2026-07-30). 개발 언어가 한국어라
// 예전에는 한국어가 먼저였지만, 목록 순서는 개발자가 아니라 사용자 규모를
// 따른다.
import { SelectOption } from "@/components/ui/select-field";
import { t } from "@/lib/i18n";

export function LanguageSelectOptions() {
  return (
    <>
      <SelectOption value="system">{t("settings.language.defaultEnglish")}</SelectOption>
      <SelectOption value="en">English</SelectOption>
      <SelectOption value="zh">中文</SelectOption>
      {/* Endonym via t() only to satisfy the default-English gate — every
          catalog maps the key back to the endonym itself. */}
      <SelectOption value="ko">{t("settings.language.korean")}</SelectOption>
      <SelectOption value="ja">日本語</SelectOption>
      <SelectOption value="es">Español</SelectOption>
      <SelectOption value="fr">Français</SelectOption>
      <SelectOption value="pt">Português</SelectOption>
    </>
  );
}

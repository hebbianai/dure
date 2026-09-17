import { en } from "./locales/en";
import { ko } from "./locales/ko";
import { loadSettingsPreferences, resolveSettingsLanguage } from "./settingsPreferences";

/**
 * Resolve semantic message IDs through the selected catalog while preserving
 * legacy Korean source strings until those callers migrate.
 */
export function t(source: string, vars: Record<string, string | number> = {}): string {
  const usesEnglish =
    typeof navigator !== "undefined" &&
    resolveSettingsLanguage(loadSettingsPreferences().language, navigator.language) === "en";
  const template = (usesEnglish ? en[source] : ko[source]) ?? source;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

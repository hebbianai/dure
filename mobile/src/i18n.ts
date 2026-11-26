import { en } from "./locales/en";
import { ko } from "./locales/ko";
import {
  loadSettingsPreferences,
  type ResolvedLanguage,
  resolveSettingsLanguage,
} from "./settingsPreferences";

/** The language `t` resolves messages in, for formatting a value (a time)
 * so it reads in the same language as the words around it. */
export function currentLanguage(): ResolvedLanguage {
  return typeof navigator !== "undefined"
    ? resolveSettingsLanguage(loadSettingsPreferences().language, navigator.language)
    : "ko";
}

/**
 * Resolve semantic message IDs through the selected catalog while preserving
 * legacy Korean source strings until those callers migrate.
 */
export function t(source: string, vars: Record<string, string | number> = {}): string {
  const template = (currentLanguage() === "en" ? en[source] : ko[source]) ?? source;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * 커스텀(유저 가져오기) 테마 목록에 대한 순수 리듀서 — store.ts는 이 함수들을
 * set()에 얹기만 한다. God-file(store.ts) 다이어트: 로직은 여기, 배선만 거기.
 */
import type { UiPrefs } from "@/lib/settings/uiPrefs";
import { ThemeIdCollisionError, type ThemeDefinition } from "./themeDefinition";

/** id 충돌(내장·번들·기존 커스텀 전부와)이면 던진다 — 조용한 덮어쓰기 금지. */
export function addCustomTheme(
  existing: readonly ThemeDefinition[],
  registered: readonly ThemeDefinition[],
  theme: ThemeDefinition,
): ThemeDefinition[] {
  if (registered.some((t) => t.id === theme.id) || existing.some((t) => t.id === theme.id)) {
    throw new ThemeIdCollisionError(theme.id);
  }
  return [...existing, theme];
}

export function removeCustomTheme(
  existing: readonly ThemeDefinition[],
  id: string,
): ThemeDefinition[] {
  return existing.filter((t) => t.id !== id);
}

/** 제거되는 커스텀 테마가 선택돼 있던 슬롯을 비운다 — 갤러리가 기본 카드를
 *  정확히 선택 상태로 보여주게, 그리고 없는 id를 조용히 폴백하는 상태로
 *  남지 않게. */
export function clearThemeSchemeSlotsForId(
  themeScheme: UiPrefs["themeScheme"],
  id: string,
): UiPrefs["themeScheme"] {
  const next = { ...themeScheme };
  for (const mode of ["dark", "light"] as const) {
    if (next[mode] === id) delete next[mode];
  }
  return next;
}

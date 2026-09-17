// 설정 > 외관의 컬러 스킴 섹션을 처음에 펼쳐 둘지 — 테마 설정에서 파생한다.
// 시스템은 다크/라이트가 둘 다 쓰이므로 둘 다 열고, 한쪽으로 고정했으면
// 지금 실제로 적용되는 쪽만 연다. 나머지 한쪽은 접어 두되 사라지지는
// 않는다 — 테마를 바꾸기 전에 미리 골라 둘 수 있어야 한다.

import type { UiPrefs } from "@/lib/settings/uiPrefs";

export type SchemeMode = "dark" | "light";

export type SchemeDisclosure = Record<SchemeMode, boolean>;

/** 테마 설정에 대응하는 기본 펼침 상태. 사용자가 손으로 접었다 펴는 것은
 *  호출부의 상태로 덮되, 테마가 바뀌면 다시 여기로 돌아온다. */
export function defaultSchemeDisclosure(theme: UiPrefs["theme"]): SchemeDisclosure {
  if (theme === "system") return { dark: true, light: true };
  return { dark: theme === "dark", light: theme === "light" };
}

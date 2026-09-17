interface SettingsNavigationItem<TId, TIcon> {
  id: TId;
  icon: TIcon;
  label: string;
  /** 이 페이지 안에 있는 설정 이름들. 페이지 이름만으로는 "폰트"·"미니맵"처럼
   *  사용자가 실제로 찾는 말이 하나도 안 걸린다. */
  keywords?: readonly string[];
}

export interface SettingsNavigationGroup<TId, TIcon> {
  group: string;
  items: readonly SettingsNavigationItem<TId, TIcon>[];
}

export function filterSettingsNavigation<TId, TIcon>(
  groups: readonly SettingsNavigationGroup<TId, TIcon>[],
  query: string,
): readonly SettingsNavigationGroup<TId, TIcon>[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return groups;

  // 그룹 이름도 함께 본다 — 헤더에 보이는 낱말을 그대로 쳤는데 목록이 비면
  // 검색이 고장난 것처럼 읽힌다.
  return groups
    .map((group) => {
      const groupMatches = group.group.toLowerCase().includes(normalizedQuery);
      return {
        ...group,
        items: group.items.filter(
          (item) =>
            groupMatches ||
            item.label.toLowerCase().includes(normalizedQuery) ||
            (item.keywords ?? []).some((keyword) =>
              keyword.toLowerCase().includes(normalizedQuery),
            ),
        ),
      };
    })
    .filter((group) => group.items.length > 0);
}

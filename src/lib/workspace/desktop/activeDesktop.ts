/**
 * 렌더 기준의 활성 데스크탑. 저장된 activeSpaceId가 목록에 없으면(다른
 * 창에서의 삭제, 미영속 상태의 rehydrate 등) 첫 데스크탑으로 폴백한다.
 * App의 WorkspaceDeck 렌더와 pane 단 reveal 게이트가 반드시 같은 값을 봐야
 * "화면엔 보이는데 게이트는 비활성"인 어긋남이 생기지 않는다.
 */
export function visibleActiveDesktopId(
  spaces: readonly { id: string }[],
  activeSpaceId: string | undefined,
): string | undefined {
  return spaces.some((desktop) => desktop.id === activeSpaceId)
    ? activeSpaceId
    : spaces[0]?.id;
}

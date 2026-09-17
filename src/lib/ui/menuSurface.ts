/**
 * Figma "Select / Menu"(2132:19414) 시안에서 뽑은 메뉴 표면 치수.
 *
 * select · dropdown-menu · context-menu가 같은 값을 보도록 한곳에 모은다. 세
 * 파일에 같은 유틸리티 문자열을 복사해 두면 시안이 바뀔 때 한둘만 고쳐져
 * 메뉴 종류마다 다르게 보이는 일이 반복된다 — 지금 코드가 그 상태였다
 * (패널은 rounded-lg, 항목은 rounded-md, 글자는 text-sm).
 */

/**
 * 트리거와 메뉴 사이 간격(px).
 *
 * 시안은 입력 바로 아래 4px에 메뉴를 연다. Radix의 `sideOffset`에 그대로
 * 넘기는 값이라 CSS transform으로 흉내 내지 않는다 — transform으로 밀면
 * 충돌 회피(collision detection)가 밀기 전 위치를 기준으로 계산해서, 화면
 * 아래쪽 트리거에서 메뉴가 잘린다.
 */
export const MENU_SIDE_OFFSET = 4

/** 메뉴 패널: 유리 표면 · 1px hairline · 10px 라운드 · 4px 안쪽 여백.
 *
 *  10px는 `--radius` 원값이라 `rounded-lg`다(rounded-md는 그 0.8배인 8px).
 *
 *  배경은 불투명 `--popover`가 아니라 `glass/menu`(라이트 #fafafa 67%, 다크
 *  #272727 75%)에 15px 블러다. 메뉴는 터미널 출력이나 다른 pane 위에 떠서,
 *  불투명 면으로 덮으면 아래 맥락이 통째로 사라진다. 테두리도 일반
 *  `--border`가 아니라 같은 계열의 `glass/menu-hairline`을 쓴다.
 *
 *  두 모드의 틴트·알파는 macOS 네이티브 메뉴 실측값이다(2026-09-04, 근거는
 *  index.css의 --glass-menu 주석). 사이드바가 창의 NSVisualEffectView를
 *  그대로 비추는 네이티브 유리라, 그 위에 뜨는 메뉴만 다른 재질이면 재질이
 *  두 종류로 읽힌다. 모드마다 따로 쟀다 — 알파도 틴트도 서로 옮겨 쓸 수 없다
 *  (다크는 다크에서 재야 한다, shell_corner.rs). */
/** 유리 재질 그 자체 — 틴트와 블러만. 메뉴 패널과, 같은 재질로 떠야 하는 다른
 *  표면(사용량 팝오버)이 이 한 줄을 공유한다. 치수(라운드·여백·테두리를 거는
 *  방식)는 각 표면이 자기 것을 갖는다. hairline 색만 같은 계열을 쓴다.
 *
 *  복사해 두지 말 것 — 이 파일이 존재하는 이유가 그것이다(위 주석). */
export const MENU_GLASS_FILL_CLASS =
  "bg-glass-menu/67 backdrop-blur-[15px] dark:bg-glass-menu/75"

export const MENU_SURFACE_CLASS =
  `rounded-lg border border-glass-menu-hairline ${MENU_GLASS_FILL_CLASS} p-1 text-popover-foreground shadow-menu`

/**
 * 메뉴 항목 공통 치수: 13px 글자 · 4px 세로 여백 · 8px 간격 · 6px 라운드.
 *
 * 글자는 `text-xs`인데 이 앱에서 그 토큰은 13px이다(index.css `--text-xs:
 * 0.8125rem`, line-height 1rem). 4+16+4 = 24px가 시안(419:4518)의 hover pill
 * 높이다.
 *
 * `my-0.5`는 그 pill을 28px 슬롯 안에 앉히기 위한 것이다. hover 배경이 행을
 * 꽉 채우면 연속한 항목의 배경이 맞붙어 한 덩어리로 읽힌다 — 시안은 위아래를
 * 2px씩 비워 각 항목이 알약으로 떨어져 보이게 한다. 이웃한 세로 마진은
 * 상쇄되므로 항목 사이 간격은 4px이 아니라 2px이고, 구분선(`my-1`)은 더 큰
 * 쪽인 4px이 남아 시안의 divider 여백과 맞는다.
 *
 * 아이콘은 12px. 이 규칙은 `:not([class*='size-'])` 예외 없이 항목 안의 모든
 * svg에 건다 — 예외를 두었더니 호출부 30여 곳에 박힌 `size-3.5`·`size-4`가
 * 토큰 변경을 그대로 먹어서, 이 파일이 막으려던 "메뉴마다 다르게 보임"이
 * 오히려 여기서 시작됐다. 자손 선택자라 명시 클래스보다 우선한다. 다른
 * 크기가 꼭 필요하면 svg가 아니라 감싼 span에 준다(→ PaneIconSlot).
 *
 * 메뉴 폭을 트리거에 고정했으므로(→ MENU_SIDE_OFFSET 옆 주석) 긴 라벨은
 * 줄바꿈 대신 잘린다. 줄바꿈을 허용하면 항목 높이가 제각각이 되어 시안의
 * 균일한 행 높이가 무너진다.
 */
export const MENU_ITEM_CLASS =
  "my-0.5 gap-2 overflow-hidden rounded-sm py-1 text-xs whitespace-nowrap [&_svg]:size-3"

/**
 * 항목 hover·포커스 표면 — 디자인 시스템 419:4518.
 *
 * 배경은 `--accent`가 아니라 `glass/menu-hover`다. accent는 앱 전역 hover
 * 토큰이라 다크에서 `--popover`(0.205) 대비 +0.166으로, 라이트의 관계(1.0 →
 * 0.97, -0.03)보다 5배 세게 찍힌다. 시안이 거의 안 보이는 6% 틴트로 그린
 * hover가 앱에서는 회색 블록이 됐다(사용자 제보 스크린샷).
 *
 * 글자색은 hover에서 바꾸지 않는다 — 시안의 hover 항목도 텍스트가
 * `popover-foreground` 그대로다. 예전 `focus:**:text-accent-foreground`는
 * 자손을 전부 같은 색으로 칠해서, "Spaces에 유지"나 프로젝트 이름 같은 흐린
 * 보조 텍스트가 hover 순간 본문과 같아지며 주/보조 구분이 사라졌다.
 *
 * `data-open`은 열린 서브트리거용이다 — 다른 항목엔 그 속성이 없어 무해하다.
 */
export const MENU_ITEM_HOVER_CLASS =
  "focus:bg-glass-menu-hover data-open:bg-glass-menu-hover"

/** 체크 표시가 붙는 항목: 오른쪽 아이콘 자리를 32px 비워 둔다. */
export const MENU_ITEM_CHECKABLE_CLASS = "pr-8 pl-2"

/** 체크 표시가 없는 항목: 좌우 8px 대칭. */
export const MENU_ITEM_PLAIN_CLASS = "px-2"

/** 체크 아이콘 자리: 오른쪽 8px, 12px 정사각. */
export const MENU_ITEM_INDICATOR_CLASS =
  "pointer-events-none absolute right-2 flex size-3 items-center justify-center"

/** 그룹 제목: 항목과 좌측 정렬을 맞추고 글자만 흐리게. */
export const MENU_LABEL_CLASS = "px-2 py-1.5 text-xs text-muted-foreground"

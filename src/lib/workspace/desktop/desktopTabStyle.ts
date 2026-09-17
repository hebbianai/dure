// 데스크탑 탭 바의 표현 클래스 — Figma 글래스 시안(2070:32171, 2039:27986) 기준.
// DesktopBar는 렌더링·배선만 남기고 "어떻게 보이는가"는 여기 모아 둔다.
//
// 시안의 탭 트리거는 활성 상태에서도 칩 배경을 깔지 않는다. 글자색(foreground)과
// 굵기(medium)만으로 비활성(muted-foreground / normal)과 구분하고, 배경 틴트는
// hover에서만 나타난다. 반투명 glass 토큰이라 라이트/다크 모두 뒤 표면 위에 얹힌다.

/** 바 전체.
 *
 *  표면은 glass/sheet다. 처음엔 glass/chrome으로 짚었는데, 시안 PNG를 디코딩해
 *  보면 바는 rgb(250,250,251) = #fafafb로 렌더되고 이건 뒤 표면과 바이트 단위로
 *  같다 — 즉 바 컨테이너에 채움이 아예 없다는 뜻이다. chrome(#09090b09)을 어떤
 *  색 위에 얹어도 250이 나오려면 원본이 258이어야 하므로 산술적으로 불가능하다.
 *  #fafafb는 정확히 glass/sheet 값이다.
 *
 *  이걸 chrome으로 두면 바가 페이지보다 어두워져서 시안이 보여주는 명도 관계가
 *  뒤집히고, 같은 창의 다른 chrome 바(WindowTitleBar)와도 색이 어긋난다.
 *
 *  --- 2026-07-29: 더 이상 '바'가 아니다 ---
 *  시안(2070:32171 + default-light 전체 렌더)에서 데스크탑 탭은 별도 줄이
 *  아니라 창 최상단 한 줄에 워드마크 오른쪽으로 이어진다. 그래서 이 클래스는
 *  높이·표면·경계선을 갖지 않는다 — 그건 이제 WindowTitleBar가 소유하고,
 *  여기는 그 줄 안에서 남은 폭을 쓰는 스트립일 뿐이다.
 *
 *  위의 glass/sheet 고찰은 기록으로 남긴다. 표면이 다시 필요해지는 날(예:
 *  탭 줄을 워크스페이스 쪽으로 되돌릴 때) 같은 실수를 반복하지 않으려는 것이다. */
/*  왼쪽 여백: 스트립은 pane 카드의 안쪽 모서리에서 시작한다 — 워크스페이스
 *  열의 --workspace-inset(열림 2px / 접힘 4px, App.tsx)에 카드의 1px 패딩을
 *  더한 값, plus 4px: the pane header's glyph stands at pl-3 (12px) while a
 *  tab pads px-2 (8px), so the strip covers that difference and the first
 *  tab's label stands on the header glyph's x (owner request 2026-09-09;
 *  adjusted 2026-09-10 when the header went to 12px).
 *
 *  시안(2070:32171, 전체화면 2156:23730)은 컨테이너를 `px-16`으로 두는데, 그
 *  16은 시안의 카드 여백 8 + 헤더 여백 16 = 24와 탭의 16 + 8 = 24가 만나는
 *  값이었다. 구현이 카드 여백을 2/4, 헤더 여백을 8로 줄이면서 16을 그대로
 *  두면 탭 글자만 11~13px 오른쪽에 떠서, 숫자 대신 그 관계를 지킨다.
 *  오른쪽은 시안이 모델링하지 않는다(시안 컨테이너에는 Pinpoint·skew 칩이
 *  없다) — 그 자리는 WindowTitleBar가 소유하므로 pr-3을 유지한다. */
export const desktopBarClass =
  "flex min-w-0 flex-1 items-center gap-1 pr-3 pl-[calc(var(--workspace-inset,4px)+5px)]";

/** 탭 스트립 — 시안의 트리거 간격은 2px.
 *
 *  `translate-y-px`: the strip is geometrically centred on the 44px chrome
 *  line (24px tabs, 10px above and below), yet the labels read as sitting
 *  high against the pane card that starts right under the line. One pixel
 *  down is the optical correction the owner asked for (2026-09-10), the same
 *  nudge the GitHub toolbar's select and count got; a transform keeps the
 *  shift a whole pixel where a margin would centre on a half. */
export const desktopTabStripClass =
  "flex min-w-0 flex-1 translate-y-px items-center gap-0.5 overflow-x-auto scrollbar-none";

/** 모든 탭이 공유하는 기하 — 24px 높이, 6px radius, 8px 좌우 여백, 12px 본문.
 *  `scroll-mx-16`: when the strip reveals the active tab (DesktopBar), the
 *  tab lands 64px clear of the edge — the width of the strip's edge fade —
 *  instead of under it. */
const desktopTabBaseClass =
  "group flex h-6 shrink-0 cursor-pointer scroll-mx-16 items-center gap-1 whitespace-nowrap rounded-sm px-2 text-xs transition-colors";

/** 탭 트리거 한 개의 클래스. `active`는 활성 데스크탑 여부. */
export function desktopTabClass(active: boolean): string {
  return `${desktopTabBaseClass} ${
    active
      ? "font-medium text-foreground"
      : "text-muted-foreground hover:bg-glass-tint-hover hover:text-foreground"
  }`;
}

/** 이름 앞 번호(⌘1..9) — 시안에서는 이름과 한 덩어리라 색을 따로 죽이지 않는다. */
export const desktopTabNumberClass = "tabular-nums";

/** 새 데스크탑 "+" 어포던스 — 트리거와 같은 radius, 24px 정사각. */
export const desktopAddButtonClass =
  "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-glass-tint-hover hover:text-foreground";

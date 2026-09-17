/**
 * 검색 입력의 공통 표면 — Figma 2386:41107.
 *
 * 기하(높이·좌우 여백·아이콘 자리)는 쓰는 쪽이 정한다 — 패널마다 줄 높이가
 * 다르고(h-6/h-7/h-8), 그건 표면이 아니라 밀도의 문제다.
 */
/* The outline is the glass hairline — the sidebar's own line token, an alpha
 * near-black/near-white that takes the shell's tint — not --border, whose light
 * value is an opaque grey that sat on the glass as a fixed line and whose dark
 * value is a different alpha from every other line in the sidebar (owner
 * report 2026-09-09).
 * The fill lifts off the shell in both modes. `glass-chrome` does that in dark
 * (white 6%) but not in light, where the same token is black 3.5% and sank the
 * field into an already-grey shell — separation then fell to the border alone,
 * which is why the outline was the loudest thing in the panel (사용자 지적
 * 2026-09-08). Light gets a white fill instead, the way a macOS search field
 * sits on a grey sidebar. */
export const SEARCH_FIELD_SURFACE =
  "border-glass-hairline bg-background/70 dark:bg-glass-chrome shadow-none outline-none " +
  "placeholder:text-muted-foreground " +
  "hover:bg-glass-tint-hover " +
  "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 " +
  "focus:border-ring focus:ring-2 focus:ring-ring/50";

/**
 * 사이드바의 검색·필터 입력이 이 상수를 공유한다(스페이스·파일 트리·플러그인·
 * 검색 패널·세션 패널). 설정 대화상자나 위치 관리처럼 사이드바 밖 입력은
 * 각자의 크기를 갖는다 — 여기서 한 벌로 묶는 범위는 사이드바다.
 */
export const SEARCH_FIELD_TEXT = "text-field";

/** 입력을 감싸는 컨테이너가 표면을 맡는 경우(SearchPane) — 포커스 링이
 *  focus-within으로 온다. 안쪽 input은 배경 없이 투명하게 둔다. */
/* Same lift as SEARCH_FIELD_SURFACE — see the note there. */
export const SEARCH_FIELD_SURFACE_WITHIN =
  "border-glass-hairline bg-background/70 dark:bg-glass-chrome shadow-none " +
  "hover:bg-glass-tint-hover " +
  "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50";

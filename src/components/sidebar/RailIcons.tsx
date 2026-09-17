// 시안에는 있는데 lucide에는 없는 아이콘들. 나머지 레일 아이콘은 전부
// lucide를 그대로 쓴다 (LayoutGrid·Folder·Search·Puzzle·Plug).
//
// 여기 있는 것들은 lucide와 같은 규격으로 그린다: 24 그리드, stroke 2,
// linecap/linejoin round, fill 없음. 규격을 맞추는 게 핵심이다 — lucide
// 아이콘은 24 박스 안에서 대개 3~21 범위에 그려지는데, 이걸 무시하고 박스를
// 꽉 채워 그리면 같은 size-4를 줘도 옆 아이콘보다 커 보인다. 실제로 예전
// SshRailIcon이 사각형을 1~23으로 그려서 22% 크게 보였다.
//
// 좌표는 눈짐작이 아니라 시안 노드 2070:32039의 내보낸 SVG를 24 그리드로
// 역산해서 얻었다.

interface RailIconProps {
  className?: string;
}

/** lucide 규격 공통 속성 — 크기는 className(size-4 등)이 정한다 */
/** lucide 규격 — 이 폴더의 다른 커스텀 글리프도 같은 값을 쓴다 */
export const STROKE_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Figma "Icon / SSH" (2005:15138) — 타이틀바가 있는 터미널 창.
 *
 * lucide의 SquareTerminal에 상단 구분선(`M3 7h18`)이 더해지고 셰브런·밑줄이
 * 그 아래로 내려간 모양이다. lucide 전체에서 `M3 7h18`을 쓰는 건
 * wallet-cards뿐이라 대체할 표준 아이콘이 없다.
 */
export function SshRailIcon({ className }: RailIconProps) {
  return (
    <svg {...STROKE_PROPS} className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 7h18" />
      <path d="m8 15 2-2-2-2" />
      <path d="M12 17h4" />
    </svg>
  );
}

/**
 * Figma "Icon / Github" (2005:13094).
 *
 * 시안의 path를 24 그리드로 되돌리면 lucide의 옛 `github` 글리프와 정확히
 * 일치한다 (예: `M9 18c-4.51 2-5-2-7-2`). lucide v1이 브랜드 아이콘을 빼서
 * 지금 버전(1.27.0)에는 없으므로 여기 둔다.
 *
 * 채워진 옥토캣을 쓰면 안 된다 — 선으로 그린 이웃 아이콘들 사이에서 혼자
 * 덩어리로 보인다. 예전 GithubRailIcon이 그랬다.
 */
export function GithubRailIcon({ className }: RailIconProps) {
  return (
    <svg {...STROKE_PROPS} className={className} aria-hidden>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

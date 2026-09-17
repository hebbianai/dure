import type React from "react";
import type { QrMatrix } from "@/lib/ipc";
import { t } from "@/lib/i18n";

/**
 * QR을 SVG로 그린다.
 *
 * 여백(quiet zone)은 화면이 준다 — 사양이 4모듈을 요구하고, 그게 없으면 스캐너가
 * 못 읽는다. Rust 쪽 매트릭스에 넣지 않은 이유는 그 두께를 화면이 정하는 게
 * 맞아서다. 프레임 안쪽은 1모듈, 나머지 여백은 프레임 바깥의 빈 표면이다
 * (소유자 결정 2026-09-10: 선은 두되 패딩은 4px 정도).
 *
 * The modules are the foreground ink on the dialog's own surface (owner call
 * 2026-09-10): in dark mode that is a light-on-dark code. iOS Camera, Google
 * Lens and the ML Kit / AVFoundation readers our own app uses all decode
 * inverted codes; the quiet zone is what they need. It was a white card,
 * which read as a sticker on the glass.
 *
 * Only the outline rounds (owner call 2026-09-10): a module corner takes a
 * radius only where it is a convex corner of the dark region it belongs to —
 * both neighbours on that side light — so runs of modules stay one shape with
 * soft ends instead of a field of beads. The three finder patterns are drawn
 * as one ring and one eye each rather than as modules, so rounding cannot
 * break the pattern a scanner locates the code by. Scanners sample module
 * centres, so neither costs anything.
 *
 * # 왜 별도 파일인가
 *
 * 이 앱에는 서로 다른 페어링이 둘 있고(SSH 쪽 `hmux-pair:`, 허브 쪽
 * `dure-hub:`) 둘 다 QR을 그린다. 한쪽에 두고 다른 쪽이 베끼면 여백이나 대비
 * 규칙이 갈리고, 그 차이는 **사용자 폰에서만** 드러난다 — 한 화면의 QR은
 * 읽히는데 다른 화면 것은 안 읽히는, 재현하기 어려운 신고가 된다.
 */

const FINDER = 7;
const CORNER_RADIUS = 0.4;

/** A rounded square as a closed path, so a ring can be one evenodd path. */
function roundedSquare(x: number, y: number, size: number, r: number): string {
  const s = size - 2 * r;
  return [
    `M${x + r},${y}`,
    `h${s}`,
    `a${r},${r} 0 0 1 ${r},${r}`,
    `v${s}`,
    `a${r},${r} 0 0 1 -${r},${r}`,
    `h-${s}`,
    `a${r},${r} 0 0 1 -${r},-${r}`,
    `v-${s}`,
    `a${r},${r} 0 0 1 ${r},-${r}`,
    "z",
  ].join("");
}

/** One module as a closed path whose corners round only where `tl`… say so. */
function modulePath(
  x: number,
  y: number,
  r: number,
  corners: { tl: boolean; tr: boolean; br: boolean; bl: boolean },
): string {
  const { tl, tr, br, bl } = corners;
  return [
    `M${x + (tl ? r : 0)},${y}`,
    `H${x + 1 - (tr ? r : 0)}`,
    tr ? `a${r},${r} 0 0 1 ${r},${r}` : "",
    `V${y + 1 - (br ? r : 0)}`,
    br ? `a${r},${r} 0 0 1 -${r},${r}` : "",
    `H${x + (bl ? r : 0)}`,
    bl ? `a${r},${r} 0 0 1 -${r},-${r}` : "",
    `V${y + (tl ? r : 0)}`,
    tl ? `a${r},${r} 0 0 1 ${r},-${r}` : "",
    "z",
  ].join("");
}

function finderOrigins(size: number): Array<[number, number]> {
  return [
    [0, 0],
    [size - FINDER, 0],
    [0, size - FINDER],
  ];
}

function insideFinder(row: number, column: number, size: number): boolean {
  return finderOrigins(size).some(
    ([ox, oy]) =>
      column >= ox && column < ox + FINDER && row >= oy && row < oy + FINDER,
  );
}

export function QrImage({ matrix, label }: { matrix: QrMatrix; label?: string }) {
  // One module of padding inside the frame (~4px at this size); the four-module
  // quiet zone the spec asks for is the dialog surface around the frame, which
  // is empty. A hairline at a tenth of the ink does not read as a module edge.
  const quiet = 1;
  const span = matrix.size + quiet * 2;
  const dark = (row: number, column: number): boolean =>
    row >= 0 &&
    column >= 0 &&
    row < matrix.size &&
    column < matrix.size &&
    Boolean(matrix.modules[row * matrix.size + column]) &&
    !insideFinder(row, column, matrix.size);
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (!dark(row, column)) continue;
      const up = dark(row - 1, column);
      const down = dark(row + 1, column);
      const left = dark(row, column - 1);
      const right = dark(row, column + 1);
      parts.push(
        modulePath(column + quiet, row + quiet, CORNER_RADIUS, {
          tl: !up && !left,
          tr: !up && !right,
          br: !down && !right,
          bl: !down && !left,
        }),
      );
    }
  }
  const finders: React.ReactElement[] = finderOrigins(matrix.size).map(
    ([ox, oy]) => {
      const x = ox + quiet;
      const y = oy + quiet;
      const ring = `${roundedSquare(x, y, 7, 1.75)} ${roundedSquare(x + 1, y + 1, 5, 1.25)}`;
      return (
        <g key={`finder-${ox}-${oy}`} fill="currentColor">
          <path fillRule="evenodd" d={ring} />
          <path d={roundedSquare(x + 2, y + 2, 3, 0.9)} />
        </g>
      );
    },
  );
  // The frame's corners follow the code's own rounding: one module outside
  // the finder ring, so its radius is the ring's (1.75) plus the quiet
  // module — concentric with the ring rather than a square around soft
  // shapes (owner call 2026-09-14). Sized from the module pitch, since the
  // box is 220px whatever the code's version.
  const frameRadius = (220 / span) * (1.75 + quiet);
  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      className="size-[220px] border border-glass-hairline text-foreground"
      style={{ borderRadius: `${frameRadius}px` }}
      role="img"
      aria-label={label ?? t("settings.mobilePairing.qr.alt")}
      shapeRendering="geometricPrecision"
    >
      {finders}
      <path fill="currentColor" d={parts.join(" ")} />
    </svg>
  );
}

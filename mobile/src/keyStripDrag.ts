/**
 * Where a dragged strip chip lands. Figma `dure-UI` 3272:85019 — "드래그 중 —
 * 순서 이동".
 *
 * # Why this is a module and not four lines in the view
 *
 * The rule the spec writes — *move when the pointer's x passes the neighbour's
 * centre* — is the whole of the gesture's behaviour, and it is the part that a
 * pointer-driven view cannot test: jsdom lays nothing out, so every rectangle
 * it reports is zero. Here it is arithmetic over numbers a test can name.
 *
 * # Why a step at a time
 *
 * The target moves by one place per crossing rather than jumping to whichever
 * centre is nearest. Chips are not the same width — `⇧Tab` is three times `/`
 * — so "nearest centre" would skip a narrow chip the finger is sitting on top
 * of, and the row would reorder somewhere the thumb never went.
 */

/**
 * How far a finger travels before the press stops being a tap.
 *
 * The spec's number (6px). A tap removes a chip and a drag reorders it, so the
 * threshold is the only thing standing between "I meant to move this" and a
 * key vanishing from the strip.
 */
export const DRAG_THRESHOLD = 6;

/**
 * The index the chip at `current` should occupy for a pointer at `pointerX`.
 *
 * `centers` is the live row, the dragged chip included, in the order it is
 * drawn — the caller re-measures after each move, because moving a chip is
 * what changes the centres.
 */
export function dropIndex(
  centers: readonly number[],
  current: number,
  pointerX: number,
): number {
  if (current < 0 || current >= centers.length) return current;
  let target = current;
  // Left, then right: only one of the two loops can run, since the pointer
  // cannot be past the centre on both sides at once.
  while (target > 0) {
    const neighbour = centers[target - 1];
    if (neighbour === undefined || pointerX >= neighbour) break;
    target -= 1;
  }
  while (target < centers.length - 1) {
    const neighbour = centers[target + 1];
    if (neighbour === undefined || pointerX <= neighbour) break;
    target += 1;
  }
  return target;
}

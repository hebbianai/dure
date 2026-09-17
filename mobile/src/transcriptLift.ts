/**
 * What is standing on the transcript, and how much of it the session is allowed
 * to hear about.
 *
 * # The rule
 *
 * The session is sized to the screen at rest. Nothing transient changes that
 * size: a drawer somebody opened for a moment and a keyboard that is up while
 * they type are both answered by *lifting the transcript's floor* by their
 * height. The grid keeps the rows it was given, gains that much empty room
 * under itself, and the newest line scrolls up clear of whatever arrived.
 *
 * # Why not resize
 *
 * Because a resize is a repaint of the agent's own screen, and it is the wrong
 * shape twice. Going down it stutters — every tap of History cost a round trip
 * and a full redraw. Coming back up it does not undo itself: growing a terminal
 * adds blank rows at the bottom, and where the prompt lands afterwards is the
 * agent's business, not ours, so the prompt stayed stranded halfway up the
 * screen after the drawer had already closed. Both came back from the phone
 * (2026-09-03) as "뚝뚝 끊긴다" and "닫아도 프롬프트가 위에 있다".
 *
 * The lift has neither problem: it is one scroll, it is exactly reversible, and
 * the session is never told anything happened.
 *
 * # The three numbers
 *
 * - `--session-tray-height` is what the transcript *reserves*: the tray as it
 *   stands, without its drawer. It follows the tray because the tray's own
 *   bottom inset is not constant — with the keys up it stops clearing a home
 *   indicator the keyboard already covers, and drops 30px.
 * - `--session-drawer-height` and `--session-keyboard-height` are the lifts.
 *
 * That 30px is why the keyboard lift is not simply what the keys cover. The
 * keys take room from the window and the tray hands some of it straight back;
 * the session must hear about neither, so what it gets back is the coverage
 * *less* what the tray gave up. Without that correction the last line sat 30px
 * further from the pill with the keyboard up than with a drawer open, which is
 * exactly what came back from the phone next.
 */

/** The tray as it stands, without its drawer — what the transcript reserves. */
export const TRAY_INSET_PROPERTY = "--session-tray-height";
/** An open drawer inside the tray. Absent when none is open. */
export const DRAWER_LIFT_PROPERTY = "--session-drawer-height";
/** What the keyboard costs the transcript. Absent when the keys are down. */
export const KEYBOARD_LIFT_PROPERTY = "--session-keyboard-height";
/**
 * Where the transcript's stage begins, in the layout coordinates a fixed box
 * is placed in. This also bounds the bottom of the space-bar pad in the
 * header (`spaceTrackpad.ts`), clear of the transcript and keyboard.
 * Absent when there is no stage.
 */
export const STAGE_TOP_PROPERTY = "--session-stage-top";

export interface TranscriptGeometry {
  /** The whole tray, drawer included. */
  readonly tray: Element | null;
  /** The open drawer inside it, if any. */
  readonly drawer: Element | null;
  /** How much of the window the keyboard covers; 0 when it is down. */
  readonly covered: number;
  /** The transcript's stage, for where the space-bar pad stands. */
  readonly stage?: Element | null;
}

/**
 * The tray with the keys down, which is what the session is sized against.
 *
 * Remembered rather than computed: it is 48 of pill plus the tray's own gap and
 * the home indicator, and only the platform knows the last of those. Every
 * render with the keys down refreshes it, so a rotation — which changes the
 * inset — corrects it on the next frame rather than carrying a stale one.
 */
let restingTray = 0;

/**
 * Publishes all three onto `root`, clearing them when there is no tray.
 *
 * Cleared rather than zeroed: the stylesheet's own defaults are the pill on its
 * own and no lift at all, which is the right answer before the first layout and
 * on every screen that has no tray. A published `0px` reservation would claim
 * the tray takes no room, and the first paint of a session screen would put the
 * newest line under the pill.
 *
 * Rounded up, because a fractional height rounded down leaves the last row a
 * sliver of a line under whatever is standing on it.
 */
export function publishTranscriptLift(root: HTMLElement, geometry: TranscriptGeometry): void {
  const stage = geometry.stage;
  if (stage instanceof HTMLElement) {
    root.style.setProperty(STAGE_TOP_PROPERTY, `${Math.round(stage.getBoundingClientRect().top)}px`);
  } else {
    root.style.removeProperty(STAGE_TOP_PROPERTY);
  }
  const drawer = heightOf(geometry.drawer);
  const tray = heightOf(geometry.tray) - drawer;
  if (tray <= 0) {
    for (const property of [TRAY_INSET_PROPERTY, DRAWER_LIFT_PROPERTY, KEYBOARD_LIFT_PROPERTY]) {
      root.style.removeProperty(property);
    }
    return;
  }
  if (geometry.covered <= 0) restingTray = tray;
  publish(root, TRAY_INSET_PROPERTY, tray);
  publish(root, DRAWER_LIFT_PROPERTY, drawer);
  publish(
    root,
    KEYBOARD_LIFT_PROPERTY,
    geometry.covered > 0 ? geometry.covered - (restingTray - tray) : 0,
  );
}

function heightOf(node: Element | null): number {
  return node instanceof HTMLElement ? node.getBoundingClientRect().height : 0;
}

function publish(root: HTMLElement, property: string, height: number): void {
  if (height > 0) {
    root.style.setProperty(property, `${Math.ceil(height)}px`);
    return;
  }
  root.style.removeProperty(property);
}

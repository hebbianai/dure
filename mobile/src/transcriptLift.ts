/**
 * Publish the tray reservation and the scroll room needed by its overlay drawer.
 * The keyboard shrinks the visual viewport, so terminal geometry follows the
 * remaining host height directly. Only a drawer needs extra scroll room.
 */

/** The tray as it stands, without its drawer — what the transcript reserves. */
export const TRAY_INSET_PROPERTY = "--session-tray-height";
/** An open drawer inside the tray. Absent when none is open. */
export const DRAWER_LIFT_PROPERTY = "--session-drawer-height";
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
  /** The transcript's stage, for where the space-bar pad stands. */
  readonly stage?: Element | null;
}

/**
 * Publishes the tray and drawer heights onto `root`, clearing them when there
 * is no tray.
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
    for (const property of [TRAY_INSET_PROPERTY, DRAWER_LIFT_PROPERTY]) {
      root.style.removeProperty(property);
    }
    return;
  }
  publish(root, TRAY_INSET_PROPERTY, tray);
  publish(root, DRAWER_LIFT_PROPERTY, drawer);
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

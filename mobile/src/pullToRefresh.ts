/**
 * Pull the list down to ask again.
 *
 * The redesigned home (Figma 3096:86209) has no freshness line, and that line
 * was also the only refresh button on the screen. Removing it as drawn would
 * leave someone holding a stale list with nothing to do about it. The gesture
 * gives the action back without putting anything on a screen the design asked
 * to keep bare: nothing is drawn until a finger asks for it.
 *
 * The arithmetic is pure and lives here so a test can state a drag instead of
 * synthesising touches; [`attachPullToRefresh`] is the thin part that listens.
 */

/** How far the list must travel before letting go means anything. */
export const PULL_ARM_PX = 40;

/** The furthest it will follow the finger. Past this the rubber band is done. */
export const PULL_MAX_PX = 64;

/**
 * Initial travel ratio. Resistance increases toward the limit instead of
 * letting the list follow linearly until it hits a hard stop.
 */
const PULL_RESISTANCE = 0.45;

export interface PullReading {
  /** How far to open the strip above the list, in px. */
  readonly distance: number;
  /** Letting go now would refresh. */
  readonly armed: boolean;
}

/**
 * What a drag has come to.
 *
 * `scrollTop` gates the whole gesture: a list that is scrolled down is being
 * read, and turning that same drag into a refresh would fight the reader for
 * their own scroll. Only a list already at its top can be pulled further.
 *
 * An upward drag reads zero rather than a negative — the strip does not close
 * past shut, and a negative height would invert it.
 */
export function pullReading(input: {
  readonly startY: number;
  readonly currentY: number;
  readonly scrollTop: number;
}): PullReading {
  if (input.scrollTop > 0) return { distance: 0, armed: false };
  const travelled = Math.max(0, input.currentY - input.startY) * PULL_RESISTANCE;
  const distance = PULL_MAX_PX * (1 - Math.exp(-travelled / PULL_MAX_PX));
  return { distance, armed: distance >= PULL_ARM_PX };
}

/** What the binder needs from its host, so a test can hand it a fake. */
export interface PullHost {
  readonly addEventListener: HTMLElement["addEventListener"];
}

/**
 * Bind the gesture to a screen.
 *
 * `strip` is the element that opens; `onRefresh` runs once per armed release.
 * The listeners are passive: this gesture never calls `preventDefault`, so a
 * drag it decides not to claim stays an ordinary scroll rather than a scroll
 * the page swallowed.
 */
export function attachPullToRefresh(
  host: HTMLElement,
  strip: HTMLElement,
  onRefresh: () => void,
  scrollTop: () => number = () => window.scrollY,
): void {
  let startY: number | undefined;
  let reading: PullReading = { distance: 0, armed: false };

  const close = (): void => {
    startY = undefined;
    reading = { distance: 0, armed: false };
    strip.style.height = "";
    strip.classList.remove("home__pull--armed");
  };

  host.addEventListener(
    "touchstart",
    (event) => {
      // A second finger means a pinch or a two-handed scroll, neither of which
      // is this gesture. Abandoning is better than tracking one of the two.
      if (event.touches.length !== 1 || scrollTop() > 0) {
        close();
        return;
      }
      startY = event.touches[0].clientY;
    },
    { passive: true },
  );

  host.addEventListener(
    "touchmove",
    (event) => {
      if (startY === undefined || event.touches.length !== 1) return;
      reading = pullReading({
        startY,
        currentY: event.touches[0].clientY,
        scrollTop: scrollTop(),
      });
      strip.style.height = `${reading.distance}px`;
      strip.classList.toggle("home__pull--armed", reading.armed);
    },
    { passive: true },
  );

  const release = (): void => {
    const fire = reading.armed;
    close();
    // After `close()`, so the strip is already shut when the refresh redraws
    // the screen — otherwise the new DOM inherits an inline height nobody owns.
    if (fire) onRefresh();
  };

  host.addEventListener("touchend", release, { passive: true });
  host.addEventListener("touchcancel", close, { passive: true });
}

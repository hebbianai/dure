/**
 * Which things animate in on this render, and which only look new.
 *
 * `render()` in app.ts rebuilds the whole tree on every state change, so the
 * DOM cannot tell a sheet that just opened from one that was open a moment
 * ago and was rebuilt around a smaller change. Motion has to: a sheet rising
 * again every time a row inside it is toggled reads as a stutter. So the
 * entrance is decided here, from what the previous render showed — an overlay
 * animates on the render where it first appears and stands still on every
 * render after, and a screen fades in only when its kind changes (#851).
 *
 * The stylesheet does the moving: `motion-enter` on an overlay and
 * `motion-screen` on the view root each name an animation, and the class is
 * taken off again when it ends so the next render's decision starts clean.
 */

/**
 * The overlays that enter with motion, keyed so a rebuild keeps its key. A
 * third entry names a data attribute that joins the key: the view menu's card
 * is one card per axis, so a different row's card is a new card while a toggle
 * inside the same one is not.
 */
const OVERLAYS: readonly (readonly [key: string, selector: string, data?: string])[] = [
  ["sheet", ".sheet"],
  ["row-menu", ".row-menu"],
  ["confirm-dialog", ".confirm-dialog"],
  // One key for every drawer: switching from the keys to the history swaps
  // what stands in the tray, and the tray is already up.
  ["tray-panel", ".tray__panel"],
  ["home-menu-card", ".home-menu__card", "facet"],
  // A notice is keyed by its text: a new message rises, a rebuild does not.
  ["toast", ".toast", "text"],
];

export const ENTER_CLASS = "motion-enter";
export const SCREEN_CLASS = "motion-screen";

export interface MotionLedger {
  /** Overlay keys standing after the last render. */
  readonly overlays: ReadonlySet<string>;
  /** The screen kind the last render drew; undefined before the first. */
  readonly screen: string | undefined;
}

export const EMPTY_LEDGER: MotionLedger = { overlays: new Set(), screen: undefined };

/**
 * Marks what is new in `view` against `previous` and returns the ledger the
 * next render compares against. Call once per render, after the tree is built.
 */
export function markEntrances(view: HTMLElement, screen: string, previous: MotionLedger): MotionLedger {
  const overlays = new Set<string>();
  for (const [base, selector, data] of OVERLAYS) {
    const node = view.querySelector<HTMLElement>(selector);
    if (!node) continue;
    const key = data && node.dataset[data] ? `${base}:${node.dataset[data]}` : base;
    overlays.add(key);
    if (!previous.overlays.has(key)) enter(node, ENTER_CLASS);
  }
  // The first paint has nothing to fade from; only a change of screen does.
  if (previous.screen !== undefined && previous.screen !== screen) enter(view, SCREEN_CLASS);
  return { overlays, screen };
}

function enter(node: HTMLElement, className: string): void {
  node.classList.add(className);
  // `animationend` bubbles: a card finishing inside a sheet, or a sheet
  // finishing inside the view, must not end the parent's own entrance early.
  const ended = (event: Event): void => {
    if (event.target !== node) return;
    node.classList.remove(className);
    node.removeEventListener("animationend", ended);
  };
  node.addEventListener("animationend", ended);
}

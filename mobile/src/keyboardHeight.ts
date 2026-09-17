/**
 * How tall the OS keyboard is on this phone, remembered so a drawer can be
 * exactly that tall.
 *
 * Every drawer in the tray — the keys, the history, the session switcher —
 * stands where the keyboard stands, and each is the keyboard's own height so
 * the pill never moves between the keys and a drawer (2026-09-15 승연: "하단
 * 열리는 창 높이가 다 다른데 … 키보드 높이로 맞춰줘"). Only the OS knows that
 * height, and it only says while the keyboard is up: what the keys cover is
 * `innerHeight - visualViewport.height` (`keyboardCoverage` in app.ts), on
 * Android with the navigation bar the keyboard stands on. Recorded then, kept
 * for the drawers, and remembered across launches so the first drawer of a
 * run is already the right height.
 *
 * The tallest reading of one showing: a keyboard that grows a suggestion strip
 * after it appears is measured once it has. A shorter keyboard on the next
 * showing — another IME, the other orientation — wins then.
 */

/** Published on the root; the stylesheet sizes `.tray__panel` from it. */
export const KEYBOARD_HEIGHT_PROPERTY = "--keyboard-height";

const STORAGE_KEY = "dure.keyboardHeight.v1";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export interface KeyboardHeightRecorder {
  /** Hears each viewport reading; 0 means the keyboard is down. */
  observe(covered: number): void;
}

/**
 * Publishes the remembered height at once, then follows the keyboard.
 *
 * Storage is optional and may throw — a private window, a WebView with site
 * data off — and neither costs the drawers anything but the memory.
 */
export function createKeyboardHeightRecorder(
  root: HTMLElement,
  storage: Storage | undefined = defaultStorage(),
): KeyboardHeightRecorder {
  const remembered = load(storage);
  if (remembered !== undefined) publish(root, remembered);
  // The tallest reading of the current showing; 0 while the keyboard is down.
  let showing = 0;
  return {
    observe(covered) {
      if (covered <= 0) {
        showing = 0;
        return;
      }
      const height = Math.round(covered);
      if (height <= showing) return;
      showing = height;
      publish(root, height);
      save(storage, height);
    },
  };
}

function publish(root: HTMLElement, height: number): void {
  root.style.setProperty(KEYBOARD_HEIGHT_PROPERTY, `${height}px`);
}

function load(storage: Storage | undefined): number | undefined {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return undefined;
    const height = Number(raw);
    return Number.isFinite(height) && height > 0 ? Math.round(height) : undefined;
  } catch {
    return undefined;
  }
}

function save(storage: Storage | undefined, height: number): void {
  try {
    storage?.setItem(STORAGE_KEY, String(height));
  } catch {
    // Remembering is a convenience; the drawer is already the right height.
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

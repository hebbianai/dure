/**
 * The keys the phone can send that a touch keyboard cannot.
 *
 * A software keyboard has no Ctrl, no Esc and no arrows, and those are most of
 * what a terminal needs. The tray in Figma 2829:75893 / 2863:75522 is how the
 * phone sends them, and this file is the one place that says what each chip
 * puts on the wire.
 *
 * # Semantic intents
 *
 * Hmux accepts named keys and text records. Naming those here keeps one table
 * authoritative for the tray, drawer, and terminal surface.
 *
 * # A modifier is sticky, and only for one press
 *
 * There is no chord on a touch screen — a finger cannot hold Ctrl and press C.
 * So a modifier arms, the next chip fires with it, and it disarms. It expires
 * on that one press rather than staying on, because a modifier that silently
 * persists turns the next ordinary key into something destructive: pressing
 * Ctrl, then changing your mind and pressing D, should not end the session.
 *
 * There are two of them, Ctrl and Alt, so what is armed is the modifier's *id*
 * and not a flag. A pair of booleans could say both are armed at once, which is
 * a state no press can produce and no key could encode.
 */

/**
 * Which card of the key-strip editor a key lives in. Figma 3272:85021, in its
 * order.
 *
 * A key belongs to exactly one: a picker where the same chip appears under two
 * headings makes the person wonder whether they are two different keys.
 *
 * `ctrl` and `alt` are also *read* as facts, not only as headings —
 * [`intentOf`] turns them into `ctrlKey` / `altKey` for TerminalSurface input —
 * so those two ids are load-bearing and the rest are presentation.
 */
export type KeyCategory = "special" | "modifier" | "nav" | "fn" | "symbol" | "ctrl" | "alt";

/**
 * The cards, in the order the editor stacks them.
 *
 * The frame draws six. `alt` is the seventh: ⌥b/⌥f/⌥d/⌥⌫ are keys this app
 * already sends, and a picker that cannot reach them would be the design
 * silently taking capability away rather than laying it out.
 */
export const KEY_CATEGORIES: readonly {
  readonly id: KeyCategory;
  readonly label: string;
}[] = [
  { id: "special", label: "특수" },
  { id: "modifier", label: "수정자" },
  { id: "nav", label: "화살표 · 탐색" },
  { id: "fn", label: "펑션" },
  { id: "symbol", label: "기호" },
  { id: "ctrl", label: "컨트롤 조합" },
  { id: "alt", label: "옵션 조합" },
];

interface TerminalKeyBase {
  /** Stable id. Screens and stored preferences name this, never the label. */
  readonly id: string;
  /** What the chip reads. */
  readonly label: string;
  /**
   * Drawn two grid cells wide in the command drawer. A four-character word
   * does not fit the drawer's 35px cell on a 360px phone; the vocabulary
   * says which keys those are rather than the drawer guessing from length
   * (2026-09-15 승연, B안).
   */
  readonly wide?: true;
  /** Which tab of the editor offers it. */
  readonly category: KeyCategory;
}

/** One chip, with exactly one wire representation. */
export type TerminalKey = TerminalKeyBase &
  (
    | {
        readonly modifier: true;
        readonly key?: never;
        readonly text?: never;
        readonly code?: never;
      }
    | {
        readonly modifier?: never;
        /** `KeyboardEvent.key`; the Host resolves it through `code`. */
        readonly key: string;
        readonly code?: string;
        readonly text?: never;
      }
    | {
        readonly modifier?: never;
        /** Printable text, sent without pretending it is a physical key. */
        readonly text: string;
        readonly key?: never;
        readonly code?: string;
      }
  );

/**
 * `KeyboardEvent.code` for a key named the way `KeyboardEvent.key` names it.
 *
 * A letter is typed on `KeyX`; everything else this app sends — the named keys
 * and the function row — is a code with the same spelling as its name.
 */
function physicalCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key === "\\") return "Backslash";
  return key;
}

export const TERMINAL_KEYS: readonly TerminalKey[] = [
  { id: "esc", label: "Esc", category: "special", key: "Escape" },
  { id: "tab", label: "Tab", category: "special", key: "Tab" },
  { id: "enter", label: "↵", category: "special", key: "Enter" },
  { id: "backspace", label: "⌫", category: "special", key: "Backspace" },
  { id: "ins", label: "Ins", category: "special", key: "Insert" },
  { id: "del", label: "Del", category: "special", key: "Delete" },
  { id: "shift-tab", label: "⇧Tab", wide: true, category: "special", key: "Tab" },
  { id: "ctrl", label: "Ctrl", wide: true, modifier: true, category: "modifier" },
  { id: "alt", label: "Opt", modifier: true, category: "modifier" },
  { id: "left", label: "←", category: "nav", key: "ArrowLeft" },
  { id: "right", label: "→", category: "nav", key: "ArrowRight" },
  { id: "up", label: "↑", category: "nav", key: "ArrowUp" },
  { id: "down", label: "↓", category: "nav", key: "ArrowDown" },
  { id: "home", label: "Home", wide: true, category: "nav", key: "Home" },
  { id: "end", label: "End", category: "nav", key: "End" },
  { id: "pgup", label: "PgUp", wide: true, category: "nav", key: "PageUp" },
  { id: "pgdn", label: "PgDn", wide: true, category: "nav", key: "PageDown" },
  ...symbols(),
  ...["c", "d", "z", "r", "a", "e", "k", "u", "w", "l"].map((key) => ({
    id: `ctrl-${key}`,
    label: `^${key.toUpperCase()}`,
    category: "ctrl" as const,
    key,
  })),
  { id: "ctrl-backslash", label: "^\\", category: "ctrl", key: "\\" },
  { id: "alt-b", label: "⌥b", category: "alt", key: "b" },
  { id: "alt-f", label: "⌥f", category: "alt", key: "f" },
  { id: "alt-d", label: "⌥d", category: "alt", key: "d" },
  { id: "alt-backspace", label: "⌥⌫", category: "alt", key: "Backspace" },
  ...functionKeys(),
];

/**
 * The punctuation a software keyboard buries, in the order Figma 3272:85021
 * lays the 기호 card out.
 *
 * Every one of these is a *character*, not a named key: it travels as text.
 * `?` closes the list rather than
 * opening it because the frame does not draw it — it is here because it opens
 * help in the TUIs this phone drives, and losing it would cost the default
 * strip a chip.
 */
function symbols(): TerminalKey[] {
  const table: readonly (readonly [string, string])[] = [
    ["pipe", "|"],
    ["slash", "/"],
    ["backslash", "\\"],
    ["tilde", "~"],
    ["minus", "-"],
    ["underscore", "_"],
    ["period", "."],
    ["colon", ":"],
    ["semicolon", ";"],
    ["ampersand", "&"],
    ["plus", "+"],
    ["equals", "="],
    ["dollar", "$"],
    ["asterisk", "*"],
    ["caret", "^"],
    ["at", "@"],
    ["percent", "%"],
    ["hash", "#"],
    ["bang", "!"],
    ["less", "<"],
    ["greater", ">"],
    ["paren-open", "("],
    ["paren-close", ")"],
    ["brace-open", "{"],
    ["brace-close", "}"],
    ["bracket-open", "["],
    ["bracket-close", "]"],
    ["question", "?"],
  ];
  // The physical key for a glyph that key carries *unshifted*. `?` is Slash
  // with Shift, so it is absent: claiming `Slash` for it would send a slash.
  const codes: Record<string, string> = {
    "/": "Slash",
    "\\": "Backslash",
    "-": "Minus",
    ".": "Period",
    ";": "Semicolon",
    "=": "Equal",
    "[": "BracketLeft",
    "]": "BracketRight",
  };
  return table.map(([id, glyph]) => ({
    id,
    label: glyph,
    text: glyph,
    category: "symbol" as const,
    ...(codes[glyph] === undefined ? {} : { code: codes[glyph] }),
  }));
}

/** F1–F12, as keyboard events name them. */
function functionKeys(): TerminalKey[] {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `f${index + 1}`,
    label: `F${index + 1}`,
    key: `F${index + 1}`,
    category: "fn" as const,
  }));
}

const BY_ID = new Map(TERMINAL_KEYS.map((key) => [key.id, key]));

export function terminalKey(id: string): TerminalKey | undefined {
  return BY_ID.get(id);
}

/**
 * What one press puts on the wire, and which modifier is armed afterwards.
 *
 * A modifier press toggles instead of sending — pressing Ctrl twice disarms it,
 * which is how somebody takes back a press they did not mean — and pressing the
 * other modifier replaces it, because only one can ride the next key.
 */
export type KeyIntent =
  | {
      readonly kind: "key";
      readonly key: string;
      /** The physical key — see [`TerminalKey.code`]. Empty when there is none. */
      readonly code: string;
      readonly ctrlKey: boolean;
      readonly altKey: boolean;
      readonly shiftKey: boolean;
    }
  | { readonly kind: "text"; readonly text: string };

export interface KeyPress {
  /** What Hmux receives, or `undefined` for a modifier press. */
  readonly intent: KeyIntent | undefined;
  /** The modifier id waiting for the next press, or `undefined`. */
  readonly armed: string | undefined;
}

function intentOf(
  key: Exclude<TerminalKey, { readonly modifier: true }>,
  armed: string | undefined,
): KeyIntent {
  if (key.key !== undefined) {
    return {
      kind: "key",
      key: key.key,
      code: key.code ?? physicalCode(key.key),
      ctrlKey: armed === "ctrl" || key.category === "ctrl",
      altKey: armed === "alt" || key.category === "alt",
      // ⇧Tab is the only chip whose shift is part of the key rather than armed.
      shiftKey: key.id === "shift-tab",
    };
  }
  // Printable and unnamed: a character, not a key. `shouldSendTerminalKey`
  // drops a bare one-character key, so it has to travel as text.
  const text = key.text;
  if (armed === undefined) return { kind: "text", text };
  return {
    kind: "key",
    key: text,
    code: key.code ?? "",
    ctrlKey: armed === "ctrl",
    altKey: armed === "alt",
    shiftKey: false,
  };
}

export function pressKey(id: string, armed: string | undefined): KeyPress {
  const key = terminalKey(id);
  if (!key) return { intent: undefined, armed };
  if (key.modifier) {
    return { intent: undefined, armed: armed === key.id ? undefined : key.id };
  }
  return { intent: intentOf(key, armed), armed: undefined };
}

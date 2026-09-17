/**
 * The keys this phone keeps in its strip, and the group they are saved in.
 * Figma `dure-UI` 3272:85021 — 설정 → 키 스트립 is what edits this.
 *
 * # Why this lives on the phone
 *
 * Which keys are worth a thumb is a property of *this device and this person*,
 * not of the session: the same session driven from a laptop needs no strip at
 * all. It is kept beside `recents.ts` and `commandHistory.ts` for the same
 * reason those are — presentation state stays in the client (AGENTS.md).
 *
 * The saved shape is deliberately small and self-describing, so moving it onto
 * the wire later is a migration of this file, not of every screen that reads
 * it.
 *
 * # Why a named group, and not a bare list
 *
 * A strip that suits an agent conversation (Esc, ⇧Tab, arrows) is not the one
 * that suits a shell (^C, ^R, ^Z). Nothing switches between them yet, but the
 * name is what a second saved strip would be chosen by, and a stored list that
 * has to grow a name later is a migration nobody schedules.
 *
 * # How many keys fit
 *
 * As many as somebody picks. There was a cap of eight while the editor drew a
 * fixed row of slots; the key-strip screen draws the strip as what it actually
 * is — a row that scrolls — and its spec (3272:85019) says 개수 제한 없음. A
 * press that visibly does nothing needs a reason, and "the row would have to
 * scroll" is not one when it already does. Nothing here is unbounded either:
 * [`toggleKey`] refuses a duplicate, so a strip can never hold more ids than
 * the vocabulary has keys.
 */

import { type TerminalKey, terminalKey } from "./terminalKeys";

/** One saved strip. */
export interface KeyGroup {
  readonly id: string;
  readonly name: string;
  /** Key ids, in strip order. Each id appears at most once. */
  readonly keyIds: readonly string[];
}

const STORAGE_KEY = "hebbian.keytray.v1";

/**
 * What a phone that has never been configured shows.
 *
 * The owner's own set (2026-08-29), in the order they named it. The mockup's
 * slot row spells out `Ctrl Esc Tab` (Figma 2823:75265), which this contains;
 * the rest are what actually gets reached for while driving an agent — ⇧Tab to
 * step back through a menu, `?` for help, `/` for search, and ^C.
 */
export const DEFAULT_GROUP: KeyGroup = {
  id: "default",
  name: "기본",
  keyIds: ["shift-tab", "question", "slash", "esc", "tab", "ctrl", "alt", "ctrl-c"],
};

/**
 * Add or remove one key.
 *
 * Pressing a key already in the group takes it out — the mockup's chips are a
 * selection, and a picker that only adds needs a second gesture to undo a
 * mistake. A new key lands at the end of the strip, which is where the frame's
 * pop-in animation puts it.
 */
export function toggleKey(group: KeyGroup, keyId: string): KeyGroup {
  if (!terminalKey(keyId)) return group;
  if (group.keyIds.includes(keyId)) {
    return { ...group, keyIds: group.keyIds.filter((id) => id !== keyId) };
  }
  return { ...group, keyIds: [...group.keyIds, keyId] };
}

/**
 * Put the strip in the order the chips ended up in.
 *
 * The strip is ordered by hand — dragging a chip past its neighbour is how
 * somebody puts the key their thumb reaches for first — and what the drag
 * produces is a *row of ids*, not a pair of indices.
 *
 * Taking the order rather than a from/to pair is what makes it correct when
 * [`groupKeys`] has dropped an id: a saved key this build cannot draw has no
 * chip, so its position is not one the finger can name. Those ids keep the
 * slots they already had, and the drag reorders the drawn ones around them —
 * an index-based move would have silently reordered the wrong keys instead.
 */
export function reorderKeys(group: KeyGroup, order: readonly string[]): KeyGroup {
  const drawn = new Set(order);
  let next = 0;
  const keyIds = group.keyIds.map((id) => (drawn.has(id) ? (order[next++] ?? id) : id));
  return { ...group, keyIds };
}

/** The keys of a group, dropping ids this build no longer knows. */
export function groupKeys(group: KeyGroup): TerminalKey[] {
  return group.keyIds.flatMap((id) => {
    const key = terminalKey(id);
    // A saved id from a newer build, or one that was removed. Skipping it beats
    // rendering a blank cap that sends nothing when pressed.
    return key ? [key] : [];
  });
}

/**
 * Read the saved strip.
 *
 * A broken or empty store answers with the default rather than an empty strip:
 * a session screen with no keys at all is one a phone cannot drive, and that
 * is a worse outcome than ignoring a corrupt value.
 */
export function load(storage: Pick<Storage, "getItem"> = localStorage): KeyGroup {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_GROUP;
  }
  if (!raw) return DEFAULT_GROUP;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isGroup(parsed)) return DEFAULT_GROUP;
    // Deduped once, here, so "each id appears at most once" is a property of
    // the value and not a hope about who wrote it. A store from another build
    // holding the same id twice would otherwise draw two identical chips whose
    // shared id makes `toggleKey` remove both and `reorderKeys` ambiguous.
    return { ...parsed, keyIds: [...new Set(parsed.keyIds)] };
  } catch {
    return DEFAULT_GROUP;
  }
}

export function save(
  group: KeyGroup,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(group));
  } catch {
    // Full or blocked. The strip still works for this run; only the memory of
    // the edit is lost.
  }
}

function isGroup(value: unknown): value is KeyGroup {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.keyIds) &&
    candidate.keyIds.every((id) => typeof id === "string")
  );
}

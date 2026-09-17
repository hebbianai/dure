/**
 * What this phone has sent into sessions, so it can offer it again.
 *
 * The "최근" panel of Figma 2829:75893. Phone-local, for the same reason
 * `recents.ts` is: what *I* typed on *this* phone is presentation state of this
 * device, not a fact about the session. Putting it on the wire would make the
 * laptop, the web client and the phone push each other's command history
 * around (AGENTS.md — IDE presentation state stays in the client).
 *
 * # Only what the person typed
 *
 * Printable chips join typed text: `/` followed by `model` is `/model`.
 * Control codes themselves are not stored as commands. This is an input-attempt
 * history, not a reconstruction of the provider's completion or line editor.
 *
 * # It is written on this device in the clear
 *
 * A command line can carry a secret (`export TOKEN=…`). This keeps them the way
 * the rest of the phone's storage keeps things — unencrypted — so it holds only
 * what was typed here, never session output, and it stays small enough to
 * inspect. The pairing screen's plaintext disclosure names the private key,
 * not this list, so the list has its own way out: 설정 → 터미널 → 최근 명령
 * 지우기 empties it (`clear`), and 기기 초기화 removes it along with every
 * other store this phone keeps.
 */

/** One command, most recent first. */
export interface SentCommand {
  readonly text: string;
  readonly sentAtUnixMs: number;
}

/**
 * How many to keep.
 *
 * The panel shows a handful; this is a convenience, not a shell history. An
 * unbounded log would leave a permanent record of everything ever typed from
 * this phone, which nobody asked for.
 */
const MAX_COMMANDS = 20;
const STORAGE_KEY = "hebbian.commands.v1";

/**
 * Put a command at the front.
 *
 * Repeating one moves it up rather than adding a second copy: a list where the
 * same command appears four times is a list you have to read past.
 *
 * Blank input is dropped. Pressing send on an empty box is how somebody submits
 * a bare newline to a prompt, and that is not a command worth remembering.
 */
export function withCommand(
  history: readonly SentCommand[],
  text: string,
  sentAtUnixMs: number,
): SentCommand[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [...history];
  const rest = history.filter((entry) => entry.text !== trimmed);
  return [{ text: trimmed, sentAtUnixMs }, ...rest].slice(0, MAX_COMMANDS);
}

/**
 * Read what was stored.
 *
 * A broken store answers with an empty list rather than throwing: this is a
 * convenience, and an empty panel beats a screen that will not open.
 */
export function load(storage: Pick<Storage, "getItem"> = localStorage): SentCommand[] {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    // Safari's private mode throws on the accessor itself.
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCommand).slice(0, MAX_COMMANDS);
  } catch {
    return [];
  }
}

export function save(
  history: readonly SentCommand[],
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_COMMANDS)));
  } catch {
    // Full or blocked. The command was already sent; only the memory of it is
    // lost, and only for this run.
  }
}

/**
 * Forget the list.
 *
 * The key itself goes, not an empty list under it: a store still holding `[]`
 * is a store that still says this phone used the feature.
 */
export function clear(storage: Pick<Storage, "removeItem"> = localStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Blocked store: nothing was kept, so there is nothing to remove.
  }
}

/** Storage holds somebody else's JSON, not our type. */
function isCommand(value: unknown): value is SentCommand {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === "string" &&
    candidate.text.length > 0 &&
    typeof candidate.sentAtUnixMs === "number"
  );
}

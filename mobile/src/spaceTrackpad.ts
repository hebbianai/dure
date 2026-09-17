/**
 * Hold space, drag: the OS keyboard as a trackpad for the arrow keys.
 *
 * Holding the space bar on an iOS keyboard turns the keys into a trackpad that
 * moves the caret of the focused field. This app's field is a wire, not a
 * document — every character goes straight to the session — so the caret had
 * nowhere to go and the gesture did nothing. Now it does what the owner asked
 * (2026-09-03): up and down are ↑ and ↓, the way the arrow keys walk the prompt
 * history in Claude Code; left and right move the cursor along the line; and a
 * longer drag presses faster.
 *
 * # How a caret becomes arrow keys
 *
 * The field holds a *pad*: a grid of one invisible character, with the caret
 * parked in the middle. iOS moves the caret across the grid under the finger,
 * and every cell it crosses is one arrow press. Cells are square, so a finger
 * moving up crosses rows and not columns.
 *
 * The caret is read where it lands and never pushed back mid-drag: iOS keeps
 * its own point for the floating cursor, and a caret moved out from under it
 * jumps back to the finger on the next move. It is re-centred when the finger
 * rests, when something is typed, and when it nears an edge of the pad.
 *
 * # Where the pad sits, and why it is in view
 *
 * WebKit clamps the floating cursor's point to the focused element's box and
 * then hit-tests that point. A one-pixel field — which is what the tray used
 * to hold focus with — clamps every point to that pixel and the caret never
 * moves; a field laid over the transcript either steals every tap or, made
 * deaf to touches with `pointer-events: none`, is skipped by the hit test and
 * the caret never moves either (2026-09-04, on the phone). A field under the
 * keyboard moves the caret, but every move then has iOS sliding the page to
 * reveal a caret it cannot see, and the app sliding it back — the transcript
 * bounced with each cell (same day, same phone).
 *
 * The resting pad occupies the header's noninteractive title area while the
 * keyboard is open. Header buttons stay above it. Placing the pad over the
 * transcript intercepted selection and hold-to-paste; putting it behind the
 * transcript or disabling its pointer events broke native cursor movement.
 * The stylesheet keeps the focused pad hittable and clear of the transcript.
 *
 * # The box grows for the length of a drag
 *
 * iOS keeps the floating cursor's *point* itself, clamped to the web view,
 * and WebKit clamps it again to the field's box. A finger that has gone past
 * the box's edge and comes back moves nothing until its point is back inside
 * — which read as the drag being measured from the space bar rather than
 * from where the finger last was (the owner, 2026-09-04). So once a drag is
 * under way the box is grown to the whole visible screen, where the point
 * can roam and every reversal is a cell crossed, and shrunk back to its strip
 * when the finger rests. The finger is on the keys for the whole of that, so
 * the grown box takes no tap from anything. Growing moves the cells under
 * the point, so the first caret position after it only says where the
 * caret now is.
 *
 * # Keeping the caret inside a short box
 *
 * The box is a handful of rows tall, and the floating cursor clamps at its
 * edge. When the caret reaches an edge row the pad is scrolled one line the
 * other way, so the caret is drawn a row in; the next move puts it on the edge
 * again, one cell further along the pad. That scroll is let happen only every
 * [`EDGE_REPEAT_MS`] (less as the gain rises): iOS reports a finger past the
 * edge many times a second, and a scroll on every report was ten lines of
 * history for a twitch (2026-09-04, on the phone). So a finger held past the
 * edge repeats at a steady rate, and stops with the finger — no report, no
 * scroll, no press. The pad itself is re-centred when the caret nears its
 * border, and when the finger rests.
 *
 * # One axis at a time, split at 45°, and gain
 *
 * A move is read on one axis: ← in the middle of ↑↑↑ would move the cursor
 * into the recalled line. Which axis is the one the finger is going along
 * *now*, split at 45° — a drag that goes up and then turns right is ↑↑↑ then
 * →→→, without lifting (the owner, 2026-09-04). "Now" is the last few cells
 * with the older ones fading, so one sideways cell in a vertical run does not
 * turn the run, and a tie stays on the axis the drag is already on.
 *
 * # Speed
 *
 * Every press goes out the moment its cell is crossed. A queue was tried and
 * felt like lag — the finger was up and the prompt still walking (2026-09-04,
 * on the phone). So speed is in the pad's geometry and in the gain: a row is
 * taller than a column, so a line of history costs more finger than a
 * character of cursor; and a cell is worth more presses the further the
 * finger has travelled along the axis since the drag took it. A short pull
 * steps; a long pull runs; drawing it back slows it down — which is how a
 * joystick reads.
 *
 * While the gain is up the pill shows the arrow as a double chevron (Figma
 * 3319:85086).
 */

export type TrackpadDirection = "left" | "right" | "up" | "down";

/** Rows and columns of the pad. Odd, so it has a centre cell. */
export const PAD_ROWS = 41;
export const PAD_COLS = 81;
/**
 * Ideographic space: one full em wide, so a cell is as tall as it is wide, and
 * nothing to see if the field is ever visible.
 */
export const PAD_CHAR = "　";
/** The pad's text, as the field holds it. */
export const PAD_TEXT = Array.from({ length: PAD_ROWS }, () => PAD_CHAR.repeat(PAD_COLS)).join("\n");
/** Caret offset of the centre cell. */
export const PAD_CENTER = Math.floor(PAD_ROWS / 2) * (PAD_COLS + 1) + Math.floor(PAD_COLS / 2);

/** A finger resting this long has left, and the next move is a new drag. */
export const GESTURE_GAP_MS = 400;
/**
 * How much of the recent motion survives each move. At this, a run of cells
 * settles at two and a half cells of memory: one stray sideways cell does not
 * turn a vertical run, two in a row do.
 */
export const RECENT_DECAY = 0.6;
/** Cells of travel along the axis per step of gain. */
export const GAIN_STEP = 8;
export const MAX_GAIN = 3;
/** The gain from which the drag is *fast*, and shown as such. */
export const FAST_GAIN = 2;
/**
 * A move bigger than this in one event is not a finger — it is the caret
 * being placed (focus, a tap on the field) — and it is re-centred, not sent.
 * A phone's width in cells, so no drag inside the box can reach it.
 */
export const MAX_CELLS_PER_MOVE = 24;
/**
 * The first move of a drag that is this far from where the caret rested is
 * the floating cursor being *put down* somewhere else, not a finger crossing
 * cells: iOS starts the cursor from its own idea of the caret's rect. That
 * move only tells the pad where the caret now is; the drag is read from there.
 */
export const PLACEMENT_CELLS = 3;
/**
 * How often the caret is read while the field has focus. `selectionchange`
 * is the signal; the poll is for a WebKit that moves the caret under the
 * floating cursor without dispatching it — nothing on this phone has proved
 * it does, and a missed move here is the whole gesture doing nothing.
 */
export const POLL_MS = 50;
/** So a single event cannot flood the session. */
export const MAX_PRESSES_PER_MOVE = 40;
/** This close to the pad's border the caret is brought back to the middle. */
const EDGE_CELLS = 4;
/** Set on the document while a drag is under way; the stylesheet grows the box. */
export const DRAG_ATTRIBUTE = "data-space-drag";
/**
 * A finger held past the box's edge repeats one cell this often at gain 1.
 * The gain divides it.
 */
export const EDGE_REPEAT_MS = 180;
/** The pad's cell, in CSS pixels, when the stylesheet cannot be asked. */
const DEFAULT_CELL = 16;

export interface PadCell {
  readonly row: number;
  readonly col: number;
}

/** Which cell a caret offset sits in. */
export function cellOf(offset: number): PadCell {
  const row = Math.floor(offset / (PAD_COLS + 1));
  return { row, col: offset - row * (PAD_COLS + 1) };
}

/**
 * One drag, as it stands between two caret moves.
 *
 * `travel` is signed displacement along the current axis since the drag took
 * it, which is what the gain is read from. `rows` and `cols` are the recent
 * motion, fading by [`RECENT_DECAY`] each move, which is what the axis is
 * read from.
 */
export interface TrackpadGesture {
  readonly axis: "x" | "y" | undefined;
  readonly travel: number;
  readonly lastAt: number;
  readonly rows: number;
  readonly cols: number;
}

export const IDLE_GESTURE: TrackpadGesture = {
  axis: undefined,
  travel: 0,
  lastAt: Number.NEGATIVE_INFINITY,
  rows: 0,
  cols: 0,
};

export interface TrackpadMove {
  readonly gesture: TrackpadGesture;
  readonly presses: readonly TrackpadDirection[];
  /** Presses a cell was worth: 1 for a short pull, up to [`MAX_GAIN`]. */
  readonly gain: number;
}

/**
 * The presses a caret move is worth. `rows` and `cols` are the cells crossed
 * since the last move, signed the way the pad reads: down and right positive.
 */
export function trackpadMove(
  gesture: TrackpadGesture,
  rows: number,
  cols: number,
  now: number,
): TrackpadMove {
  const start = now - gesture.lastAt > GESTURE_GAP_MS ? { ...IDLE_GESTURE, lastAt: now } : gesture;
  if (rows === 0 && cols === 0) return { gesture: start, presses: [], gain: gainOf(start.travel) };
  const recentRows = start.rows * RECENT_DECAY + rows;
  const recentCols = start.cols * RECENT_DECAY + cols;
  // Split at 45°. A tie stays where the drag is; a drag that has nowhere to
  // stay yet goes vertical, which is what the gesture is mostly for.
  const lean = Math.abs(recentCols) - Math.abs(recentRows);
  const axis = lean > 0 ? "x" : lean < 0 ? "y" : (start.axis ?? "y");
  // Turning resets the run: the gain belongs to the pull along one axis.
  const travelSoFar = axis === start.axis ? start.travel : 0;
  const delta = axis === "y" ? rows : cols;
  if (delta === 0) {
    return {
      gesture: { axis, travel: travelSoFar, lastAt: now, rows: recentRows, cols: recentCols },
      presses: [],
      gain: gainOf(travelSoFar),
    };
  }
  const travel = travelSoFar + delta;
  const gain = gainOf(travel);
  const direction: TrackpadDirection =
    axis === "y" ? (delta < 0 ? "up" : "down") : delta < 0 ? "left" : "right";
  const count = Math.min(MAX_PRESSES_PER_MOVE, Math.abs(delta) * gain);
  return {
    gesture: { axis, travel, lastAt: now, rows: recentRows, cols: recentCols },
    presses: Array.from({ length: count }, () => direction),
    gain,
  };
}

/** The gain a pull of `travel` cells along its axis has reached. */
export function gainOf(travel: number): number {
  return Math.min(MAX_GAIN, 1 + Math.floor(Math.abs(travel) / GAIN_STEP));
}

/**
 * What was typed into a field that held `pad`, given what it holds now.
 *
 * Typing inserts at the caret, somewhere in the middle of the pad, so the
 * insertion is whatever is left once the pad's own prefix and suffix are
 * matched off. A value shorter than the pad is a deletion — Backspace that the
 * keydown handler did not catch — and there is nothing typed in it.
 */
export function insertedText(pad: string, value: string): string {
  if (value === pad) return "";
  const shortest = Math.min(pad.length, value.length);
  let prefix = 0;
  while (prefix < shortest && pad[prefix] === value[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    pad[pad.length - 1 - suffix] === value[value.length - 1 - suffix]
  )
    suffix += 1;
  const end = value.length - suffix;
  return end > prefix ? value.slice(prefix, end) : "";
}

export interface TrackpadHooks {
  /** Release native text before the pad takes ownership of its caret. */
  readonly begin?: () => void;
  readonly press: (direction: TrackpadDirection) => void;
  /**
   * Which way the drag is going, or `undefined` once the finger has rested;
   * and whether it is going fast.
   */
  readonly direction: (direction: TrackpadDirection | undefined, fast: boolean) => void;
  readonly now?: () => number;
}

export interface SpaceTrackpad {
	/** Observe typing without changing the native keyboard's editing context. */
	readonly read: () => string;
  /**
   * What has been typed since the last take, with the pad put back under the
   * caret. The field's owner calls this where it used to read `value` — the
   * pad is the field's content now, and `value` is the pad plus the typing.
   */
  readonly take: () => string;
  readonly dispose: () => void;
}

/**
 * Turns `field` into a pad, and its caret moves into presses.
 *
 * The listener sits on the document because that is where `selectionchange`
 * is dispatched; it acts only while `field` holds focus.
 */
export function attachSpaceTrackpad(
  field: HTMLTextAreaElement,
  hooks: TrackpadHooks,
): SpaceTrackpad {
  const now = hooks.now ?? Date.now;
  let gesture = IDLE_GESTURE;
  /** Where the caret was last seen, so the next move is read against it. */
  let expected = PAD_CENTER;
  let editingValue = PAD_TEXT;
  let rest: ReturnType<typeof setTimeout> | undefined;

  /**
   * A cell as it was actually laid out. Measured from the pad rather than read
   * from the stylesheet: the pad's glyph comes from whichever font the phone
   * falls back to, and that font's line can stand taller than the line-height
   * the stylesheet asked for.
   */
  const cell = (): { readonly width: number; readonly height: number } => ({
    width: field.scrollWidth / PAD_COLS || DEFAULT_CELL,
    height: field.scrollHeight / PAD_ROWS || DEFAULT_CELL,
  });

  const recenter = (): void => {
    if (field.value !== PAD_TEXT) field.value = PAD_TEXT;
    editingValue = PAD_TEXT;
    field.setSelectionRange(PAD_CENTER, PAD_CENTER);
    expected = field.selectionStart;
    // The caret in the middle of the *box*, not only of the pad: the floating
    // cursor is clamped to the box, so the room to drag is whatever shows
    // around the caret.
    const size = cell();
    field.scrollTop = Math.max(
      0,
      (Math.floor(PAD_ROWS / 2) + 0.5) * size.height - field.clientHeight / 2,
    );
    field.scrollLeft = Math.max(
      0,
      (Math.floor(PAD_COLS / 2) + 0.5) * size.width - field.clientWidth / 2,
    );
  };

  /**
   * A caret drawn on an edge row or column of the box is scrolled one cell in,
   * so the clamped cursor has a cell to cross on its next move — at most once
   * per [`EDGE_REPEAT_MS`] over the gain.
   */
  let nudgedAt = Number.NEGATIVE_INFINITY;
  const nudge = (at: PadCell, stamp: number, gain: number): void => {
    // No box has been laid out (a test): nothing to be at the edge of.
    if (field.clientHeight === 0 || field.clientWidth === 0) return;
    if (stamp - nudgedAt < EDGE_REPEAT_MS / gain) return;
    const size = cell();
    const top = at.row * size.height - field.scrollTop;
    const left = at.col * size.width - field.scrollLeft;
    let moved = false;
    if (top < size.height) {
      field.scrollTop = Math.max(0, field.scrollTop - size.height);
      moved = true;
    } else if (top > field.clientHeight - 2 * size.height) {
      field.scrollTop += size.height;
      moved = true;
    }
    if (left < size.width) {
      field.scrollLeft = Math.max(0, field.scrollLeft - size.width);
      moved = true;
    } else if (left > field.clientWidth - 2 * size.width) {
      field.scrollLeft += size.width;
      moved = true;
    }
    if (moved) nudgedAt = stamp;
  };

  let grown = false;
  /** The next caret position only says where the caret is; see `grow`. */
  let resync = false;
  const grow = (): void => {
    if (grown) return;
    grown = true;
    document.documentElement.setAttribute(DRAG_ATTRIBUTE, "on");
    recenter();
    resync = true;
  };
  const shrink = (): void => {
    if (!grown) return;
    grown = false;
    resync = false;
    document.documentElement.removeAttribute(DRAG_ATTRIBUTE);
  };

  const settle = (): void => {
    rest = undefined;
    gesture = IDLE_GESTURE;
    hooks.direction(undefined, false);
    shrink();
    if (document.activeElement === field && field.value === PAD_TEXT) recenter();
  };

  const onSelection = (): void => {
    // A field the screen has re-rendered away is never focused again; its
    // listener goes with it rather than staying on the document for good.
    if (!field.isConnected) {
      dispose();
      return;
    }
    if (document.activeElement !== field || field.disabled) return;
    // Typing or a composition in progress: the caret is the keyboard's, not a
    // finger's.
    if (field.value !== editingValue) return;
    const at = field.selectionStart;
    if (at === expected) return;
    if (field.selectionEnd !== at) {
      if (editingValue !== PAD_TEXT) return;
      // A range, from the selection handles. Not a drag, and not something a
      // pad can hold.
      recenter();
      return;
    }
    if (resync) {
      resync = false;
      expected = at;
      return;
    }
    const from = cellOf(expected);
    const to = cellOf(at);
    const rows = to.row - from.row;
    const cols = to.col - from.col;
    const span = Math.max(Math.abs(rows), Math.abs(cols));
    if (span > MAX_CELLS_PER_MOVE) {
      if (editingValue !== PAD_TEXT) hooks.begin?.();
      recenter();
      return;
    }
    const stamp = now();
    if (span > PLACEMENT_CELLS && stamp - gesture.lastAt > GESTURE_GAP_MS) {
      // Put down, not dragged: from here the drag is read against this spot.
      expected = at;
      gesture = { ...IDLE_GESTURE, lastAt: stamp };
      return;
    }
    const move = trackpadMove(gesture, rows, cols, stamp);
    gesture = move.gesture;
    expected = at;
    const atEdge =
      to.row < EDGE_CELLS ||
      to.row >= PAD_ROWS - EDGE_CELLS ||
      to.col < EDGE_CELLS ||
      to.col >= PAD_COLS - EDGE_CELLS;
    if (editingValue !== PAD_TEXT && (atEdge || move.presses.length > 0)) hooks.begin?.();
    if (atEdge) {
      recenter();
    } else {
      nudge(to, stamp, move.gain);
    }
    if (move.presses.length === 0) return;
    for (const press of move.presses) hooks.press(press);
    hooks.direction(move.presses[move.presses.length - 1], move.gain >= FAST_GAIN);
    if (rest !== undefined) clearTimeout(rest);
    rest = setTimeout(settle, GESTURE_GAP_MS);
    grow();
  };

  let poll: ReturnType<typeof setInterval> | undefined;
  const onFocus = (): void => {
    recenter();
    if (poll === undefined) poll = setInterval(onSelection, POLL_MS);
  };
  const onBlur = (): void => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    if (rest !== undefined) clearTimeout(rest);
    rest = undefined;
    gesture = IDLE_GESTURE;
    shrink();
    hooks.direction(undefined, false);
  };
  // The box exists only once the keys are up: the caret parked at focus was
  // parked in a one-pixel box, and would sit at the top of the real one.
  const onViewport = (): void => {
    if (document.activeElement !== field || field.value !== PAD_TEXT) return;
    gesture = IDLE_GESTURE;
    recenter();
  };

  const dispose = (): void => {
    onBlur();
    document.removeEventListener("selectionchange", onSelection);
    field.removeEventListener("focus", onFocus);
    field.removeEventListener("blur", onBlur);
    window.visualViewport?.removeEventListener("resize", onViewport);
  };

  recenter();
  document.addEventListener("selectionchange", onSelection);
  field.addEventListener("focus", onFocus);
  field.addEventListener("blur", onBlur);
  window.visualViewport?.addEventListener("resize", onViewport);

  return {
    read: () => {
      editingValue = field.value;
      expected = field.selectionStart;
      return insertedText(PAD_TEXT, field.value);
    },
    take: () => {
      const typed = insertedText(PAD_TEXT, field.value);
      recenter();
      return typed;
    },
    dispose,
  };
}

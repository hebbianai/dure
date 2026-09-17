import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAG_ATTRIBUTE,
  FAST_GAIN,
  GAIN_STEP,
  GESTURE_GAP_MS,
  IDLE_GESTURE,
  MAX_GAIN,
  MAX_PRESSES_PER_MOVE,
  PAD_CENTER,
  PAD_COLS,
  PAD_ROWS,
  PAD_TEXT,
  PLACEMENT_CELLS,
  type TrackpadDirection,
  attachSpaceTrackpad,
  cellOf,
  gainOf,
  insertedText,
  trackpadMove,
} from "./spaceTrackpad";

describe("the pad", () => {
  it("parks the caret in the middle cell", () => {
    expect(PAD_ROWS % 2).toBe(1);
    expect(PAD_COLS % 2).toBe(1);
    expect(cellOf(PAD_CENTER)).toEqual({ row: (PAD_ROWS - 1) / 2, col: (PAD_COLS - 1) / 2 });
    expect(PAD_TEXT.split("\n")).toHaveLength(PAD_ROWS);
  });

  it("finds what was typed between the pad's halves", () => {
    const at = (offset: number, text: string): string =>
      PAD_TEXT.slice(0, offset) + text + PAD_TEXT.slice(offset);
    expect(insertedText(PAD_TEXT, PAD_TEXT)).toBe("");
    expect(insertedText(PAD_TEXT, at(PAD_CENTER, "git"))).toBe("git");
    expect(insertedText(PAD_TEXT, at(PAD_CENTER, "한"))).toBe("한");
    expect(insertedText(PAD_TEXT, at(0, "a"))).toBe("a");
    expect(insertedText(PAD_TEXT, at(PAD_TEXT.length, "z"))).toBe("z");
    // A pad character was deleted: nothing typed.
    expect(insertedText(PAD_TEXT, PAD_TEXT.slice(1))).toBe("");
  });
});

describe("trackpadMove", () => {
  it("turns rows into ↑↓ and columns into ←→", () => {
    expect(trackpadMove(IDLE_GESTURE, -2, 0, 0).presses).toEqual(["up", "up"]);
    expect(trackpadMove(IDLE_GESTURE, 1, 0, 0).presses).toEqual(["down"]);
    expect(trackpadMove(IDLE_GESTURE, 0, -3, 0).presses).toEqual(["left", "left", "left"]);
    expect(trackpadMove(IDLE_GESTURE, 0, 1, 0).presses).toEqual(["right"]);
  });

  it("splits at 45°, and a tie goes vertical", () => {
    expect(trackpadMove(IDLE_GESTURE, -1, 2, 0).presses).toEqual(["right", "right"]);
    expect(trackpadMove(IDLE_GESTURE, -2, 1, 0).presses).toEqual(["up", "up"]);
    expect(trackpadMove(IDLE_GESTURE, -1, 1, 0).presses).toEqual(["up"]);
  });

  it("stays on its axis through a sideways cell, and a tie stays put", () => {
    let gesture = trackpadMove(IDLE_GESTURE, -1, 0, 0).gesture;
    gesture = trackpadMove(gesture, -1, 0, 16).gesture;
    gesture = trackpadMove(gesture, -1, 0, 24).gesture;
    // One sideways cell in a vertical run sends nothing and changes nothing.
    const drift = trackpadMove(gesture, 0, 1, 32);
    expect(drift.presses).toEqual([]);
    expect(drift.gesture.axis).toBe("y");
    // A diagonal cell is a tie on the recent motion: still vertical.
    const diagonal = trackpadMove(drift.gesture, -1, 1, 48);
    expect(diagonal.presses).toEqual(["up"]);
  });

  it("turns with the finger without lifting", () => {
    let gesture = IDLE_GESTURE;
    const sent: TrackpadDirection[] = [];
    const move = (rows: number, cols: number, at: number): void => {
      const next = trackpadMove(gesture, rows, cols, at);
      gesture = next.gesture;
      sent.push(...next.presses);
    };
    move(-1, 0, 0);
    move(-1, 0, 16);
    move(-1, 0, 32);
    // Turning right: the first sideways cells are outweighed by the run so
    // far, then the run fades and the drag is sideways.
    move(0, 1, 48);
    move(0, 1, 64);
    move(0, 1, 80);
    expect(gesture.axis).toBe("x");
    expect(sent.slice(0, 3)).toEqual(["up", "up", "up"]);
    expect(sent.slice(3).every((direction) => direction === "right")).toBe(true);
    expect(sent.length).toBeGreaterThan(3);
    // And back up again.
    move(-1, 0, 96);
    move(-1, 0, 112);
    move(-1, 0, 128);
    expect(gesture.axis).toBe("y");
    expect(sent[sent.length - 1]).toBe("up");
  });

  it("starts a new drag once the finger has rested", () => {
    const vertical = trackpadMove(IDLE_GESTURE, -2, 0, 0);
    const later = trackpadMove(vertical.gesture, 0, 1, GESTURE_GAP_MS + 1);
    expect(later.gesture.axis).toBe("x");
    expect(later.presses).toEqual(["right"]);
  });

  it("presses faster the further the drag has travelled, and slows on the way back", () => {
    let gesture = IDLE_GESTURE;
    const sent: TrackpadDirection[] = [];
    for (let step = 0; step < GAIN_STEP - 1; step += 1) {
      const move = trackpadMove(gesture, -1, 0, step);
      gesture = move.gesture;
      sent.push(...move.presses);
    }
    // Short of GAIN_STEP cells of travel a cell is one press; the cell that
    // reaches it is worth two.
    expect(sent).toHaveLength(GAIN_STEP - 1);
    expect(gainOf(gesture.travel)).toBe(1);
    const faster = trackpadMove(gesture, -1, 0, GAIN_STEP);
    expect(faster.presses).toEqual(["up", "up"]);
    expect(faster.gain).toBe(2);
    // Drawn back towards the start, the gain drops with the travel.
    const back = trackpadMove(faster.gesture, GAIN_STEP, 0, GAIN_STEP + 1);
    expect(back.gesture.travel).toBe(0);
    expect(back.gain).toBe(1);
    expect(back.presses.every((direction) => direction === "down")).toBe(true);
    // Turning starts the run over: the first sideways cells are not fast.
    let turned = back.gesture;
    for (let step = 0; step < 4; step += 1) {
      turned = trackpadMove(turned, 0, 1, GAIN_STEP + 2 + step).gesture;
    }
    expect(turned.axis).toBe("x");
    expect(gainOf(turned.travel)).toBe(1);
  });

  it("never sends more than the cap in one move, and the gain tops out", () => {
    const far = trackpadMove(
      { axis: "y", travel: 100, lastAt: 0, rows: 0, cols: 0 },
      MAX_PRESSES_PER_MOVE,
      0,
      1,
    );
    expect(far.presses).toHaveLength(MAX_PRESSES_PER_MOVE);
    expect(far.gain).toBe(MAX_GAIN);
  });
});

describe("attachSpaceTrackpad", () => {
  let field: HTMLTextAreaElement;
  let pressed: TrackpadDirection[];
  let shown: (TrackpadDirection | undefined)[];
  let fastShown: boolean[];
  let clock: number;
  let pads: { dispose: () => void }[];

  const caretTo = (rows: number, cols: number): void => {
    const at = field.selectionStart + rows * (PAD_COLS + 1) + cols;
    field.setSelectionRange(at, at);
    document.dispatchEvent(new Event("selectionchange"));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    field = document.createElement("textarea");
    document.body.append(field);
    pressed = [];
    shown = [];
    fastShown = [];
    pads = [];
  });

  afterEach(() => {
    // Detached here, not left to self-dispose: a pad from the last test would
    // otherwise report its own disposal into this test's log.
    for (const pad of pads) pad.dispose();
    expect(document.documentElement.getAttribute(DRAG_ATTRIBUTE)).toBeNull();
    field.remove();
    vi.useRealTimers();
  });

  const attach = () => {
    const pad = attachSpaceTrackpad(field, {
      press: (direction) => pressed.push(direction),
      direction: (direction, fast) => {
        shown.push(direction);
        fastShown.push(fast);
      },
      now: () => clock,
    });
    pads.push(pad);
    return pad;
  };

  it("fills the field with the pad and parks the caret in the middle", () => {
    attach();
    expect(field.value).toBe(PAD_TEXT);
    expect(field.selectionStart).toBe(PAD_CENTER);
  });

  it("reads a caret moved up as ↑ presses, at once, and says which way it is going", () => {
    attach();
    field.focus();
    caretTo(-2, 0);
    expect(pressed).toEqual(["up", "up"]);
    expect(shown).toEqual(["up"]);
    expect(fastShown).toEqual([false]);
    // The drag is under way: the box has grown and the caret was re-parked
    // in the middle of it, so the next position only says where it is.
    expect(document.documentElement.getAttribute(DRAG_ATTRIBUTE)).toBe("on");
    expect(field.selectionStart).toBe(PAD_CENTER);
    caretTo(-3, 0);
    expect(pressed).toEqual(["up", "up"]);
    // From there the caret is read where it lands, not pushed back under a
    // finger that is still down.
    caretTo(-1, 0);
    expect(pressed).toEqual(["up", "up", "up"]);
    expect(field.selectionStart).toBe(PAD_CENTER - 4 * (PAD_COLS + 1));
    // Resting shrinks the box again.
    vi.advanceTimersByTime(GESTURE_GAP_MS);
    expect(document.documentElement.getAttribute(DRAG_ATTRIBUTE)).toBeNull();
  });

  it("presses more per cell on a long pull, and shows it", () => {
    attach();
    field.focus();
    // One more than the step: the first move grows the box, and the position
    // after that only re-reads the caret.
    for (let step = 0; step < GAIN_STEP + 1; step += 1) {
      caretTo(-1, 0);
      clock += 16;
    }
    expect(fastShown[fastShown.length - 1]).toBe(true);
    expect(gainOf(-GAIN_STEP)).toBe(FAST_GAIN);
    // The cell that reached the step was worth two.
    expect(pressed).toHaveLength(GAIN_STEP + 1);
    // And nothing more comes once the finger has stopped.
    vi.advanceTimersByTime(GESTURE_GAP_MS);
    expect(pressed).toHaveLength(GAIN_STEP + 1);
  });

  it("re-centres and clears the direction once the finger rests", () => {
    attach();
    field.focus();
    caretTo(0, 3);
    expect(pressed).toEqual(["right", "right", "right"]);
    caretTo(0, 2);
    caretTo(0, 1);
    expect(pressed).toHaveLength(4);
    expect(field.selectionStart).not.toBe(PAD_CENTER);
    vi.advanceTimersByTime(GESTURE_GAP_MS);
    expect(shown).toEqual(["right", "right", undefined]);
    expect(field.selectionStart).toBe(PAD_CENTER);
  });

  it("ignores the caret while something is being typed, and hands the typing back", () => {
    const pad = attach();
    field.focus();
    field.value = `${PAD_TEXT.slice(0, PAD_CENTER)}ls${PAD_TEXT.slice(PAD_CENTER)}`;
    field.setSelectionRange(PAD_CENTER + 2, PAD_CENTER + 2);
    document.dispatchEvent(new Event("selectionchange"));
    expect(pressed).toEqual([]);
    expect(pad.take()).toBe("ls");
    expect(field.value).toBe(PAD_TEXT);
    expect(field.selectionStart).toBe(PAD_CENTER);
    expect(pad.take()).toBe("");
  });

  it("reads a far first move as the cursor being put down, and drags from there", () => {
    attach();
    field.focus();
    caretTo(-(PLACEMENT_CELLS + 2), 0);
    expect(pressed).toEqual([]);
    expect(field.selectionStart).toBe(PAD_CENTER - (PLACEMENT_CELLS + 2) * (PAD_COLS + 1));
    clock += 16;
    caretTo(-1, 0);
    expect(pressed).toEqual(["up"]);
    expect(document.documentElement.getAttribute(DRAG_ATTRIBUTE)).toBe("on");
  });

  it("treats a jump as the caret being placed, not a drag", () => {
    attach();
    field.focus();
    field.setSelectionRange(PAD_TEXT.length, PAD_TEXT.length);
    document.dispatchEvent(new Event("selectionchange"));
    expect(pressed).toEqual([]);
    expect(field.selectionStart).toBe(PAD_CENTER);
  });

  it("does nothing for a field that is not focused, and stops once disposed", () => {
    const pad = attach();
    const at = PAD_CENTER - (PAD_COLS + 1);
    field.setSelectionRange(at, at);
    document.dispatchEvent(new Event("selectionchange"));
    expect(pressed).toEqual([]);
    field.focus();
    field.setSelectionRange(PAD_CENTER, PAD_CENTER);
    pad.dispose();
    caretTo(-1, 0);
    expect(pressed).toEqual([]);
  });
});

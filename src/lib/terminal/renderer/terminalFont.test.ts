import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_LINE_HEIGHT,
  normalizeTerminalLineHeight,
} from "./terminalFont";

describe("normalizeTerminalLineHeight", () => {
  it("rounds valid input to the supported visual rhythm", () => {
    expect(normalizeTerminalLineHeight("1.43")).toBe(1.45);
  });

  it("clamps extremes and defaults malformed persisted values", () => {
    expect(normalizeTerminalLineHeight(0.2)).toBe(1);
    expect(normalizeTerminalLineHeight(9)).toBe(2);
    expect(normalizeTerminalLineHeight("not-a-number")).toBe(
      DEFAULT_TERMINAL_LINE_HEIGHT,
    );
    expect(normalizeTerminalLineHeight("")).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
    expect(normalizeTerminalLineHeight(null)).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
  });
});

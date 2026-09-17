import { describe, expect, it } from "vitest";
import { coloredViewportFrameRecord } from "../tools/media-capture/runtime/colored-viewport.mjs";
import { viewportFrameRecord } from "../src/test/terminalRecordFixtures.ts";
import { decodeTerminalStateRecord } from "../src/lib/terminal/protocol/terminalStateProtocol.ts";
import { visibleProviderText } from "../tools/media-capture/providers/privacy.mjs";
import { ColorKind } from "../src/contracts/terminalStateProtocol.ts";

function render(screen, rows = 4, columns = 40, builder = coloredViewportFrameRecord) {
  const texts = visibleProviderText(screen).replaceAll("\r", "").split("\n").slice(-rows).map(line => Array.from(line).slice(0, columns).join(""));
  const frame = decodeTerminalStateRecord(builder({ texts, columns, ansiScreen: screen, sourceRows: rows })).record.body.value;
  return frame.rows.map(row => row.cells.map(cell => ({ text: frame.tables.graphemes[cell.graphemeIndex].text, style: frame.tables.styles[cell.styleIndex] })));
}

describe("capture fixture ANSI color projection", () => {
  it("preserves provider colors and reset through the actual binary viewport record", () => {
    const screen = "\x1b[38;5;75m• Read\x1b[0m file\r\n\x1b[32m✓ passed\x1b[0m";
    expect(render(screen, 4, 40, viewportFrameRecord)[0][0].style.foreground).toBeUndefined();
    const rows = render(screen);
    expect(rows[0][0].style.foreground).toMatchObject({ kind: ColorKind.PALETTE, value: 75 });
    expect(rows[0][6].style.foreground).toBeUndefined();
    expect(rows[1][0].style.foreground).toMatchObject({ kind: ColorKind.PALETTE, value: 2 });
  });

  it("retains paint across clipped rows, non-BMP text, and column clipping", () => {
    const rows = render("\x1b[35momitted\r\n😀ab\r\ncdef", 2, 3);
    expect(rows.map(row => row.map(cell => cell.text).join(""))).toEqual(["😀ab", "cde"]);
    expect(rows.flat().every(cell => cell.style.foreground.value === 5)).toBe(true);
  });

  it("projects RGB, background, bold/faint and individual resets", () => {
    const rows = render("\x1b[1;2;38;2;10;20;30;48;5;60mA\x1b[22;39;49mB");
    expect(rows[0][0].style).toMatchObject({ flags: 3n, foreground: { kind: ColorKind.RGB, value: 0x0a141e }, background: { kind: ColorKind.PALETTE, value: 60 } });
    expect(rows[0][1].style).toMatchObject({ flags: 0n });
    expect(rows[0][1].style.foreground).toBeUndefined();
    expect(rows[0][1].style.background).toBeUndefined();
  });
});

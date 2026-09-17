// Fixture projection only: retain SGR paint through the structured protocol.
// Cursor movement remains governed by the capture harness's visible-text recipe.
import { create } from "@bufbuild/protobuf";
import { CellStyleSchema, ColorKind, TerminalColorSchema, UnderlineKind } from "../../../src/contracts/terminalStateProtocol.ts";
import { viewportFrameRecord } from "../../../src/test/terminalRecordFixtures.ts";
import { decodeTerminalStateRecord, encodeTerminalStateRecord } from "../../../src/lib/terminal/protocol/terminalStateProtocol.ts";
import { visibleTextWithRawOffsets } from "../providers/privacy.mjs";

function sgrStyle(previous, parameters) {
  let style = { ...previous };
  const values = parameters.split(";").map(Number);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const color = (kind, value) => create(TerminalColorSchema, { kind, value });
    if (value === 0) style = {};
    else if (value === 1) style.flags = (style.flags ?? 0n) | 1n;
    else if (value === 2) style.flags = (style.flags ?? 0n) | 2n;
    else if (value === 3) style.flags = (style.flags ?? 0n) | 4n;
    else if (value === 22) style.flags = (style.flags ?? 0n) & ~3n;
    else if (value === 23) style.flags = (style.flags ?? 0n) & ~4n;
    else if (value === 39) delete style.foreground;
    else if (value === 49) delete style.background;
    else if (value >= 30 && value <= 37) style.foreground = color(ColorKind.PALETTE, value - 30);
    else if (value >= 40 && value <= 47) style.background = color(ColorKind.PALETTE, value - 40);
    else if (value >= 90 && value <= 97) style.foreground = color(ColorKind.PALETTE, value - 90 + 8);
    else if (value >= 100 && value <= 107) style.background = color(ColorKind.PALETTE, value - 100 + 8);
    else if (value === 38 || value === 48) {
      const channel = value === 38 ? "foreground" : "background";
      const mode = values[++i];
      if (mode === 5 && values[i + 1] >= 0 && values[i + 1] <= 255) {
        style[channel] = color(ColorKind.PALETTE, values[++i]);
      } else if (mode === 2 && values.slice(i + 1, i + 4).length === 3 && values.slice(i + 1, i + 4).every(value => value >= 0 && value <= 255)) {
        style[channel] = color(ColorKind.RGB, (values[++i] << 16) | (values[++i] << 8) | values[++i]);
      }
    }
  }
  return style;
}

export function coloredViewportFrameRecord({ ansiScreen = "", ...options }) {
  const { visible, rawOffsets } = visibleTextWithRawOffsets(ansiScreen);
  const changes = [...ansiScreen.matchAll(/\u001b\[([\d;]*)m/g)];
  const lines = [[]];
  let offset = 0;
  let next = 0;
  let style = {};
  for (const character of visible) {
    while (next < changes.length && changes[next].index < rawOffsets[offset]) {
      style = sgrStyle(style, changes[next++][1]);
    }
    offset += character.length;
    if (character === "\n") lines.push([]);
    else if (character !== "\r") lines.at(-1).push(style);
  }
  const decoded = decodeTerminalStateRecord(viewportFrameRecord(options));
  const frame = decoded.record.body.value;
  const visibleLines = lines.slice(-options.sourceRows);
  const styles = frame.tables.styles;
  const keys = new Map();
  for (let row = 0; row < frame.rows.length; row++) {
    for (let column = 0; column < frame.rows[row].cells.length; column++) {
      const paint = visibleLines[row]?.[column] ?? {};
      const key = JSON.stringify(paint, (_, value) => typeof value === "bigint" ? String(value) : value);
      if (!keys.has(key)) {
        keys.set(key, styles.length);
        styles.push(create(CellStyleSchema, { ...paint, underline: UnderlineKind.NONE }));
      }
      frame.rows[row].cells[column].styleIndex = keys.get(key);
    }
  }
  return encodeTerminalStateRecord(decoded.metadata.recordId, decoded.record);
}

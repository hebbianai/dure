// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  beginSpacesRowDrag,
  currentSpacesRowDrag,
  endSpacesRowDrag,
  parseSpacesDragPayload,
  resolveSpacesDragItems,
  spacesDragPayload,
  writeSpacesPaneDragData,
} from "@/lib/spaces/spacesDrag";
import {
  parsePaneTransferPayload,
  PANE_TRANSFER_MIME,
} from "@/lib/workspace/pane/paneWindowTransfer";
import { getDragState, setDragState } from "@/lib/workspace/pane/paneDragState";

const spaces = [
  { key: "agent:a", desktopId: "d1" },
  { key: "term:b", desktopId: "d1" },
  { key: "agent:c", desktopId: "d2" },
];

describe("resolveSpacesDragItems", () => {
  it("drags only the grabbed row when it is not part of the selection", () => {
    expect(resolveSpacesDragItems(spaces, new Set(["term:b"]), "agent:c")).toEqual([
      { panelId: "agent:c", fromDesktopId: "d2" },
    ]);
  });

  it("drags the whole selection when the grabbed row is selected", () => {
    expect(
      resolveSpacesDragItems(spaces, new Set(["agent:a", "agent:c"]), "agent:a"),
    ).toEqual([
      { panelId: "agent:a", fromDesktopId: "d1" },
      { panelId: "agent:c", fromDesktopId: "d2" },
    ]);
  });
});

describe("spacesDragPayload", () => {
  it("encodes the canonical Dure move-panels payload Workspace parses", () => {
    const raw = spacesDragPayload([{ panelId: "agent:a", fromDesktopId: "d1" }]);
    expect(raw.startsWith("dure:")).toBe(true);
    expect(raw).not.toContain("hebbian");
    expect(JSON.parse(raw.slice(5))).toEqual({
      type: "move-panels",
      items: [{ panelId: "agent:a", fromDesktopId: "d1" }],
    });
  });

  it("adds the canonical pane transfer flavor for one pane", () => {
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      setData: vi.fn((type: string, value: string) => values.set(type, value)),
    } as unknown as DataTransfer;
    const item = { panelId: "agent:a", fromDesktopId: "d1" };

    expect(writeSpacesPaneDragData(dataTransfer, [item], "main")).toEqual(item);
    expect(values.get("text/plain")).toBe(spacesDragPayload([item]));
    expect(parsePaneTransferPayload(values.get(PANE_TRANSFER_MIME) ?? "")).toEqual(
      expect.objectContaining({
        panelId: item.panelId,
        fromDesktopId: item.fromDesktopId,
        sourceWindowLabel: "main",
      }),
    );
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(getDragState()).toEqual(item);
  });

  it("keeps multi-pane movement on the bulk flavor only", () => {
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      setData: vi.fn((type: string, value: string) => values.set(type, value)),
    } as unknown as DataTransfer;
    const items = [
      { panelId: "agent:a", fromDesktopId: "d1" },
      { panelId: "agent:b", fromDesktopId: "d2" },
    ];

    expect(writeSpacesPaneDragData(dataTransfer, items, "main")).toBeNull();
    expect(values.has(PANE_TRANSFER_MIME)).toBe(false);
    expect(values.get("text/plain")).toBe(spacesDragPayload(items));
    expect(getDragState()).toBeNull();
  });
});

describe("parseSpacesDragPayload", () => {
  it("resolves a complete payload independently of cleared drag state", () => {
    const items = [
      { panelId: "agent:a", fromDesktopId: "d1" },
      { panelId: "term:b", fromDesktopId: "d2" },
    ];
    const payload = spacesDragPayload(items);
    beginSpacesRowDrag(items);
    endSpacesRowDrag();
    expect(currentSpacesRowDrag()).toBeNull();
    expect(parseSpacesDragPayload(payload)).toEqual(items);
  });

  it("parses only move-panels payloads with valid items", () => {
    const raw = spacesDragPayload([{ panelId: "agent:a", fromDesktopId: "d1" }]);
    expect(parseSpacesDragPayload(raw)).toEqual([
      { panelId: "agent:a", fromDesktopId: "d1" },
    ]);
    expect(parseSpacesDragPayload('hebbian:{"type":"agent","agentId":"x"}')).toBeNull();
    expect(parseSpacesDragPayload("plain text")).toBeNull();
    expect(
      parseSpacesDragPayload('hebbian:{"type":"move-panels","items":[{"panelId":1}]}'),
    ).toEqual([]);
  });

  it("keeps pre-rename drag payloads as read-only compatibility input", () => {
    expect(
      parseSpacesDragPayload(
        'hebbian:{"type":"move-panels","items":[{"panelId":"agent:a","fromDesktopId":"d1"}]}',
      ),
    ).toEqual([{ panelId: "agent:a", fromDesktopId: "d1" }]);
  });
});

describe("Spaces drag lifecycle", () => {
  it("keeps the row identity through WebKit's drop-listener microtask checkpoint", async () => {
    vi.useFakeTimers();
    const item = { panelId: "agent:a", fromDesktopId: "d1" };
    try {
      beginSpacesRowDrag([item]);

      window.dispatchEvent(new Event("drop"));
      await Promise.resolve();

      expect(currentSpacesRowDrag()).toEqual([item]);
      vi.runOnlyPendingTimers();
      expect(currentSpacesRowDrag()).toBeNull();
    } finally {
      endSpacesRowDrag();
      vi.useRealTimers();
    }
  });

  it("removes the unused paired listener after a cancelled drag", () => {
    const item = { panelId: "agent:a", fromDesktopId: "d1" };
    beginSpacesRowDrag([item]);
    setDragState(item);
    window.dispatchEvent(new Event("dragend"));
    expect(currentSpacesRowDrag()).toBeNull();
    expect(getDragState()).toBeNull();

    const nativePane = { panelId: "agent:native", fromDesktopId: "d2" };
    setDragState(nativePane);
    window.dispatchEvent(new Event("drop"));
    expect(getDragState()).toEqual(nativePane);
    setDragState(null);
    endSpacesRowDrag();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  preparePasteText,
  resolvePaste,
  type PasteSources,
} from "@/lib/platform/clipboardImagePaste";

const CLIPBOARD_IMAGE = { dataB64: "Y3VycmVudA==", ext: "png" };
const STALE_EVENT_IMAGE = { dataB64: "cHJldmlvdXM=", ext: "png" };

function sources(overrides: Partial<PasteSources> = {}): PasteSources {
  return {
    readClipboardImage: async () => null,
    readClipboardText: async () => null,
    readEventImage: null,
    eventText: "",
    ...overrides,
  };
}

describe("resolvePaste", () => {
  it("prefers the OS clipboard image over the webview's stale snapshot", async () => {
    const readEventImage = vi.fn(async () => STALE_EVENT_IMAGE);

    await expect(
      resolvePaste(
        sources({
          readClipboardImage: async () => CLIPBOARD_IMAGE,
          readEventImage,
        }),
      ),
    ).resolves.toEqual({ kind: "image", ...CLIPBOARD_IMAGE });
    expect(readEventImage).not.toHaveBeenCalled();
  });

  it("pastes a clipboard image the event snapshot never saw", async () => {
    // The reverse staleness: the web content process cached a text clipboard,
    // the user then copied a screenshot while the window was unfocused, so the
    // event carries only the older text.
    await expect(
      resolvePaste(
        sources({
          readClipboardImage: async () => CLIPBOARD_IMAGE,
          eventText: "previously copied text",
        }),
      ),
    ).resolves.toEqual({ kind: "image", ...CLIPBOARD_IMAGE });
  });

  it("prefers OS clipboard text over stale event text", async () => {
    await expect(
      resolvePaste(
        sources({
          readClipboardText: async () => "current",
          eventText: "previous",
        }),
      ),
    ).resolves.toEqual({ kind: "text", text: "current" });
  });

  it("falls back to the event image when no native reader is available", async () => {
    await expect(
      resolvePaste(sources({ readEventImage: async () => STALE_EVENT_IMAGE })),
    ).resolves.toEqual({ kind: "image", ...STALE_EVENT_IMAGE });
  });

  it("falls back to the event text when the clipboard readers fail", async () => {
    await expect(
      resolvePaste(
        sources({
          readClipboardImage: async () => {
            throw new Error("pasteboard unavailable");
          },
          readClipboardText: async () => {
            throw new Error("no text on clipboard");
          },
          eventText: "typed by hand",
        }),
      ),
    ).resolves.toEqual({ kind: "text", text: "typed by hand" });
  });

  it("does not read an image when only text is on the clipboard", async () => {
    // Reading a large TIFF on every text paste would stall the hot path, so the
    // image reader must stay cheap when the clipboard holds no image.
    const readClipboardImage = vi.fn(async () => null);

    await expect(
      resolvePaste(
        sources({ readClipboardImage, readClipboardText: async () => "hello" }),
      ),
    ).resolves.toEqual({ kind: "text", text: "hello" });
    expect(readClipboardImage).toHaveBeenCalledTimes(1);
  });

  it("resolves nothing when every source is empty", async () => {
    await expect(resolvePaste(sources())).resolves.toBeNull();
  });

  it("ignores an empty clipboard image and keeps looking", async () => {
    await expect(
      resolvePaste(
        sources({
          readClipboardImage: async () => ({ dataB64: "", ext: "png" }),
          readClipboardText: async () => "still text",
        }),
      ),
    ).resolves.toEqual({ kind: "text", text: "still text" });
  });
});

describe("preparePasteText", () => {
  it("normalizes newlines for terminal input", () => {
    expect(preparePasteText("a\r\nb\nc", false)).toBe("a\rb\rc");
  });

  it("brackets the text when the app enabled bracketed paste", () => {
    expect(preparePasteText("ls", true)).toBe("\x1b[200~ls\x1b[201~");
  });

  it("leaves the text bare when bracketed paste is off", () => {
    expect(preparePasteText("ls", false)).toBe("ls");
  });
});

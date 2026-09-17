/** 붙여넣을 이미지 바이트 — 백엔드 저장/업로드 커맨드가 받는 형태 그대로. */
interface PastedImageBytes {
  dataB64: string;
  ext: string;
}

export type ResolvedPaste =
  | ({ kind: "image" } & PastedImageBytes)
  | { kind: "text"; text: string };

export interface PasteSources {
  /** OS 클립보드의 이미지. 이미지가 없거나 플랫폼 미지원이면 null. */
  readClipboardImage: () => Promise<PastedImageBytes | null>;
  /** OS 클립보드의 텍스트. 텍스트가 없으면 null. */
  readClipboardText: () => Promise<string | null>;
  /** paste 이벤트가 실어온 이미지. 이벤트에 이미지가 없으면 null. */
  readEventImage: (() => Promise<PastedImageBytes>) | null;
  /** paste 이벤트가 실어온 텍스트. */
  eventText: string;
}

async function orNull<T>(read: () => Promise<T | null>): Promise<T | null> {
  return read().catch(() => null);
}

/**
 * Decide what a paste actually inserts, preferring the OS clipboard.
 *
 * WKWebView fills `ClipboardEvent.clipboardData` from a copy of the pasteboard
 * taken by its web content process, and never refreshes it for a change that
 * process did not observe. Copy something while the window does not exist yet
 * and the paste delivers whatever was copied before it — an older image, or
 * older text — silently, with nothing to distinguish it from a real paste. The
 * OS clipboard is the source of truth for both.
 *
 * Images win over text, matching how a paste behaved before the OS clipboard
 * was consulted: a clipboard carrying both is treated as an image paste. The
 * event's own bytes remain the last resort so platforms without a native reader
 * keep working.
 */
export async function resolvePaste(
  sources: PasteSources,
): Promise<ResolvedPaste | null> {
  const clipboardImage = await orNull(sources.readClipboardImage);
  if (clipboardImage?.dataB64) return { kind: "image", ...clipboardImage };

  const clipboardText = await orNull(sources.readClipboardText);
  if (clipboardText) return { kind: "text", text: clipboardText };

  if (sources.readEventImage) {
    const eventImage = await orNull(sources.readEventImage);
    if (eventImage?.dataB64) return { kind: "image", ...eventImage };
  }
  if (sources.eventText) return { kind: "text", text: sources.eventText };
  return null;
}

/**
 * Normalize newlines to terminal carriage returns and wrap bracketed paste
 * payloads with the standard terminal control sequences.
 */
export function preparePasteText(
  text: string,
  bracketedPasteMode: boolean,
): string {
  const normalized = text.replace(/\r?\n/g, "\r");
  return bracketedPasteMode
    ? `\x1b[200~${normalized}\x1b[201~`
    : normalized;
}

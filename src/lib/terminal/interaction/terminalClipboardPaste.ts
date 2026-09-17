import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { type DroppedFilePayload, preparedFilePaths } from "@/lib/files/externalFileDrop";
import { saveSessionFiles } from "@/lib/files/sessionFileTransfer";
import { readClipboardImage, saveTempImage } from "@/lib/ipc";
import { bytesToBase64 } from "@/lib/platform/base64";
import {
  preparePasteText,
  resolvePaste,
} from "@/lib/platform/clipboardImagePaste";
import { quoteTerminalFilePath } from "./terminalFileDrop";

interface TerminalClipboardPasteOptions {
  hostId: string | undefined;
  prepareFiles?: (files: DroppedFilePayload[]) => Promise<string[]>;
  canForwardText(): boolean;
  refreshControlState(): void;
  /** Structured terminals leave bracketed-paste encoding to the Host. */
  textPasteEncoding?: "client" | "host";
  bracketedPasteMode(): boolean;
  forwardUserInput(data: string): Promise<void>;
  onError(error: unknown): void;
}

/**
 * Keep native clipboard resolution and paste-event lifetime handling out of
 * TerminalView. WKWebView's event snapshot can be stale, so the app-process
 * pasteboard remains authoritative while the event bytes are a fallback.
 */
export function createTerminalClipboardPasteHandler(
  options: TerminalClipboardPasteOptions,
) {
  return (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const imageItem = Array.from(clipboard.items).find((item) =>
      item.type.startsWith("image/"),
    );
    // clipboardData becomes invalid when the handler returns.
    const eventImage = imageItem?.getAsFile() ?? null;
    const eventExt = (imageItem?.type.split("/")[1] ?? "png").split("+")[0];
    const eventText = clipboard.getData("text/plain");
    const forwardable = options.canForwardText();
    if (forwardable) options.refreshControlState();

    void resolvePaste({
      readClipboardImage,
      readClipboardText: () => readText(),
      readEventImage: eventImage
        ? async () => ({
            dataB64: bytesToBase64(
              new Uint8Array(await eventImage.arrayBuffer()),
            ),
            ext: eventExt,
          })
        : null,
      eventText,
    })
      .then(async (resolved) => {
        if (!resolved) return;
        if (resolved.kind === "text") {
          if (!forwardable) return;
          await options.forwardUserInput(
            options.textPasteEncoding === "host"
              ? resolved.text
              : preparePasteText(
                  resolved.text,
                  options.bracketedPasteMode(),
                ),
          );
          return;
        }
        const { dataB64, ext } = resolved;
        if (!forwardable) return;
        if (options.prepareFiles) {
          const paths = preparedFilePaths(
            await options.prepareFiles([
              { fileName: `pasted-image.${ext}`, dataB64 },
            ]),
            1,
          );
          await options.forwardUserInput(
            `${paths.map(quoteTerminalFilePath).join(" ")} `,
          );
          return;
        }
        if (options.hostId !== undefined) {
          const paths = preparedFilePaths(
            await saveSessionFiles(options.hostId, [
              { fileName: `pasted-image.${ext}`, dataB64 },
            ]),
            1,
          );
          await options.forwardUserInput(
            `${paths.map(quoteTerminalFilePath).join(" ")} `,
          );
          return;
        }
        const path = await saveTempImage({ dataB64, ext });
        await options.forwardUserInput(`${path} `);
      })
      .catch(options.onError);
  };
}

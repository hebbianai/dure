import type { FileContent } from "@/lib/ipc/files";
import { convertFileSrc } from "@/lib/ipc/core";

/** Must match PRESENTED_MEDIA_SCHEME in src-tauri/src/presented_media.rs. */
export const PRESENTED_MEDIA_SCHEME = "dure-media";

/** Where a media body loads from: the presented file's read-only stream when
 * the window streams it, otherwise the bytes the read returned inline. */
export function fileMediaSource(
	file: Pick<FileContent, "stream" | "mime" | "content">,
	toStreamUrl: (token: string, scheme: string) => string = convertFileSrc,
): string | undefined {
	if (file.stream) return toStreamUrl(file.stream, PRESENTED_MEDIA_SCHEME);
	return file.mime ? `data:${file.mime};base64,${file.content}` : undefined;
}

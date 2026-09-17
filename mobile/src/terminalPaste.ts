import {
	preparedFilePaths,
	type DroppedFilePayload,
} from "@/lib/files/externalFileDrop";
import { bytesToBase64 } from "@/lib/platform/base64";
import { shellQuote } from "@/lib/platform/shell";
import { t } from "./i18n";
import { describeError } from "./commandError";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type TerminalPasteContent =
	| { kind: "text"; text: string }
	| { kind: "image"; image: Blob | { dataB64: string; ext: string } };
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};
export const MAX_PASTE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Called directly from the Paste click so WebKit can ask for system paste access. */
export async function readTerminalClipboard(): Promise<
	TerminalPasteContent | undefined
> {
	if (isTauri())
		return (
			(await invoke<TerminalPasteContent | null>("read_terminal_clipboard")) ??
			undefined
		);
	const items = await navigator.clipboard.read();
	for (const item of items) {
		const type = item.types.find((type) => IMAGE_EXTENSIONS[type]);
		if (type) return { kind: "image", image: await item.getType(type) };
	}
	for (const item of items) {
		if (item.types.includes("text/plain")) {
			return {
				kind: "text",
				text: await (await item.getType("text/plain")).text(),
			};
		}
	}
	return undefined;
}

/** One pending paste belongs to the mounted attachment, including its async file transfer. */
export function createTerminalPaste(deps: {
	active: () => boolean;
	send: (text: string) => void;
	stageImage: (file: DroppedFilePayload) => Promise<unknown>;
	notice: (text: string) => void;
	read?: () => Promise<TerminalPasteContent | undefined>;
}) {
	let pending = false;
	return async (content?: TerminalPasteContent): Promise<void> => {
		if (pending || !deps.active()) return;
		pending = true;
		try {
			const value = content ?? (await (deps.read ?? readTerminalClipboard)());
			if (!deps.active()) return;
			if (!value) {
				deps.notice(t("terminal.paste.empty"));
				return;
			}
			let text: string;
			if (value.kind === "text") text = value.text;
			else {
				let image: { dataB64: string; ext: string };
				if ("dataB64" in value.image) image = value.image;
				else {
					const ext = IMAGE_EXTENSIONS[value.image.type];
					if (!ext) throw new Error(t("terminal.paste.unsupportedImage"));
					if (value.image.size > MAX_PASTE_IMAGE_BYTES)
						throw new Error(t("terminal.paste.imageTooLarge"));
					image = {
						ext,
						dataB64: bytesToBase64(
							new Uint8Array(await value.image.arrayBuffer()),
						),
					};
				}
				if (!deps.active()) return;
				deps.notice(t("terminal.paste.uploading"));
				const paths = preparedFilePaths(
					await deps.stageImage({
						fileName: `pasted-image.${image.ext}`,
						dataB64: image.dataB64,
					}),
					1,
				);
				text = `${shellQuote(paths[0])} `;
				if (deps.active()) deps.notice("");
			}
			if (text && deps.active()) deps.send(text);
		} catch (error) {
			if (deps.active())
				deps.notice(
					error instanceof Error
						? error.name === "NotAllowedError"
							? t("terminal.paste.failed")
							: error.message
						: describeError(error),
				);
		} finally {
			pending = false;
		}
	};
}

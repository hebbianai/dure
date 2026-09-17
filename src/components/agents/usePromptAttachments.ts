import { readText } from "@tauri-apps/plugin-clipboard-manager";
import {
	type ClipboardEvent,
	type DragEvent,
	type Dispatch,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type DroppedFilePayload,
	describeExternalFileDropError,
	isExternalFileDrag,
	prepareDroppedFilePayloads,
} from "@/lib/files/externalFileDrop";
import { t } from "@/lib/i18n";
import { readClipboardImage } from "@/lib/ipc";
import { bytesToBase64 } from "@/lib/platform/base64";
import { resolvePaste } from "@/lib/platform/clipboardImagePaste";

/** Own paste/drop capture lifetime; callers own draft text, files and submission. */
export function usePromptAttachments({
	attachments,
	setAttachments,
	scope,
	unavailable,
	imageName,
	onText,
	onError,
	onAttach,
	onReadyToSubmit,
}: {
	attachments: DroppedFilePayload[];
	setAttachments: Dispatch<SetStateAction<DroppedFilePayload[]>>;
	scope: string | null;
	unavailable?: string;
	imageName: (ext: string, index: number) => string;
	onText: (text: string) => void;
	onError: (error: string) => void;
	onAttach?: () => void;
	onReadyToSubmit?: () => void;
}) {
	const capture = useRef<{ pending: number; submitRequested: boolean } | null>(null);
	const [, settle] = useState(0);
	useEffect(() => {
		capture.current = scope === null ? null : { pending: 0, submitRequested: false };
		return () => {
			capture.current = null;
		};
	}, [scope, unavailable]);
	useEffect(() => {
		const ticket = capture.current;
		if (ticket?.submitRequested && ticket.pending === 0) {
			ticket.submitRequested = false;
			onReadyToSubmit?.();
		}
	});
	function allowed() {
		if (unavailable) onError(unavailable);
		return capture.current !== null && !unavailable;
	}
	function observe<T>(
		work: Promise<T>,
		accept: (value: T) => void,
		reject = (error: unknown) => onError(describeExternalFileDropError(error, t)),
	) {
		const ticket = capture.current;
		if (ticket) ticket.pending++;
		void work.then(
			(value) => {
				if (ticket && capture.current === ticket) {
					accept(value);
					ticket.pending--;
					settle((current) => current + 1);
				}
			},
			(error) => {
				if (ticket && capture.current === ticket) {
					ticket.submitRequested = false;
					ticket.pending--;
					reject(error);
					settle((current) => current + 1);
				}
			},
		);
	}
	function add(files: DroppedFilePayload[]) {
		if (!files.length) return;
		onAttach?.();
		setAttachments((current) => [...current, ...files]);
	}
	return {
		attachments,
		// Resume from the next committed draft, after capture updates are visible.
		deferSubmit() {
			const ticket = capture.current;
			if (!ticket?.pending) return false;
			ticket.submitRequested = true;
			return true;
		},
		clear() {
			capture.current = scope === null ? null : { pending: 0, submitRequested: false };
			setAttachments([]);
		},
		remove(index: number) {
			setAttachments((current) => current.filter((_, at) => at !== index));
		},
		inputProps: {
			onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
				const item = Array.from(event.clipboardData.items).find((item) =>
					item.type.startsWith("image/"),
				);
				// Ordinary text paste keeps the browser's selection and undo behavior.
				if (!item) return;
				event.preventDefault();
				if (!allowed()) return;
				const file = item.getAsFile();
				const ext = (item.type.split("/")[1] ?? "png").split("+")[0];
				observe(
					resolvePaste({
						readClipboardImage,
						readClipboardText: () => readText(),
						readEventImage: file
							? async () => ({
									dataB64: bytesToBase64(
										new Uint8Array(await file.arrayBuffer()),
									),
									ext,
								})
							: null,
						eventText: "",
					}),
					(resolved) => {
						if (!resolved) {
							if (capture.current) capture.current.submitRequested = false;
							onError(t("files.transfer.infoUnreadable"));
							return;
						}
						if (resolved.kind === "image")
							add([
								{
									fileName: imageName(resolved.ext, attachments.length),
									dataB64: resolved.dataB64,
								},
							]);
						else if (resolved.kind === "text") onText(resolved.text);
					},
				);
			},
			onDragOver(event: DragEvent<HTMLTextAreaElement>) {
				if (isExternalFileDrag(event.dataTransfer)) event.preventDefault();
			},
			onDrop(event: DragEvent<HTMLTextAreaElement>) {
				if (!isExternalFileDrag(event.dataTransfer)) return;
				event.preventDefault();
				// A drop never moves keyboard focus, so without this the next
				// Enter goes nowhere until the user clicks back into the composer.
				event.currentTarget.focus();
				if (allowed())
					observe(
						prepareDroppedFilePayloads(event.dataTransfer.files),
						add,
						(error) => onError(describeExternalFileDropError(error, t)),
					);
			},
		},
	};
}

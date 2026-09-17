// 터미널 pane에 떨어진 외부 파일 → 셸에 넣을 경로 문자열. 준비(임시 저장)와
// 판정은 lib/files/externalFileDrop이 소유하고, 여기는 "터미널 입력으로 어떻게
// 바꾸는가"만 결정한다 — pane 없이 vitest로 검증하려고 분리했다.

import { getPanelData } from "dockview-react";
import {
	type DroppedFileLike,
	type DroppedFilePayload,
	isExternalFileDrag,
	prepareDroppedFilePayloads,
	preparedFilePaths,
} from "@/lib/files/externalFileDrop";

/**
 * 떨어진 파일을 셸이 열 수 있는 곳에 두고 그 절대 경로들을 돌려준다. 로컬이면
 * 임시 저장, 원격이면 업로드 — 어느 쪽인지는 세션을 아는 호출자가 고르고, 이
 * 모듈은 그 결과를 입력으로 바꾸는 일만 한다.
 */
type PrepareFiles = (files: DroppedFilePayload[]) => Promise<unknown>;

export interface TerminalFileDropOptions {
	readonly prepareFiles: PrepareFiles;
	readonly activateInputTarget: () => void;
	readonly forwardUserInput: (data: string) => void | Promise<void>;
	readonly onError: (error: unknown) => void;
}

interface TerminalFileDragEvent {
	readonly dataTransfer: DataTransfer | null;
	preventDefault(): void;
	stopImmediatePropagation(): void;
}

/** 공백·따옴표가 든 경로도 한 인자로 남도록 작은따옴표로 감싼다. */
export function quoteTerminalFilePath(path: string): string {
	return `'${path.split("'").join("'\\''")}'`;
}

export async function prepareTerminalFileDrop(
	filesLike: ArrayLike<DroppedFileLike>,
	options: Pick<TerminalFileDropOptions, "prepareFiles">,
): Promise<string> {
	const files = Array.from(filesLike);
	const payloads = await prepareDroppedFilePayloads(files);
	const paths = preparedFilePaths(
		await options.prepareFiles(payloads),
		files.length,
	);

	return `${paths.map(quoteTerminalFilePath).join(" ")} `;
}

export function createTerminalFileDropHandlers(
	options: TerminalFileDropOptions,
) {
	return {
		onDragOver(
			event: Pick<TerminalFileDragEvent, "dataTransfer" | "preventDefault">,
		) {
			// Dockview owns local pane drags; avoid a synchronous native type lookup
			// on every hover. Actual drops still validate their file payload below.
			if (getPanelData()) return;
			if (isExternalFileDrag(event.dataTransfer)) event.preventDefault();
		},

		async onDrop(event: TerminalFileDragEvent): Promise<boolean> {
			if (
				!isExternalFileDrag(event.dataTransfer) ||
				!event.dataTransfer?.files.length
			) {
				return false;
			}

			event.preventDefault();
			event.stopImmediatePropagation();
			try {
				options.activateInputTarget();
				const input = await prepareTerminalFileDrop(
					event.dataTransfer.files,
					options,
				);
				await options.forwardUserInput(input);
			} catch (error) {
				options.onError(error);
			}
			return true;
		},
	};
}

/**
 * capture 단계에 건다 — 앱 내부 pane 드래그에는 Files flavor가 없으므로
 * dockview의 드롭 처리와 서로 간섭하지 않는다.
 */
export function installTerminalFileDrop(
	host: HTMLElement,
	options: TerminalFileDropOptions,
): () => void {
	const handlers = createTerminalFileDropHandlers(options);
	const onDragOver = (event: DragEvent) => handlers.onDragOver(event);
	const onDrop = (event: DragEvent) => {
		void handlers.onDrop(event);
	};
	host.addEventListener("dragover", onDragOver, true);
	host.addEventListener("drop", onDrop, true);
	return () => {
		host.removeEventListener("dragover", onDragOver, true);
		host.removeEventListener("drop", onDrop, true);
	};
}

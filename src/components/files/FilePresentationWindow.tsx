import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo, useRef } from "react";
import { PanelStatus } from "@/components/common/PanelStatus";
import {
	FileViewerPanel,
	type FileViewerParams,
} from "@/components/files/FileViewerPanel";
import { useFilePresentationWindowState } from "@/components/files/useFilePresentationWindowState";
import { Titled } from "@/components/ui/tooltip";
import {
	SecondaryWindowShell,
	useSecondaryWindowBoot,
	windowChromeDragHandler,
} from "@/components/workspace/SecondaryWindowShell";
import { type FilePresentation, fileBaseName } from "@/lib/files/filePresentation";
import { publishFileReopen } from "@/lib/files/fileReopenEvents";
import { fileDraftKey } from "@/lib/files/fileTarget";
import { t } from "@/lib/i18n";
import { useDurableWindowClose } from "@/lib/workspace/window/useDurableWindowClose";

const PRESENTATION_VIEWER_ID = "file-presentation";

/** The file viewer outside Dockview: the window is its only host, so the pane
 *  API is a fixed identity whose title the window header shows instead. */
function standaloneViewerProps(
	file: FileViewerParams,
): IDockviewPanelProps<FileViewerParams> {
	return {
		params: file,
		api: {
			id: PRESENTATION_VIEWER_ID,
			setTitle: () => {},
			isVisible: true,
			onDidVisibilityChange: () => ({ dispose() {} }),
		},
		containerApi: {},
	} as unknown as IDockviewPanelProps<FileViewerParams>;
}

/** ?panel=presentation — the large window an agent puts one file in. Each new
 *  presentation replaces the file; presenting the same file again reloads it
 *  unless it has unsaved edits, as reopening a file pane does. */
export function FilePresentationWindowRoot() {
	const { presentation, presenterName } = useFilePresentationWindowState();
	const fileName = presentation
		? fileBaseName(presentation.file.path)
		: undefined;
	const lang = useSecondaryWindowBoot(
		fileName && presenterName
			? t("panels.filePresentation.windowTitle", {
					file: fileName,
					name: presenterName,
				})
			: (fileName ?? t("panels.filePresentation.title")),
	);
	useDurableWindowClose();

	const shown = useRef<FilePresentation | undefined>(undefined);
	useEffect(() => {
		const previous = shown.current;
		shown.current = presentation;
		if (
			presentation &&
			previous &&
			previous.id !== presentation.id &&
			fileDraftKey(previous.file) === fileDraftKey(presentation.file)
		)
			publishFileReopen(presentation.file);
	}, [presentation]);

	const file = presentation?.file;
	const viewerProps = useMemo(
		() => (file ? standaloneViewerProps(file) : undefined),
		[file],
	);

	return (
		<SecondaryWindowShell key={lang} className="overflow-hidden">
			<div
				className="z-10 flex h-[var(--app-chrome-bar-height)] shrink-0 items-center gap-2 border-b border-border/60 bg-sidebar pr-3 text-sidebar-foreground select-none"
				onMouseDown={windowChromeDragHandler()}
			>
				<span className="w-[82px] shrink-0" aria-hidden="true" />
				{file ? (
					<Titled title={file.path}>
						<span className="min-w-0 truncate text-xs font-medium">
							{fileName}
						</span>
					</Titled>
				) : (
					<span className="min-w-0 truncate text-xs font-medium">
						{t("panels.filePresentation.title")}
					</span>
				)}
				{presenterName ? (
					<span className="min-w-0 shrink truncate text-xs text-muted-foreground">
						{t("panels.filePresentation.presentedBy", { name: presenterName })}
					</span>
				) : null}
			</div>
			<div className="relative min-h-0 flex-1">
				{file && viewerProps ? (
					<FileViewerPanel key={fileDraftKey(file)} {...viewerProps} />
				) : (
					<PanelStatus>{t("panels.filePresentation.empty")}</PanelStatus>
				)}
			</div>
		</SecondaryWindowShell>
	);
}

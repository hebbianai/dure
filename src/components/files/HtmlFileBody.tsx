import { useEffect, useState } from "react";
import { OpenExternallyButton } from "@/components/files/OpenExternallyButton";
import { LoadingStatus } from "@/components/common/PanelStatus";
import { fileDocumentIO } from "@/lib/files/fileDocumentIO";
import type { FileTarget } from "@/lib/files/fileTarget";
import { buildHtmlPreview, type HtmlPreview } from "@/lib/files/htmlPreview";
import { t } from "@/lib/i18n";

/** A local or SSH HTML page rendered as a static preview. */
export function HtmlFileBody({
	content,
	document,
	name,
	paneId,
}: {
	content: string;
	/** The HTML file; relative images are read beside it through the same route. */
	document: FileTarget;
	name: string;
	paneId?: string;
}) {
	const { path, source, hostId, sessionId } = document;
	const [preview, setPreview] = useState<HtmlPreview>();
	useEffect(() => {
		let live = true;
		const readImage = async (assetPath: string) => {
			const file = await fileDocumentIO.read({ path: assetPath, source, hostId, sessionId });
			return file.kind === "image" && file.mime && !file.truncated
				? `data:${file.mime};base64,${file.content}`
				: undefined;
		};
		void buildHtmlPreview(content, path, readImage).then((next) => {
			if (live) setPreview(next);
		});
		return () => {
			live = false;
		};
	}, [content, path, source, hostId, sessionId]);

	// A newer build replaces the shown one only once it is ready.
	if (!preview) return <LoadingStatus size="sm" />;
	return (
		<div className="flex h-full min-h-0 flex-col">
			{preview.hasScripts ? (
				<div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1 text-[11px] text-muted-foreground">
					<span className="min-w-0 flex-1">{t("panels.fileViewer.htmlScriptsBlocked")}</span>
					{source === "local" ? <OpenExternallyButton path={path} paneId={paneId} /> : null}
				</div>
			) : null}
			<iframe
				title={name}
				// Static preview with the design mockup pane's sandbox: without
				// allow-scripts nothing in the page runs, and without allow-popups or
				// allow-top-navigation its rewritten links cannot leave the frame.
				sandbox="allow-same-origin"
				// A standalone page draws on a white canvas unless it paints its own.
				className="min-h-0 w-full flex-1 border-0 bg-white"
				srcDoc={preview.srcdoc}
			/>
		</div>
	);
}

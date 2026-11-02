import { ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import { fileDocumentIO } from "@/lib/files/fileDocumentIO";
import type { FileTarget } from "@/lib/files/fileTarget";
import { resolveMarkdownAssetPath } from "@/lib/files/markdownAssets";

type Loaded = { path: string; uri?: string; failed?: boolean };

/** A Markdown `img` in the file viewer. A reference to a file is read beside the
 * document through its local or SSH route; URLs stay with the webview. */
export function MarkdownFileImage({
	document,
	src,
	alt,
	title,
}: {
	/** The Markdown file the reference appears in. */
	document: FileTarget;
	src?: string;
	alt?: string;
	title?: string;
}) {
	const assetPath = src ? resolveMarkdownAssetPath(document.path, src) : undefined;
	const { source, hostId, sessionId } = document;
	const [loaded, setLoaded] = useState<Loaded>();
	useEffect(() => {
		if (!assetPath) return;
		let live = true;
		fileDocumentIO.read({ path: assetPath, source, hostId, sessionId }).then(
			(file) => {
				if (!live) return;
				const shown = file.kind === "image" && file.mime && !file.truncated;
				setLoaded(shown ? { path: assetPath, uri: `data:${file.mime};base64,${file.content}` } : { path: assetPath, failed: true });
			},
			() => {
				if (live) setLoaded({ path: assetPath, failed: true });
			},
		);
		return () => {
			live = false;
		};
	}, [assetPath, source, hostId, sessionId]);

	if (!assetPath) return <img src={src} alt={alt} title={title} />;
	const current = loaded?.path === assetPath ? loaded : undefined;
	if (current?.failed) {
		return (
			<span
				role="img"
				aria-label={alt || src}
				className="my-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 p-2 text-xs text-muted-foreground"
				title={assetPath}
			>
				<ImageOff className="size-4 shrink-0" />
				<span className="min-w-0 truncate">{alt || src}</span>
			</span>
		);
	}
	return <img src={current?.uri} alt={alt} title={title} />;
}

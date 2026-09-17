import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { SafeMarkdown } from "@/components/common/SafeMarkdown";
import { useWorkspaceRuntimeActive } from "@/components/workspace/WorkspaceRuntimeContext";
import { openExternalUrl } from "@/lib/platform/externalOpen";

const openChatExternal = (url: string) => void openExternalUrl(url);
const chatMarkdownStyle: CSSProperties = {
	fontSize: "inherit",
	lineHeight: "inherit",
};

const LONG_MARKDOWN_LENGTH = 8_192;
const STREAMING_UPDATE_INTERVAL_MS = 250;

/** Provider Markdown as bare transcript prose: edge margins trimmed and type
 * forced to inherit, because `.prose-terminal` pins an unlayered 14px/1.7 that
 * beats any utility class by cascade-layer order — only an inline style lets
 * the content follow the pane's typography settings. */
export function ChatMarkdown({
	markdown,
	streaming = false,
}: {
	markdown: string;
	streaming?: boolean;
}) {
	const active = useWorkspaceRuntimeActive();
	const [presentation, setPresentation] = useState(() => ({
		active,
		markdown: active ? markdown : null,
	}));
	const displayed = presentation.markdown;
	const latest = useRef(markdown);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const batching = streaming && markdown.length >= LONG_MARKDOWN_LENGTH;

	// Refresh before rendering children so reveal parses only the latest text.
	if (active !== presentation.active) {
		setPresentation({ active, markdown: active ? markdown : displayed });
	}

	useLayoutEffect(() => {
		latest.current = markdown;
		if (!active || !batching) {
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = null;
			if (active && markdown !== displayed)
				setPresentation({ active, markdown });
		} else if (markdown !== displayed && timer.current === null) {
			// The first pending fragment owns the deadline; continuous output
			// must advance while visible. Hiding cancels this presentation work.
			timer.current = setTimeout(() => {
				timer.current = null;
				setPresentation({ active: true, markdown: latest.current });
			}, STREAMING_UPDATE_INTERVAL_MS);
		}
	}, [active, batching, displayed, markdown]);

	useLayoutEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = null;
		},
		[],
	);

	const text = active && !batching ? markdown : displayed;
	if (text === null) return null;
	return (
		<SafeMarkdown
			markdown={text}
			className="[&>:first-child]:mt-0 [&>:last-child]:mb-0"
			style={chatMarkdownStyle}
			onOpenExternal={openChatExternal}
		/>
	);
}

import { ExternalLink, ImageOff } from "lucide-react";
import { type CSSProperties, memo, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownList } from "@/components/common/MarkdownList";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function containsImageNode(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const node = value as { tagName?: unknown; children?: unknown };
	return (
		node.tagName === "img" ||
		(Array.isArray(node.children) && node.children.some(containsImageNode))
	);
}

/** Synchronous, inert GFM rendering for service/provider-owned Markdown.
 * Raw HTML and implicit remote media are disabled. HTTP(S) navigation only
 * exists when the owning product surface supplies its safe opener. */
export const SafeMarkdown = memo(function SafeMarkdown({
	markdown,
	onOpenExternal,
	className,
	style,
}: {
	markdown: string;
	onOpenExternal?: (url: string) => void;
	className?: string;
	/** Inline overrides for surfaces whose type must beat `.prose-terminal`'s
	 * unlayered base (utility classes lose to it by cascade-layer order). */
	style?: CSSProperties;
}) {
	// Renderer functions are React component types; preserve them across text updates.
	const components = useMemo<Components>(
		() => ({
			ul: ({ node: _node, ...props }) => <MarkdownList {...props} />,
			ol: ({ node: _node, ...props }) => <MarkdownList {...props} ordered />,
			a: ({ href, children, node }) => {
				const wrapsImage = containsImageNode(node);
				if (!href || !/^https?:\/\//i.test(href) || !onOpenExternal) {
					return <span>{children}</span>;
				}
				// A linked image already owns one explicit image-open action below.
				// Dropping the outer link prevents nested buttons and double opens.
				if (wrapsImage) return <span>{children}</span>;
				return (
					<Button
						type="button"
						variant="link"
						size="xs"
						className="h-auto whitespace-normal p-0 align-baseline"
						onClick={() => onOpenExternal(href)}
					>
						{children}
						<ExternalLink className="size-3" />
					</Button>
				);
			},
			img: ({ src, alt }) => {
				const safeSource =
					typeof src === "string" && /^https?:\/\//i.test(src)
						? src
						: undefined;
				return (
					<span className="my-2 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
						<ImageOff className="size-4" />
						<span className="min-w-0 flex-1 truncate">
							{alt || t("common.remoteImage")}
						</span>
						{safeSource && onOpenExternal ? (
							<Button
								type="button"
								size="xs"
								variant="outline"
								aria-label={t("common.openRemoteImage")}
								onClick={() => onOpenExternal(safeSource)}
							>
								{t("common.open")}
							</Button>
						) : null}
					</span>
				);
			},
		}),
		[onOpenExternal],
	);
	return (
		<div
			data-selectable
			className={cn(
				"prose-terminal max-w-none text-sm text-foreground",
				className,
			)}
			style={style}
		>
			<Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
				{markdown}
			</Markdown>
		</div>
	);
});

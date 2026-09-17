import type { ReactNode } from "react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { t } from "@/lib/i18n";

/** Wraps one toolbar control with the right-click "hide this control" menu
 * (the VS Code idiom — per-control hiding lives on the control itself, not
 * in a settings checkbox wall; restore lives in 설정 › 일반). Dumb by
 * contract: the caller already resolved visibility through
 * lib/workspace/pane/agentToolbarControls and only passes the hide action.
 * stopPropagation keeps the toolbar frame's fork context menu from opening
 * on the same right-click; the hide itself is deferred one task so the menu
 * finishes closing before the trigger unmounts. */
export function AgentToolbarSlot({
	controlLabel,
	onHide,
	children,
}: {
	/** Short neutral control name, already localized. */
	controlLabel: string;
	onHide: () => void;
	children: ReactNode;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger
				asChild
				onContextMenu={(event) => event.stopPropagation()}
			>
				<span className="flex min-w-0 shrink-0 items-center">{children}</span>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onSelect={() => setTimeout(onHide, 0)}>
					{t("panels.agent.toolbar.hideControl", { label: controlLabel })}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

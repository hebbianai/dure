import {
	SplitSquareHorizontal,
	PanelsTopLeft,
	SplitSquareVertical,
	Trash2,
	X,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { PaneActionContextMenu, type PaneActionMenuSection } from "@/components/workspace/PaneActionMenu";
import { usePaneQuickCommands } from "@/components/workspace/usePaneQuickCommands";
import { QuickCommandDialog } from "@/components/workspace/QuickCommandDialog";
import { Alert } from "@/components/ui/alert";
import { t } from "@/lib/i18n";
import { balanceActiveSpacePanes } from "@/lib/workspace/pane/paneShortcuts";

export interface TerminalKillActionProps {
	onKill?: () => void;
	/** Exact verb for closing a view, killing a session, or disconnecting. */
	killLabel?: string;
	/** False when closing leaves the underlying session alive. */
	killDestructive?: boolean;
}

export function TerminalViewChrome({
	containerRef,
	surfaceId,
	onSplit,
	onKill,
	killLabel,
	killDestructive = true,
	containerClassName = "terminal-host h-full w-full",
	children,
}: {
	containerRef: RefObject<HTMLDivElement | null>;
	surfaceId?: string;
	onSplit?: (direction: "right" | "below") => void;
	containerClassName?: string;
	children?: ReactNode;
} & TerminalKillActionProps) {
	const quickCommands = usePaneQuickCommands(surfaceId);
	const host = (
		<div className="relative h-full w-full">
			<div
				ref={containerRef}
				className={containerClassName}
			>
				{children}
			</div>
			{quickCommands.error && (
				<Alert
					surface="dock"
					className="absolute inset-x-2 top-2 z-20"
					dismiss={{ label: t("common.close"), onClick: quickCommands.dismissError }}
				>
					{quickCommands.error}
				</Alert>
			)}
		</div>
	);
	if (!surfaceId && !onSplit && !onKill) return host;
	const sections: PaneActionMenuSection[] = surfaceId ? [quickCommands.section] : [];
	// Balancing is Space-wide, but a right-click anywhere on a pane is where a
	// hand reaches for layout — the tab menu alone went unfound (owner call
	// 2026-09-14), so it sits under the splits here and in the header menu.
	if (onSplit) sections.push({ id: "split", items: [
		{ id: "right", label: t("common.splitRight"), icon: <SplitSquareHorizontal />, onSelect: () => onSplit("right") },
		{ id: "below", label: t("common.splitDown"), icon: <SplitSquareVertical />, onSelect: () => onSplit("below") },
		{ id: "balance", label: t("workspace.desktopBar.balancePanes"), icon: <PanelsTopLeft />, onSelect: balanceActiveSpacePanes },
	] });
	if (onKill) sections.push({ id: "close", items: [{ id: "close", label: killLabel ?? t("terminal.chrome.kill"), icon: killDestructive ? <Trash2 /> : <X />, destructive: killDestructive, onSelect: onKill }] });
	return (
		<>
			<PaneActionContextMenu sections={sections} onOpenChange={quickCommands.captureTarget}>{host}</PaneActionContextMenu>
			{quickCommands.editor && <QuickCommandDialog key={typeof quickCommands.editor === "object" ? quickCommands.editor.id : quickCommands.editor} editor={quickCommands.editor} commands={quickCommands.commands} onEditorChange={quickCommands.setEditor} onSave={quickCommands.save} onRemove={quickCommands.remove} onMove={quickCommands.move} />}
		</>
	);
}

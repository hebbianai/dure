import { ArrowLeft, ArrowRight } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import { navigatePaneHistory } from "@/lib/workspace/pane/paneShortcuts";

/** Browser-style pane focus history navigation in the window chrome —
 * traffic lights, sidebar toggle, then back/forward (owner reference
 * 2026-09-01). Shares the keyboard shortcuts' history cursor, so arrows and
 * shortcuts always agree on where "back" goes. An empty direction is a
 * silent no-op rather than a disabled state: availability changes on every
 * focus, and greying the pair would flicker with it. */
export function PaneHistoryNav() {
	return (
		<div className="flex shrink-0 items-center gap-0.5" data-nodrag>
			<IconButton
				title={t("workspace.titleBar.historyBack")}
				className="size-6 shrink-0 rounded-md hover:bg-glass-tint-hover [&_svg]:size-4"
				onClick={() => navigatePaneHistory("back")}
			>
				<ArrowLeft />
			</IconButton>
			<IconButton
				title={t("workspace.titleBar.historyForward")}
				className="size-6 shrink-0 rounded-md hover:bg-glass-tint-hover [&_svg]:size-4"
				onClick={() => navigatePaneHistory("forward")}
			>
				<ArrowRight />
			</IconButton>
		</div>
	);
}

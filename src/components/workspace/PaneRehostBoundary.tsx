import type { ReactNode } from "react";
import { PanelStatus } from "@/components/common/PanelStatus";
import { DureLoader } from "@/components/ui/dure-loader";
import { usePaneActionPending } from "@/components/workspace/useNamedPaneAction";
import { t } from "@/lib/i18n";

/** Keep the terminal/chat mounted while its explicit replacement is pending. */
export function PaneRehostBoundary({
	paneId,
	children,
}: {
	paneId: string;
	children: ReactNode;
}) {
	const pending = usePaneActionPending(paneId, "rehost");
	return (
		<div className="relative h-full min-h-0 min-w-0">
			<div
				className="h-full min-h-0"
				inert={pending || undefined}
				aria-hidden={pending || undefined}
			>
				{children}
			</div>
			{pending && (
				<div className="absolute inset-0 z-30 flex overflow-y-auto bg-surface-pane">
					<PanelStatus
						role="status"
						size="xs"
						className="m-auto h-auto w-full max-w-xs gap-3 px-6 py-5 text-center"
					>
						<DureLoader decorative size={20} />
						<div className="space-y-1">
							<p className="text-sm font-medium text-foreground">
								{t("workspace.rehost.progress")}
							</p>
							<p className="text-xs leading-5">
								{t("workspace.rehost.progressDescription")}
							</p>
						</div>
					</PanelStatus>
				</div>
			)}
		</div>
	);
}

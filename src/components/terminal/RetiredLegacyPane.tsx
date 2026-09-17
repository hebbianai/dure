import { PanelStatus } from "@/components/common/PanelStatus";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/** Dead-end surface for panes whose binding predates the hmux migration.
 * The legacy PTY runtime is retired (2026-08-16); nothing can reattach these
 * sessions, so the only honest affordance is closing the pane — silently
 * respawning or hiding it would misreport what happened to the session. */
export function RetiredLegacyPane({ onClose }: { onClose?: () => void }) {
	return (
		<div data-testid="retired-legacy-terminal" className="h-full min-h-0">
			<PanelStatus role="status">
				<p className="font-medium text-foreground">
					{t("terminal.retiredPane.title")}
				</p>
				<p className="max-w-96 text-center">
					{t("terminal.retiredPane.body")}
				</p>
				{onClose ? (
					<Button size="sm" variant="outline" onClick={onClose}>
						{t("common.closePane")}
					</Button>
				) : null}
			</PanelStatus>
		</div>
	);
}

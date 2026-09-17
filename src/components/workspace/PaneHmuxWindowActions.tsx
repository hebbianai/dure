import { Expand } from "lucide-react";
import { Titled } from "@/components/ui/tooltip";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { t } from "@/lib/i18n";
import { agentSessionWindowBinding } from "@/lib/workspace/window/agentSessionWindowTarget";
import { openAgentSessionWindow } from "@/lib/workspace/window/windows";
import { type Agent, PROVIDERS } from "@/types";

interface PaneHmuxWindowActionsProps {
	agent?: Agent;
	active?: boolean;
	sourcePaneOwnerId?: string;
}

const buttonClassName =
	"flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-[color,background-color,opacity] duration-150 hover:bg-glass-tint-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Opens a detached large view for an attached managed agent session. */
export function PaneHmuxWindowActions({
	agent,
	active = false,
	sourcePaneOwnerId,
}: PaneHmuxWindowActionsProps) {
	const sessionWindowLabel = agent
		? t("workspace.agentWindow.viewSession", {
				provider: PROVIDERS[agent.provider].label,
			})
		: undefined;

	if (!agent || !agentSessionWindowBinding(agent) || !sessionWindowLabel) {
		return null;
	}

	return (
		<Titled title={sessionWindowLabel}>
			<button
				type="button"
				className={buttonClassName}
				data-pane-window-action=""
				data-pane-window-action-active={active ? "" : undefined}
				aria-label={sessionWindowLabel}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					void openAgentSessionWindow(
						agent.id,
						agentDisplayName(agent),
						sourcePaneOwnerId,
					);
				}}
			>
				<Expand className="size-3" />
			</button>
		</Titled>
	);
}

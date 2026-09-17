import { useEffect, useState } from "react";
import type { DockviewPanelApi } from "dockview-react";
import { NameEditDialog } from "@/components/workspace/NameEditDialog";
import { renameAgentDisplayName } from "@/lib/agents/agentDisplayNameState";
import { t } from "@/lib/i18n";
import {
	renamePaneTitle,
	usePaneTitleOverrides,
} from "@/lib/workspace/pane/paneTitleOverrideStore";
import type { Agent } from "@/types";

export function usePaneRenameControls({
	agent,
	api,
	automaticTitle,
}: {
	agent: Agent | undefined;
	api: DockviewPanelApi;
	automaticTitle: string;
}) {
	const paneTitleOverride = usePaneTitleOverrides(
		(state) => state.overrides[api.id],
	);
	const [agentRenameOpen, setAgentRenameOpen] = useState(false);
	const [paneRenameOpen, setPaneRenameOpen] = useState(false);

	useEffect(() => {
		if (paneTitleOverride && api.title !== paneTitleOverride.title) {
			api.setTitle(paneTitleOverride.title);
		}
	}, [api, paneTitleOverride]);

	return {
		overrideTitle: paneTitleOverride?.title,
		openPaneRename: () => setPaneRenameOpen(true),
		openAgentRename: agent ? () => setAgentRenameOpen(true) : undefined,
		dialogs: (
			<>
				<NameEditDialog
					open={paneRenameOpen}
					title={t("workspace.paneRename.title")}
					description={t("workspace.paneRename.description")}
					value={paneTitleOverride?.title ?? ""}
					placeholder={automaticTitle}
					onOpenChange={setPaneRenameOpen}
					onSave={(value) => renamePaneTitle(api, value)}
				/>
				{agent && (
					<NameEditDialog
						open={agentRenameOpen}
						title={t("common.agentRename.title")}
						description={t("common.agentRename.description")}
						value={agent.displayName ?? ""}
						placeholder={agent.name}
						onOpenChange={setAgentRenameOpen}
						onSave={(value) => renameAgentDisplayName(agent.id, value)}
					/>
				)}
			</>
		),
	};
}

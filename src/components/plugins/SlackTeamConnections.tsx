import { useState } from "react";
import { SlackConnectionsPanel } from "@/components/plugins/SlackConnectionsPanel";
import { BackendServerSelect } from "@/components/common/BackendServerSelect";
import { useSlackTeamConnection } from "@/components/plugins/useSlackTeamConnection";
import { Alert } from "@/components/ui/alert";
import { RefreshButton } from "@/components/ui/refresh-button";
import { t } from "@/lib/i18n";
import type { DureBackendProfileSummary } from "@/lib/ipc/dureBackendProfiles";
import { createSlackConnectorClient } from "@/lib/ipc/slackConnector";

export function SlackTeamConnections() {
	const { profiles, selected, select, error, loading, refresh } =
		useSlackTeamConnection();
	return (
		<>
			<div className="space-y-3 px-4 pt-4">
				<div className="flex items-end gap-2">
					<div className="flex-1">
						<BackendServerSelect
							profiles={profiles}
							value={selected}
							onChange={select}
							label={t("plugins.slack.teamServer")}
						/>
					</div>
					<RefreshButton busy={loading} onClick={refresh} />
				</div>
				<p className="text-xs leading-5 text-muted-foreground">
					{t("plugins.slack.teamServerHint")}
				</p>
				{error && <Alert icon={false}>{error}</Alert>}
			</div>
			{selected && (
				<SelectedConnection
					key={selected}
					profileId={selected}
					profiles={profiles}
				/>
			)}
		</>
	);
}

function SelectedConnection({
	profileId,
	profiles,
}: {
	profileId: string;
	profiles: DureBackendProfileSummary[];
}) {
	const [client] = useState(() => createSlackConnectorClient({ profileId }));
	return <SlackConnectionsPanel client={client} profiles={profiles} />;
}

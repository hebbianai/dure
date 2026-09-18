import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import {
	missingSlackFileScopes,
	type SlackConnection,
} from "@/lib/plugins/slackConnection";

export function SlackFilePermissionsNotice({
	connection,
	onConfigure,
}: {
	connection: SlackConnection;
	onConfigure?: () => void;
}) {
	const missing = missingSlackFileScopes(connection);
	if (!missing.length) return null;
	return (
		<Alert
			tone="warn"
			surface="outline"
			title={t("plugins.slack.filePermissionsTitle")}
		>
			<p>
				{t("plugins.slack.filePermissionsMissing", {
					team: connection.config.teamId,
					scopes: missing.join(", "),
				})}
			</p>
			{onConfigure ? (
				<Button
					size="sm"
					variant="ghost"
					className="mt-1"
					onClick={onConfigure}
				>
					{t("plugins.slack.updatePermissions")}
				</Button>
			) : (
				<>
					<p className="mt-2">{t("plugins.slack.filePermissionsHelp")}</p>
					<Button
						size="sm"
						variant="ghost"
						className="mt-1"
						onClick={() => {
							void openExternalUrl("https://api.slack.com/apps");
						}}
					>
						{t("plugins.slack.openAppSettings")}
					</Button>
				</>
			)}
		</Alert>
	);
}

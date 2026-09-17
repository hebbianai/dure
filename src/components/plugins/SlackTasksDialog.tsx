import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { StructuredAgentChatSurface } from "@/components/agents/chat/StructuredAgentChatSurface";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { LoadingRow } from "@/components/common/StatusBlocks";
import { SlackServerSelect } from "@/components/plugins/SlackServerSelect";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { RefreshButton } from "@/components/ui/refresh-button";
import { t } from "@/lib/i18n";
import type { DureBackendProfileSummary } from "@/lib/ipc/dureBackendProfiles";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { SlackConnectorClient } from "@/lib/ipc/slackConnector";
import { slackConnectionError } from "@/lib/plugins/slackConnection";
import {
	openSlackTask,
	type SlackTask,
	type SlackTaskConversation,
} from "@/lib/plugins/slackTask";

export function SlackTasksDialog({
	client,
	authority,
	teamId,
	profiles,
	onClose,
}: {
	client: SlackConnectorClient;
	authority: DureBackendRouteAuthorityV1;
	teamId: string;
	profiles: DureBackendProfileSummary[];
	onClose: () => void;
}) {
	const [tasks, setTasks] = useState<SlackTask[]>();
	const [error, setError] = useState<string>();
	const [refresh, setRefresh] = useState(0);
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<SlackTaskConversation>();
	const [executionProfile, setExecutionProfile] = useState(authority.profileId);
	useEffect(() => {
		let current = true;
		setTasks(undefined);
		setError(undefined);
		void client
			.tasks(teamId, authority)
			.then((next) => {
				if (current) setTasks(next);
			})
			.catch((reason) => {
				if (current) setError(slackConnectionError(reason));
			});
		return () => {
			current = false;
		};
	}, [client, authority, teamId, refresh]);
	async function open(task: SlackTask) {
		setBusy(true);
		setError(undefined);
		try {
			setSelected(await openSlackTask(task, executionProfile));
		} catch (reason) {
			setError(
				reason instanceof Error &&
					reason.message === "slack_task_server_mismatch"
					? t("plugins.slack.taskServerMismatch")
					: slackConnectionError(reason),
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(value) => {
				if (!value) onClose();
			}}
		>
			<DialogContent className="flex h-[min(80vh,800px)] flex-col sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{t("plugins.slack.teamTasks")}</DialogTitle>
					<DialogDescription>
						{t("plugins.slack.teamTasksHint")}
					</DialogDescription>
				</DialogHeader>
				{selected ? (
					<>
						<Button
							className="self-start"
							variant="ghost"
							size="sm"
							onClick={() => setSelected(undefined)}
						>
							<ArrowLeft />
							{t("common.back")}
						</Button>
						<div className="min-h-0 flex-1">
							<SharedConversation
								key={`${selected.authority.revision}:${selected.agentId}`}
								target={selected}
							/>
						</div>
					</>
				) : (
					<>
						<div className="flex items-end gap-3">
							<div className="flex-1">
								<SlackServerSelect
									profiles={profiles}
									value={executionProfile}
									onChange={setExecutionProfile}
									label={t("plugins.slack.taskExecutionServer")}
								/>
							</div>
							<RefreshButton
								busy={!tasks && !error}
								disabled={busy}
								onClick={() => setRefresh((value) => value + 1)}
							/>
						</div>
						{error && <Alert icon={false}>{error}</Alert>}
						{!tasks && !error && <LoadingRow>{t("common.loading")}</LoadingRow>}
						{tasks?.length === 0 && (
							<p className="text-sm text-muted-foreground">
								{t("plugins.slack.noTeamTasks")}
							</p>
						)}
						<div className="min-h-0 flex-1 overflow-y-auto">
							{tasks?.map((task) => (
								<Button
									key={`${task.channelId}:${task.threadTs}`}
									variant="ghost"
									className="h-auto w-full justify-start py-3 text-left"
									disabled={busy}
									onClick={() => void open(task)}
								>
									<span className="min-w-0">
										<span className="block truncate">{task.projectId}</span>
										<span className="block truncate text-xs font-normal text-muted-foreground">
											{task.channelId} · {task.agentId}
										</span>
									</span>
								</Button>
							))}
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function SharedConversation({ target }: { target: SlackTaskConversation }) {
	const session = useAgentChatSession(
		target.agentId,
		target.profile,
		undefined,
		target.authority,
	);
	return (
		<StructuredAgentChatSurface session={session} attachmentsEnabled={false} />
	);
}

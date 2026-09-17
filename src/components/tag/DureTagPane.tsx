import { ArrowLeft, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { SharedAgentConversation } from "@/components/agents/chat/SharedAgentConversation";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import { PaneEmptyState } from "@/components/common/PaneEmptyState";
import { LoadingStatus } from "@/components/common/PanelStatus";
import { SlackConnectionsPanel } from "@/components/plugins/SlackConnectionsPanel";
import { SlackServerSelect } from "@/components/plugins/SlackServerSelect";
import { useSlackTeamConnection } from "@/components/plugins/useSlackTeamConnection";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import { openSharedAgentConversation } from "@/lib/agents/chat/sharedAgentConversation";
import { t } from "@/lib/i18n";
import type { DureBackendProfileSummary } from "@/lib/ipc/dureBackendProfiles";
import { createSlackConnectorClient } from "@/lib/ipc/slackConnector";
import { slackConnectionError } from "@/lib/plugins/slackConnection";
import type { SlackTask } from "@/lib/plugins/slackTask";
import { useStore } from "@/store";

export function DureTagPane() {
	const connection = useSlackTeamConnection();
	if (!connection.pro) return null;
	return (
		<section
			aria-label={t("tag.title")}
			className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5"
		>
			{connection.selected ? (
				<TagTasks
					key={connection.selected}
					profileId={connection.selected}
					profiles={connection.profiles}
					onSelectServer={connection.select}
				/>
			) : (
				<>
					<SectionHeaderRow as="h2" label={t("tag.title")} />
					{connection.error ? (
						<div className="p-4">
							<Alert>{connection.error}</Alert>
							<Button variant="ghost" onClick={connection.refresh}>
								{t("common.retry")}
							</Button>
						</div>
					) : (
						<LoadingStatus />
					)}
				</>
			)}
		</section>
	);
}

function TagTasks({
	profileId,
	profiles,
	onSelectServer,
}: {
	profileId: string;
	profiles: DureBackendProfileSummary[];
	onSelectServer: (id: string) => void;
}) {
	const [client] = useState(() => createSlackConnectorClient({ profileId }));
	const [tasks, setTasks] = useState<SlackTask[]>();
	const [error, setError] = useState<string>();
	const [openError, setOpenError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [opening, setOpening] = useState(false);
	const [selected, setSelected] = useState<{
		target: SharedAgentConversationTarget;
		title: string;
	}>();
	const [settings, setSettings] = useState(false);
	const [revision, setRevision] = useState(0);
	const projects = useStore((state) => state.projects);
	useEffect(() => {
		let current = true;
		let timer: ReturnType<typeof setTimeout>;
		setLoading(true);
		// This is the Slack source adapter. Conversation and pane routing below
		// carry only Dure agent/server identity, never channel or thread identity.
		async function observe(
			authority?: import("@/lib/ipc/dureBackendRoute").DureBackendRouteAuthorityV1,
		) {
			try {
				const snapshot = await client.list(authority);
				const linked = await Promise.all(
					snapshot.connections.map((connection) =>
						client.tasks(connection.config.teamId, snapshot.authority),
					),
				);
				if (!current) return;
				setTasks(
					linked.flat().sort((a, b) => Number(b.threadTs) - Number(a.threadTs)),
				);
				setError(undefined);
				timer = setTimeout(() => void observe(snapshot.authority), 5000);
			} catch (reason) {
				if (current) setError(slackConnectionError(reason));
			} finally {
				if (current) setLoading(false);
			}
		}
		void observe();
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [client, revision]);

	const title = (task: SlackTask) =>
		task.title ||
		projects.find((project) => project.id === task.projectId)?.name ||
		task.projectId;
	async function open(task: SlackTask) {
		setOpening(true);
		setOpenError(undefined);
		try {
			const target = await openSharedAgentConversation(task, profileId);
			setSelected({ target, title: title(task) });
		} catch {
			setOpenError(t("tag.openFailed"));
		} finally {
			setOpening(false);
		}
	}
	if (selected)
		return (
			<div
				className="flex min-h-0 min-w-0 flex-1 flex-col"
				data-tag-conversation={selected.target.agentId}
			>
				<div className="flex shrink-0 items-center gap-2 px-3 py-2">
					<IconButton
						title={t("common.back")}
						showTooltip={false}
						onClick={() => setSelected(undefined)}
					>
						<ArrowLeft />
					</IconButton>
					<h2
						className="min-w-0 truncate text-xs font-medium"
						title={selected.title}
					>
						{selected.title}
					</h2>
				</div>
				<div className="min-h-0 flex-1 bg-background">
					<SharedAgentConversation
						key={selected.target.agentId}
						target={selected.target}
					/>
				</div>
			</div>
		);
	return (
		<>
			<SectionHeaderRow
				as="h2"
				label={t("tag.title")}
				actions={
					<>
						<RefreshButton
							busy={loading}
							onClick={() => setRevision((value) => value + 1)}
						/>
						<IconButton
							title={t("tag.connections")}
							onClick={() => setSettings(true)}
						>
							<Settings />
						</IconButton>
					</>
				}
			/>
			<div className="px-4 py-3">
				<SlackServerSelect
					profiles={profiles}
					value={profileId}
					onChange={onSelectServer}
					label={t("plugins.slack.teamServer")}
				/>
			</div>
			{(openError || error) && (
				<div className="px-4 pb-3">
					<Alert icon={false}>{openError || error}</Alert>
				</div>
			)}
			{!tasks && loading ? (
				<LoadingStatus />
			) : tasks?.length === 0 ? (
				<PaneEmptyState
					compact
					title={t("tag.empty")}
					description={t("plugins.slack.noTeamTasks")}
					action={
						<Button
							className="w-full"
							variant="secondary"
							onClick={() => setSettings(true)}
						>
							{t("tag.connections")}
						</Button>
					}
				/>
			) : (
				<SidebarScrollArea
					className="min-h-0 flex-1"
					viewportClassName="px-2 pb-3"
				>
					{tasks?.map((task) => (
						<Button
							key={`${task.teamId}:${task.channelId}:${task.threadTs}`}
							variant="ghost"
							className="h-auto w-full justify-start px-2 py-2.5 text-left"
							disabled={opening}
							onClick={() => void open(task)}
							data-tag-agent-id={task.agentId}
						>
							<span className="min-w-0">
								<span className="block truncate text-xs font-medium">
									{title(task)}
								</span>
								<span className="mt-0.5 block truncate text-meta font-normal text-muted-foreground">
									{new Date(Number(task.threadTs) * 1000).toLocaleString()} ·
									Slack
								</span>
							</span>
						</Button>
					))}
				</SidebarScrollArea>
			)}
			{settings && (
				<Dialog
					open
					onOpenChange={(value) => {
						setSettings(value);
						if (!value) setRevision((value) => value + 1);
					}}
				>
					<DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl">
						<DialogHeader>
							<DialogTitle>{t("tag.connections")}</DialogTitle>
						</DialogHeader>
						<SlackConnectionsPanel client={client} profiles={profiles} />
					</DialogContent>
				</Dialog>
			)}
		</>
	);
}

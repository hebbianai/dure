import { ArrowLeft, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { SharedAgentConversation } from "@/components/agents/chat/SharedAgentConversation";
import { BackendServerSelect } from "@/components/common/BackendServerSelect";
import { PaneEmptyState } from "@/components/common/PaneEmptyState";
import { LoadingStatus } from "@/components/common/PanelStatus";
import { SlackFilePermissionsNotice } from "@/components/plugins/SlackFilePermissionsNotice";
import { SlackConnectionsPanel } from "@/components/plugins/SlackConnectionsPanel";
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
import { DureLoader } from "@/components/ui/dure-loader";
import { IconButton } from "@/components/ui/icon-button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import { openSharedAgentConversation } from "@/lib/agents/chat/sharedAgentConversation";
import { readSharedConversationActivity } from "@/lib/agents/chat/sharedConversationActivity";
import { t } from "@/lib/i18n";
import type { DureBackendProfileSummary } from "@/lib/ipc/dureBackendProfiles";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";
import { createSlackConnectorClient } from "@/lib/ipc/slackConnector";
import {
	type SlackConnection,
	missingSlackFileScopes,
	slackConnectionError,
} from "@/lib/plugins/slackConnection";
import type { SlackTask } from "@/lib/plugins/slackTask";
import { useStore } from "@/store";

export function DureTagPane() {
	const connection = useSlackTeamConnection();
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
	const [connections, setConnections] = useState<SlackConnection[]>([]);
	const [tasks, setTasks] = useState<SlackTask[]>();
	const [error, setError] = useState<string>();
	const [openError, setOpenError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [authority, setAuthority] = useState<DureBackendRouteAuthorityV1>();
	const [selected, setSelected] = useState<SlackTask>();
	const [target, setTarget] = useState<SharedAgentConversationTarget>();
	const [settings, setSettings] = useState<
		"connections" | "permissions" | null
	>(null);
	const [revision, setRevision] = useState(0);
	const [activity, setActivity] = useState<ReadonlyMap<string, boolean>>(
		new Map(),
	);
	const showTaskActivity = !selected;
	const projects = useStore((state) => state.projects);
	useEffect(() => {
		let current = true;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		setLoading(true);
		// This is the Slack source adapter. Conversation and pane routing below
		// carry only Dure agent/server identity, never channel or thread identity.
		async function observe() {
			try {
				const snapshot = await client.list();
				const linked = await Promise.all(
					snapshot.connections.map((connection) =>
						client.tasks(connection.config.teamId, snapshot.authority),
					),
				);
				if (!current) return;
				const observedTasks = linked
					.flat()
					.sort((a, b) => Number(b.threadTs) - Number(a.threadTs));
				setTasks(observedTasks);
				setConnections(snapshot.connections);
				setAuthority((previous) =>
					previous &&
					sameDureBackendRouteAuthority(previous, snapshot.authority)
						? previous
						: snapshot.authority,
				);
				setError(undefined);
				if (showTaskActivity) {
					const observedActivity = await readSharedConversationActivity(
						observedTasks,
						snapshot.authority,
						{ signal: controller.signal },
					);
					if (current) setActivity(observedActivity);
				}
			} catch (reason) {
				if (current) {
					setActivity(new Map());
					setConnections([]);
					setError(slackConnectionError(reason));
				}
			} finally {
				if (current) {
					setLoading(false);
					timer = setTimeout(() => void observe(), 5000);
				}
			}
		}
		void observe();
		return () => {
			current = false;
			controller.abort();
			clearTimeout(timer);
		};
	}, [client, revision, showTaskActivity]);

	const title = (task: SlackTask) =>
		task.title ||
		projects.find((project) => project.id === task.projectId)?.name ||
		task.projectId;
	useEffect(() => {
		if (!selected || !authority) return;
		let current = true;
		setTarget(undefined);
		setOpenError(undefined);
		// Re-resolve the durable task identity after a complete snapshot changes
		// the route. The conversation owns its draft and never replays a send.
		void openSharedAgentConversation(selected, authority.profileId)
			.then((next) => {
				if (current) setTarget(next);
			})
			.catch(() => {
				if (current) setOpenError(t("tag.openFailed"));
			});
		return () => {
			current = false;
		};
	}, [selected, authority]);
	const settingsDialog = settings && (
		<Dialog
			open
			onOpenChange={(value) => {
				setSettings(value ? "connections" : null);
				if (!value) setRevision((value) => value + 1);
			}}
		>
			<DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("tag.connections")}</DialogTitle>
				</DialogHeader>
				<SlackConnectionsPanel
					client={client}
					profiles={profiles}
					editOnOpen={settings === "connections"}
				/>
			</DialogContent>
		</Dialog>
	);
	const permissionNotices = connections
		.filter(
			(connection) =>
				missingSlackFileScopes(connection).length > 0 &&
				(!selected || selected.teamId === connection.config.teamId),
		)
		.map((connection) => (
			<div key={connection.config.teamId} className="px-3 pb-2">
				<SlackFilePermissionsNotice
					connection={connection}
					onConfigure={() => setSettings("permissions")}
				/>
			</div>
		));
	if (selected) {
		const header = (
			<>
				<IconButton
					title={t("common.back")}
					showTooltip={false}
					onClick={() => setSelected(undefined)}
				>
					<ArrowLeft />
				</IconButton>
				<h2
					className="min-w-0 flex-1 truncate text-xs font-medium"
					title={title(selected)}
				>
					{title(selected)}
				</h2>
			</>
		);
		return (
			<div
				className="flex min-h-0 min-w-0 flex-1 flex-col"
				data-tag-conversation={selected.agentId}
			>
				{permissionNotices}
				{settingsDialog}
				{!openError && target?.agentId === selected.agentId ? (
					<SharedAgentConversation
						key={selected.agentId}
						target={target}
						header={header}
					/>
				) : (
					<>
						<div className="flex shrink-0 items-center gap-2 px-3 py-2">
							{header}
						</div>
						<div className="min-h-0 flex-1 bg-background">
							{openError ? <Alert>{openError}</Alert> : <LoadingStatus />}
						</div>
					</>
				)}
			</div>
		);
	}

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
							onClick={() => setSettings("connections")}
						>
							<Settings />
						</IconButton>
					</>
				}
			/>
			<div className="px-4 py-3">
				<BackendServerSelect
					profiles={profiles}
					value={profileId}
					onChange={onSelectServer}
					label={t("plugins.slack.teamServer")}
				/>
			</div>
			{permissionNotices}
			<p className="px-4 pb-3 text-meta text-muted-foreground">
				{t("tag.mentionRequired")}
			</p>
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
							onClick={() => setSettings("connections")}
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
							onClick={() => setSelected(task)}
							data-tag-agent-id={task.agentId}
							aria-busy={activity.get(task.agentId) || undefined}
						>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-xs font-medium">
									{title(task)}
								</span>
								<span className="mt-0.5 block truncate text-meta font-normal text-muted-foreground">
									{new Date(Number(task.threadTs) * 1000).toLocaleString()} ·
									Slack
								</span>
							</span>
							{activity.get(task.agentId) && (
								<DureLoader
									size={14}
									label={t("common.working")}
									className="shrink-0 text-muted-foreground"
								/>
							)}
						</Button>
					))}
				</SidebarScrollArea>
			)}
			{settingsDialog}
		</>
	);
}

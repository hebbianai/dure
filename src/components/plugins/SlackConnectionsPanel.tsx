import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LoadingRow } from "@/components/common/StatusBlocks";
import { SlackConnectionEditor } from "@/components/plugins/SlackConnectionEditor";
import { SlackTasksDialog } from "@/components/plugins/SlackTasksDialog";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { t } from "@/lib/i18n";
import type { DureBackendProfileSummary } from "@/lib/ipc/dureBackendProfiles";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	createSlackConnectorClient,
	type SlackConnectionSnapshot,
	type SlackConnectorClient,
} from "@/lib/ipc/slackConnector";
import {
	type SlackConnection,
	slackConnectionError,
	slackFailureMessage,
} from "@/lib/plugins/slackConnection";

type EditorTarget = {
	authority: DureBackendRouteAuthorityV1;
	connection?: SlackConnection;
};

export function SlackConnectionsPanel({
	client,
	profiles,
}: {
	client?: SlackConnectorClient;
	profiles?: DureBackendProfileSummary[];
}) {
	const [api] = useState(() => client ?? createSlackConnectorClient());
	const [snapshot, setSnapshot] = useState<SlackConnectionSnapshot>();
	const [loadError, setLoadError] = useState<string>();
	const [actionError, setActionError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [tasksTarget, setTasksTarget] = useState<{
		teamId: string;
		authority: DureBackendRouteAuthorityV1;
	}>();
	const [editor, setEditor] = useState<EditorTarget>();
	const active = useRef(false);
	const busyRef = useRef(false);
	const observation = useRef(0);
	const lifetime = useRef(0);
	useEffect(() => {
		active.current = true;
		++lifetime.current;
		let current = true;
		let timer: ReturnType<typeof setTimeout>;
		setLoading(true);
		async function observe(authority?: DureBackendRouteAuthorityV1) {
			if (busyRef.current) {
				timer = setTimeout(() => void observe(authority), 1500);
				return;
			}
			const version = ++observation.current;
			try {
				const next = await api.list(authority);
				if (!current) return;
				if (version === observation.current) {
					setSnapshot(next);
					setLoadError(undefined);
				}
				timer = setTimeout(() => void observe(next.authority), 1500);
			} catch (reason) {
				if (current && version === observation.current)
					setLoadError(slackConnectionError(reason));
			} finally {
				if (current) setLoading(false);
			}
		}
		void observe();
		return () => {
			current = false;
			active.current = false;
			++observation.current;
			clearTimeout(timer);
		};
	}, [api, refresh]);
	async function perform(
		operation: () => Promise<SlackConnectionSnapshot>,
	): Promise<boolean> {
		if (busyRef.current) return false;
		busyRef.current = true;
		const currentLifetime = lifetime.current;
		++observation.current;
		setBusy(true);
		setActionError(undefined);
		try {
			const next = await operation();
			if (active.current && currentLifetime === lifetime.current) {
				setSnapshot(next);
				setLoadError(undefined);
			}
			return true;
		} catch (reason) {
			if (active.current && currentLifetime === lifetime.current)
				setActionError(slackConnectionError(reason));
			return false;
		} finally {
			busyRef.current = false;
			if (active.current) setBusy(false);
		}
	}
	return (
		<section aria-label={t("plugins.slack.connections")}>
			<div className="space-y-3 px-4 py-4">
				<div className="flex items-center justify-between gap-3">
					<h3 className="text-xs font-medium">
						{t("plugins.slack.connections")}
					</h3>
					<RefreshButton
						busy={loading}
						disabled={busy}
						onClick={() => setRefresh((value) => value + 1)}
					/>
				</div>
				<p className="text-xs leading-5 text-muted-foreground">
					{t("plugins.slack.connectionHint")}
				</p>
				{snapshot && (
					<p className="text-xs text-muted-foreground">
						{t("plugins.slack.managedBy", {
							server: snapshot.authority.profileId,
						})}
					</p>
				)}
				{loadError && (
					<Alert icon={false} className="text-xs">
						{loadError}
					</Alert>
				)}
				{actionError && (
					<Alert icon={false} className="text-xs">
						{actionError}
					</Alert>
				)}
				{loading && !snapshot && <LoadingRow>{t("common.loading")}</LoadingRow>}
				{snapshot?.connections.map((connection) => (
					<div
						key={connection.config.teamId}
						className="space-y-2 border-t border-border pt-3"
					>
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0 text-xs">
								<p className="truncate font-medium">
									{connection.config.teamId}
								</p>
								<p className="mt-1 text-muted-foreground">
									{t(`plugins.slack.state.${connection.connection}`)}
								</p>
							</div>
							<div className="flex items-center gap-1">
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() =>
										setEditor({ authority: snapshot.authority, connection })
									}
								>
									{t("plugins.slack.edit")}
								</Button>
								{connection.enabled && (
									<Button
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={() =>
											void perform(() =>
												api.disconnect(
													connection.config.teamId,
													snapshot.authority,
												),
											)
										}
									>
										{t("plugins.slack.disconnect")}
									</Button>
								)}
							</div>
						</div>
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								setTasksTarget({
									teamId: connection.config.teamId,
									authority: snapshot.authority,
								})
							}
						>
							{t("plugins.slack.teamTasks")}
						</Button>
						{connection.connection === "failed" && (
							<Alert icon={false} className="text-xs">
								{slackFailureMessage(connection.failure)}
							</Alert>
						)}
					</div>
				))}
				<Button
					size="sm"
					variant="ghost"
					disabled={!snapshot || busy}
					onClick={() => {
						if (snapshot) setEditor({ authority: snapshot.authority });
					}}
				>
					<Plus />
					{t("plugins.slack.addWorkspace")}
				</Button>
			</div>
			{tasksTarget && (
				<SlackTasksDialog
					client={api}
					authority={tasksTarget.authority}
					teamId={tasksTarget.teamId}
					profiles={
						profiles ?? [
							{
								id: tasksTarget.authority.profileId,
								default: true,
								kind: tasksTarget.authority.target.source,
							},
						]
					}
					onClose={() => setTasksTarget(undefined)}
				/>
			)}
			{editor && (
				<SlackConnectionEditor
					key={`${editor.authority.profileId}:${editor.authority.backend.generation}:${editor.connection?.config.teamId ?? "new"}`}
					client={api}
					authority={editor.authority}
					connection={editor.connection}
					busy={busy}
					submit={perform}
					onClose={() => setEditor(undefined)}
				/>
			)}
		</section>
	);
}

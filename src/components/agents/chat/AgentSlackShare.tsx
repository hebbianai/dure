import { Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import type { AgentChatDraftIdentity } from "@/lib/agents/chat/agentChatDraftTypes";
import { t } from "@/lib/i18n";
import {
	createSlackConnectorClient,
	type SlackConnectionSnapshot,
	type SlackConnectorClient,
} from "@/lib/ipc/slackConnector";
import { slackShareError } from "@/lib/plugins/slackConnection";

export function AgentSlackShare({
	identity,
	disabled,
	client,
}: {
	identity: AgentChatDraftIdentity;
	disabled?: boolean;
	client?: SlackConnectorClient;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<ToolbarControl
				label={t("plugins.slack.share")}
				icon={<Share2 aria-hidden="true" className="size-3.5" />}
				disabled={disabled}
				onClick={() => setOpen(true)}
			/>
			{open && <ShareDialog identity={identity} client={client} />}
		</Dialog>
	);
}

function ShareDialog({
	identity,
	client,
}: {
	identity: AgentChatDraftIdentity;
	client?: SlackConnectorClient;
}) {
	const [api] = useState(() => client ?? createSlackConnectorClient());
	const [snapshot, setSnapshot] = useState<SlackConnectionSnapshot>();
	const [selected, setSelected] = useState("");
	const [backend, setBackend] = useState("");
	const [error, setError] = useState<string>();
	const [shared, setShared] = useState(false);
	const [busy, setBusy] = useState(false);
	const submitting = useRef(false);
	useEffect(() => {
		let active = true;
		void api
			.list()
			.then((value) => {
				if (active) setSnapshot(value);
			})
			.catch((reason) => {
				if (active) setError(slackShareError(reason));
			});
		return () => {
			active = false;
		};
	}, [api]);
	const channels =
		snapshot?.connections.flatMap(({ config }) =>
			config.channels.map((route) => ({
				teamId: config.teamId,
				channelId: route.channelId,
				key: `${config.teamId}:${route.channelId}`,
			})),
		) ?? [];
	async function share() {
		const channel = channels.find((item) => item.key === selected);
		if (!snapshot || !channel || submitting.current) return;
		submitting.current = true;
		setBusy(true);
		setError(undefined);
		try {
			await api.share(
				{
					requestId: crypto.randomUUID(),
					teamId: channel.teamId,
					channelId: channel.channelId,
					agentId: identity.agentId,
					interactionSessionId: identity.interactionSessionId,
					...(backend.trim() ? { backend: backend.trim() } : {}),
				},
				snapshot.authority,
			);
			setShared(true);
		} catch (reason) {
			setError(slackShareError(reason));
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	}
	return (
		<DialogContent className="sm:max-w-sm">
			<DialogHeader>
				<DialogTitle>{t("plugins.slack.share")}</DialogTitle>
				<DialogDescription>{t("plugins.slack.shareHint")}</DialogDescription>
			</DialogHeader>
			{snapshot && (
				<p className="text-xs text-muted-foreground">
					{t("plugins.slack.managedBy", {
						server: snapshot.authority.profileId,
					})}
				</p>
			)}
			{!snapshot && !error && (
				<p className="text-sm text-muted-foreground">{t("common.loading")}</p>
			)}
			{snapshot && channels.length === 0 && (
				<p className="text-sm text-muted-foreground">
					{t("plugins.slack.shareEmpty")}
				</p>
			)}
			{channels.length > 0 && (
				<SelectField
					aria-label={t("plugins.slack.channel")}
					value={selected}
					disabled={busy || shared}
					placeholder={t("plugins.slack.chooseChannel")}
					onValueChange={setSelected}
				>
					<SelectOption value="" disabled>
						{t("plugins.slack.chooseChannel")}
					</SelectOption>
					{channels.map((channel) => (
						<SelectOption key={channel.key} value={channel.key}>
							{channel.teamId} / {channel.channelId}
						</SelectOption>
					))}
				</SelectField>
			)}
			{channels.length > 0 && !shared && (
				<details className="space-y-2 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						{t("plugins.slack.executionServer")}
					</summary>
					<Input
						aria-label={t("plugins.slack.executionServer")}
						value={backend}
						disabled={busy}
						onChange={(event) => setBackend(event.target.value)}
					/>
					<p className="text-muted-foreground">
						{t("plugins.slack.shareServerHint")}
					</p>
				</details>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{shared ? (
				<p role="status" className="text-sm">
					{t("plugins.slack.shared")}
				</p>
			) : (
				<Button
					type="button"
					disabled={!selected || busy}
					onClick={() => void share()}
				>
					{t(busy ? "plugins.slack.sharing" : "plugins.slack.share")}
				</Button>
			)}
		</DialogContent>
	);
}

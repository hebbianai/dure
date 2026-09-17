import { Folder, LayoutPanelTop, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import { KeyValueList, KeyValueRow } from "@/components/common/KeyValueList";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import { launchDiscoveredRemoteConversationPane } from "@/lib/sessions/launch/discoveredConversationLaunch";
import type { RecentSessionRegistrationDecision } from "@/lib/sessions/recentWork";
import { useStore } from "@/store";
import { PROVIDERS } from "@/types";

function hostEndpoint(host: {
	user: string;
	host: string;
	port: number;
}): string {
	return `${host.user}@${host.host}${host.port === 22 ? "" : `:${host.port}`}`;
}

export function RecentSessionRemoteResumeDialog({
	decision,
	onClose,
}: {
	decision?: RecentSessionRegistrationDecision;
	onClose(): void;
}) {
	const sshHosts = useStore((state) => state.sshHosts);
	const spaces = useStore((state) => state.spaces);
	const activeSpaceId = useStore((state) => state.activeSpaceId);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const host = decision?.hostId
		? sshHosts.find((candidate) => candidate.id === decision.hostId)
		: undefined;
	const destination =
		spaces.find((space) => space.id === activeSpaceId)?.name ??
		t("sessions.placement.thisDesktop");

	useEffect(() => {
		setBusy(false);
		setError(undefined);
	}, [decision?.conversationId, decision?.hostId]);

	const close = () => {
		if (!busy) onClose();
	};
	const confirm = async () => {
		if (decision?.executionLocation !== "ssh" || !decision.hostId || !host) {
			setError(t("sessions.remoteResume.hostMissing"));
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await launchDiscoveredRemoteConversationPane({
				provider: decision.provider,
				conversationId: decision.conversationId,
				cwd: decision.cwd,
				workspaceRoot: decision.workspaceRoot,
				hostId: decision.hostId,
				desktopId: activeSpaceId,
			});
			onClose();
		} catch (cause) {
			setError(
				t(
					"sessions.remoteResume.openFailed",
					{
						reason: cause instanceof Error ? cause.message : String(cause),
					},
				),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={decision !== undefined}
			onOpenChange={(open) => !open && close()}
		>
			<DialogContent
				showCloseButton={!busy}
				dismiss={busy ? "none" : "all"}
				className="sm:max-w-md"
			>
				<DialogHeader>
					<DialogTitle>{t("sessions.remoteResume.title")}</DialogTitle>
					<DialogDescription>
						{t(
							"sessions.remoteResume.description",
						)}
					</DialogDescription>
				</DialogHeader>

				{decision && (
					<KeyValueList
						labelWidth="6.5rem"
						className="border-y border-foreground/10"
					>
						<KeyValueRow
							label={
								<span className="flex items-center gap-1.5">
									<Server className="size-3.5" />
									{t("common.host")}
								</span>
							}
						>
							<div className="min-w-0 flex-1 text-right">
								<div className="truncate font-medium">
									{host?.name ?? decision.hostId}
								</div>
								{host && (
									<div className="truncate font-mono text-[10px] text-muted-foreground">
										{hostEndpoint(host)}
									</div>
								)}
							</div>
						</KeyValueRow>

						<KeyValueRow
							label={
								<span className="flex items-center gap-1.5">
									<Folder className="size-3.5" />
									{t("sessions.remoteResume.folderToRegister")}
								</span>
							}
							mono
							selectable
						>
							<span className="min-w-0 flex-1 break-all text-right">
								{decision.workspaceRoot}
							</span>
						</KeyValueRow>

						{decision.cwd !== decision.workspaceRoot && (
							<KeyValueRow label="cwd" mono selectable>
								<span className="min-w-0 flex-1 break-all text-right">
									{decision.cwd}
								</span>
							</KeyValueRow>
						)}

						<KeyValueRow
							label={
								<span className="flex items-center gap-1.5">
									<span className="flex size-3.5 items-center justify-center [&_svg]:size-3.5">
										<ProviderGlyph provider={decision.provider} />
									</span>
									{t("common.conversationId")}
								</span>
							}
						>
							<div className="min-w-0 flex-1 text-right">
								<div className="truncate font-medium">{decision.title}</div>
								<div className="truncate font-mono text-[10px] text-muted-foreground">
									{PROVIDERS[decision.provider].label} ·{" "}
									{decision.conversationId}
								</div>
							</div>
						</KeyValueRow>

						<KeyValueRow
							label={
								<span className="flex items-center gap-1.5">
									<LayoutPanelTop className="size-3.5" />
									{t("sessions.placement.opensIn")}
								</span>
							}
						>
							<span className="min-w-0 flex-1 truncate text-right font-medium">
								{t("sessions.placement.desktopNewPane", { desktop: destination })}
							</span>
						</KeyValueRow>
					</KeyValueList>
				)}

				{error && (
					<p
						role="alert"
						className="break-words text-xs leading-5 text-status-warn"
					>
						{error}
					</p>
				)}

				<DialogActionFooter
					onCancel={close}
					confirmLabel={t("sessions.remoteResume.confirmAction")}
					busyLabel={t("sessions.remoteResume.registering")}
					busy={busy}
					disabled={!host}
					onConfirm={() => void confirm()}
				/>
			</DialogContent>
		</Dialog>
	);
}

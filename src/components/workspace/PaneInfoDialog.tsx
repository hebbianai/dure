import { Check, Copy, ServerCog } from "lucide-react";
import { useEffect, useState } from "react";

import { KeyValueList, KeyValueRow } from "@/components/common/KeyValueList";
import { useCopyFeedback } from "@/components/common/useCopyFeedback";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import type {
	PaneInfoField,
	PaneInfoFieldKey,
	PaneInfoModel,
	PaneInfoSectionKey,
} from "@/lib/workspace/pane/paneInfo";
import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider } from "@/types";

// Label maps hold thunks so every Korean lookup key sits inside a t() call
// that runs at render time — a module-scope t() would freeze the boot language.
const SECTION_LABELS: Record<PaneInfoSectionKey, () => string> = {
	pane: () => "Pane",
	location: () => t("common.location"),
	session: () => t("common.session"),
	health: () => t("workspace.paneInfo.section.health"),
	generation: () => t("workspace.paneInfo.section.runtimeGeneration"),
};

const FIELD_LABELS: Record<PaneInfoFieldKey, () => string> = {
	title: () => t("workspace.paneInfo.field.title"),
	paneId: () => "Pane ID",
	paneKind: () => t("workspace.paneInfo.field.paneKind"),
	agentId: () => "Agent ID",
	spaceId: () => "Space ID",
	pinned: () => t("workspace.pane.pin"),
	project: () => t("workspace.paneInfo.field.project"),
	projectId: () => "Project ID",
	executionLocation: () => t("workspace.paneInfo.field.executionLocation"),
	workingDirectory: () => t("common.workingFolder"),
	branch: () => t("common.branch"),
	runtime: () => t("workspace.paneInfo.field.runtime"),
	hostId: () => "Host ID",
	provider: () => "Provider",
	sessionName: () => t("workspace.paneInfo.field.sessionName"),
	sessionId: () => t("workspace.paneInfo.field.sessionId"),
	workspaceId: () => "Workspace ID",
	conversationId: () => t("common.conversationId"),
	sessionClass: () => t("workspace.paneInfo.field.sessionClass"),
	lifecycle: () => t("workspace.paneInfo.field.lifecycle"),
	controlHealth: () => t("workspace.paneInfo.field.hostHealth"),
	paneHealth: () => t("workspace.paneInfo.field.paneConnection"),
	sshState: () => t("workspace.paneInfo.field.sshConnection"),
	diagnostic: () => t("workspace.paneInfo.field.diagnostic"),
	healthReason: () => t("workspace.paneInfo.field.healthReason"),
	runtimeHost: () => t("Runtime host"),
	hostBuild: () => t("workspace.paneInfo.field.hostBuild"),
	outputSequence: () => t("Output seq"),
	capabilities: () => t("Capabilities"),
	lastObserved: () => t("workspace.paneInfo.field.lastObserved"),
	terminalEpoch: () => t("Terminal epoch"),
	receivedSequence: () => t("workspace.paneInfo.field.receivedSeq"),
	presentedSequence: () => t("workspace.paneInfo.field.presentedSeq"),
	runnerPrincipal: () => t("Runner principal"),
	runnerInstance: () => t("Runner instance"),
	channelEpoch: () => t("Channel epoch"),
	hostInstanceId: () => t("Host instance ID"),
};

const TECHNICAL_FIELDS = new Set<PaneInfoFieldKey>([
	"paneId",
	"agentId",
	"spaceId",
	"projectId",
	"workingDirectory",
	"branch",
	"hostId",
	"sessionId",
	"workspaceId",
	"conversationId",
	"runtimeHost",
	"hostBuild",
	"outputSequence",
	"capabilities",
	"terminalEpoch",
	"receivedSequence",
	"presentedSequence",
	"runnerPrincipal",
	"runnerInstance",
	"channelEpoch",
	"hostInstanceId",
]);

function translateCode(
	value: string,
	labels: Record<string, () => string>,
): string {
	return labels[value]?.() ?? t(value);
}

function formatPaneInfoValue(field: PaneInfoField): string {
	switch (field.valueKind) {
		case "pane-kind":
			return translateCode(field.value, {
				agent: () => t("common.agent"),
				terminal: () => t("common.terminal"),
				ssh: () => t("workspace.paneKind.ssh"),
				git: () => "Git",
				github: () => "GitHub",
				browser: () => t("workspace.paneKind.browser"),
				file: () => t("common.file"),
				other: () => t("workspace.paneKind.other"),
			});
		case "boolean":
			return field.value === "true" ? t("workspace.paneInfo.value.yes") : t("workspace.paneInfo.value.no");
		case "execution-location":
			if (field.value === "local") return t("common.local");
			if (field.value === "unknown") return t("common.unknown");
			return `SSH · ${field.value}`;
		case "runtime":
			return translateCode(field.value, {
				legacy_session_v1: () => t("workspace.runtime.localPty"),
				legacy_ssh_session_v1: () => t("SSH PTY"),
				hmux_session_v1: () => t("workspace.runtime.hmuxSession"),
				hmux_standalone_v1: () => t("workspace.runtime.standaloneHmux"),
				hmux_managed_v1: () => t("workspace.runtime.managedHmux"),
			});
		case "provider": {
			const provider = field.value as Provider;
			return PROVIDERS[provider]
				? `${PROVIDERS[provider].label} · ${field.value}`
				: field.value;
		}
		case "session-class":
			return translateCode(field.value, {
				managed: () => t("workspace.sessionClass.managed"),
				standalone: () => t("workspace.sessionClass.standalone"),
			});
		case "lifecycle":
			return translateCode(field.value, {
				ready: () => t("workspace.lifecycle.ready"),
				exited: () => t("common.exited"),
				unavailable: () => t("common.unavailable"),
			});
		case "control-health":
			return translateCode(field.value, {
				current_healthy: () => t("workspace.health.currentHealthy"),
				compatible_old_healthy: () => t("workspace.health.olderBuildHealthy"),
				stale_transport: () => t("workspace.health.staleTransport"),
				incompatible_protocol: () => t("workspace.health.incompatibleProtocol"),
				exited: () => t("common.exited"),
				generation_changed: () => t("workspace.health.generationChanged"),
				unprobed: () => t("workspace.health.unprobed"),
			});
		case "pane-health":
			return translateCode(field.value, {
				connecting: () => t("common.connecting"),
				live: () => t("workspace.health.healthy"),
				recovering: () => t("workspace.health.recovering"),
				stale: () => t("workspace.health.notResponding"),
				error: () => t("workspace.health.connectionError"),
			});
		case "ssh-state":
			return translateCode(field.value, {
				connecting: () => t("common.connecting"),
				connected: () => t("workspace.health.healthy"),
				reconnecting: () => t("workspace.health.reconnecting"),
				error: () => t("workspace.health.connectionError"),
				closed: () => t("common.exited"),
			});
		case "timestamp": {
			const timestamp = Number(field.value);
			return Number.isFinite(timestamp)
				? new Date(timestamp).toLocaleString()
				: field.value;
		}
		default:
			return field.key === "spaceId" && field.value === "detached"
				? t("workspace.paneInfo.value.detached")
				: field.value;
	}
}

function statusTone(field: PaneInfoField) {
	if (field.valueKind === "control-health") {
		if (
			field.value === "current_healthy" ||
			field.value === "compatible_old_healthy"
		) {
			return "run" as const;
		}
		if (field.value === "unprobed") return "warn" as const;
		return "error" as const;
	}
	if (field.valueKind === "pane-health") {
		if (field.value === "live") return "run" as const;
		if (field.value === "connecting" || field.value === "recovering") {
			return "warn" as const;
		}
		return "error" as const;
	}
	if (field.valueKind === "ssh-state") {
		if (field.value === "connected") return "run" as const;
		if (field.value === "connecting" || field.value === "reconnecting") {
			return "warn" as const;
		}
		return "error" as const;
	}
	return undefined;
}

export function PaneInfoDialog({
	info,
	open,
	onOpenChange,
}: {
	info: PaneInfoModel;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	// Shared copy-then-revert feedback (1.8s, last-write-wins). The hook owns
	// the clipboard write and the status window; this dialog only remembers
	// which field the latest copy targeted so the row can tint its own icon.
	const { status: copyStatus, copy } = useCopyFeedback();
	const [copiedFieldKey, setCopiedFieldKey] = useState<PaneInfoFieldKey>();
	const copyFeedback =
		copyStatus !== "idle" && copiedFieldKey !== undefined
			? { fieldKey: copiedFieldKey, status: copyStatus }
			: undefined;

	useEffect(() => {
		if (!open) setCopiedFieldKey(undefined);
	}, [open]);

	const copyValue = async (fieldKey: PaneInfoFieldKey, value: string) => {
		setCopiedFieldKey(fieldKey);
		await copy(value);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="grid max-h-[min(44rem,calc(100vh-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-3 sm:max-w-xl">
				<DialogHeader className="pr-8">
					<div className="flex items-center gap-2">
						<span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
							<ServerCog className="size-4" aria-hidden="true" />
						</span>
						<div className="min-w-0">
							<DialogTitle>{t("workspace.paneInfo.title")}</DialogTitle>
							<p className="mt-1 truncate text-xs text-muted-foreground">
								{info.title}
							</p>
						</div>
					</div>
					<DialogDescription>
						{t("workspace.paneInfo.description")}
					</DialogDescription>
					{copyFeedback && (
						<p
							role="status"
							className={cn(
								"text-xs text-status-run",
								copyFeedback.status === "failed" && "text-destructive",
							)}
						>
							{copyFeedback.status === "copied"
								? t("common.copiedToClipboard")
								: t("common.copyToClipboardFailed")}
						</p>
					)}
				</DialogHeader>

				<div className="min-h-0 space-y-3 overflow-y-auto pr-1">
					{info.sections.map((section) => (
						<section
							key={section.key}
							className="overflow-hidden rounded-lg border border-border/70 bg-muted/20"
						>
							<h3 className="border-b border-border/60 px-3 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
								{SECTION_LABELS[section.key]()}
							</h3>
							<KeyValueList>
								{section.fields.map((field) => {
									const tone = statusTone(field);
									const label = FIELD_LABELS[field.key]();
									const displayValue = formatPaneInfoValue(field);
									const fieldCopyFeedback =
										copyFeedback?.fieldKey === field.key
											? copyFeedback.status
											: undefined;
									return (
										<KeyValueRow
											key={field.key}
											label={label}
											mono={TECHNICAL_FIELDS.has(field.key)}
										>
											{tone && (
												<StatusDot tone={tone} className="mt-[7px]" />
											)}
											<span className="min-w-0 flex-1 break-all">
												{displayValue}
											</span>
											{/* IconButton at the field row's 20px so the value column keeps
											    its line; the outcome tints the glyph as before. */}
											<IconButton
												className={cn(
													"size-5 shrink-0 [&_svg]:size-3",
													fieldCopyFeedback === "copied" && "text-status-run hover:text-status-run",
													fieldCopyFeedback === "failed" && "text-destructive hover:text-destructive",
												)}
												onClick={() => void copyValue(field.key, displayValue)}
												title={`${label} ${t("common.copy")}`}
											>
												{fieldCopyFeedback === "copied" ? (
													<Check className="size-3" aria-hidden="true" />
												) : (
													<Copy className="size-3" aria-hidden="true" />
												)}
											</IconButton>
										</KeyValueRow>
									);
								})}
							</KeyValueList>
						</section>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}

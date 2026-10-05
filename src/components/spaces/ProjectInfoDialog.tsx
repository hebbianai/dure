import { Check, Copy } from "lucide-react";
import { KeyValueList, KeyValueRow } from "@/components/common/KeyValueList";
import { useCopyFeedback } from "@/components/common/useCopyFeedback";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import type { Project, SshHostConfig } from "@/types";

export function ProjectInfoDialog({
	project,
	sshHosts,
	onOpenChange,
	onCloseAutoFocus,
}: {
	project: Project;
	sshHosts: readonly SshHostConfig[];
	onOpenChange: (open: boolean) => void;
	onCloseAutoFocus: (event: Event) => void;
}) {
	const { status, copy } = useCopyFeedback();
	const host =
		project.kind === "ssh"
			? sshHosts.find((candidate) => candidate.id === project.sshHostId)
			: undefined;

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg"
				onCloseAutoFocus={onCloseAutoFocus}
			>
				<DialogHeader>
					<DialogTitle>{t("spaces.projectInfo.title")}</DialogTitle>
					<DialogDescription className="break-all pr-4" data-selectable="">
						{project.name}
					</DialogDescription>
				</DialogHeader>
				<KeyValueList className="-mx-3" labelWidth="6.5rem">
					<KeyValueRow
						label={t("spaces.projectInfo.folderPath")}
						mono
						selectable
					>
						<span className="min-w-0 flex-1 break-all">{project.path}</span>
						<IconButton
							title={t("spaces.projectInfo.copyPath")}
							onClick={() => void copy(project.path)}
						>
							{status === "copied" ? <Check /> : <Copy />}
						</IconButton>
					</KeyValueRow>
					<KeyValueRow label={t("common.location")}>
						{project.kind === "ssh" ? "SSH" : t("common.local")}
					</KeyValueRow>
					{project.kind === "ssh" && (
						<KeyValueRow label={t("spaces.projectInfo.sshHost")} selectable>
							<span className="min-w-0 break-all">
								{host?.name ?? t("common.sshHostNotFound")}
							</span>
						</KeyValueRow>
					)}
					<KeyValueRow label={t("spaces.projectInfo.type")}>
						{t(
							project.isRepo
								? "spaces.projectInfo.gitRepository"
								: "spaces.projectInfo.folder",
						)}
					</KeyValueRow>
				</KeyValueList>
				{status !== "idle" && (
					<p role="status" className="text-xs text-muted-foreground">
						{t(
							status === "copied"
								? "common.copiedToClipboard"
								: "common.copyToClipboardFailed",
						)}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}

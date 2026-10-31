import { MessageSquareText, SquareTerminal } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { useState } from "react";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { ErrorText } from "@/components/ui/error-text";
import { t } from "@/lib/i18n";
import {
	agentRuntimeTransitionFailure,
	DureAgentRuntimeSourceActiveError,
	type DureAgentRuntimeSourceStopPolicyV1,
	type DureAgentRuntimeTransitionFailureV1,
} from "@/lib/ipc/dureAgentRuntime";

export function AgentRuntimeProfileSwitch({
	disabled = false,
	disabledTitle,
	onSwitch,
	onSwitchingChange,
	sourceRevision,
	target = "chat",
}: {
	disabled?: boolean;
	disabledTitle?: string;
	onSwitch(
		sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1,
		expectedSourceRevision?: number,
	): Promise<void>;
	onSwitchingChange?(switching: boolean): void;
	sourceRevision?: number;
	target?: "chat" | "terminal";
}) {
	const [switching, setSwitching] = useState(false);
	const [failure, setFailure] =
		useState<DureAgentRuntimeTransitionFailureV1 | null>(null);
	const [discardSource, setDiscardSource] = useState<{
		expectedSourceRevision?: number;
	} | null>(null);
	const label = t(
		target === "chat"
			? switching
				? "agents.runtime.switchingToChat"
				: "agents.runtime.switchToChat"
			: switching
				? "agents.runtime.switchingToTerminal"
				: "agents.runtime.switchToTerminal",
	);
	// The backend's refusal code and reason tell the user whether to wait,
	// retry or act; a rejection without them keeps the generic sentence.
	const failed =
		failure?.code !== undefined && failure.reason !== undefined
			? t(
					target === "chat"
						? "agents.runtime.switchToChatFailedReason"
						: "agents.runtime.switchToTerminalFailedReason",
					{ code: failure.code, reason: failure.reason },
				)
			: t(
					target === "chat"
						? "agents.runtime.switchToChatFailed"
						: "agents.runtime.switchToTerminalFailed",
				);
	const targetName = t(
		target === "chat" ? "agents.runtime.chatTarget" : "common.terminal",
	);

	const runSwitch = (
		sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1,
		expectedSourceRevision: number | undefined,
	) => {
		if (switching) return;
		setSwitching(true);
		onSwitchingChange?.(true);
		setFailure(null);
		void onSwitch(sourceStopPolicy, expectedSourceRevision)
			.then(() => setDiscardSource(null))
			.catch((cause) => {
				if (
					sourceStopPolicy === "preserve" &&
					cause instanceof DureAgentRuntimeSourceActiveError
				) {
					const refusedRevision =
						cause.expectedSourceRevision ?? expectedSourceRevision;
					setDiscardSource(
						refusedRevision === undefined
							? {}
							: { expectedSourceRevision: refusedRevision },
					);
					return;
				}
				setFailure(agentRuntimeTransitionFailure(cause));
			})
			.finally(() => {
				setSwitching(false);
				onSwitchingChange?.(false);
			});
	};

	// The panel only ever offers the one other surface, but the control reads
	// as a selection — the current surface with a menu — so it shares the
	// launch pills' grammar instead of being a lone imperative button.
	const current = target === "chat" ? "terminal" : "chat";
	const currentName = t(
		current === "chat" ? "agents.runtime.chatTarget" : "common.terminal",
	);
	const viewLabel = t("agents.runtime.viewLabel");
	return (
		<>
			<div className="flex min-w-0 items-center gap-0.5">
				<SelectField
					aria-label={viewLabel}
					value={current}
					onValueChange={(next) => {
						if (next !== current) runSwitch("preserve", sourceRevision);
					}}
					disabled={disabled || switching}
					title={
						failure
							? failed
							: (disabledTitle ??
								(switching ? label : `${viewLabel}: ${currentName}`))
					}
					display={switching ? label : currentName}
					toolbar={{ label: viewLabel, reveal: 4 }}
					leadingIcon={
						switching ? (
							<DureLoader decorative />
						) : current === "chat" ? (
							<MessageSquareText className="size-3.5" />
						) : (
							<SquareTerminal className="size-3.5" />
						)
					}
				>
					<SelectOption value="chat">{t("agents.runtime.chatTarget")}</SelectOption>
					<SelectOption value="terminal">{t("common.terminal")}</SelectOption>
				</SelectField>
				{discardSource === null && (
					<ErrorText className="max-w-40 truncate text-[10px]" title={failed}>
						{failure ? failed : undefined}
					</ErrorText>
				)}
			</div>
			<Dialog
				open={discardSource !== null}
				onOpenChange={(open) => {
					if (!open && !switching) {
						setDiscardSource(null);
						setFailure(null);
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							{t("agents.runtime.discardSourceTitle", { target: targetName })}
						</DialogTitle>
						<DialogDescription>
							{t("agents.runtime.discardSourceDescription")}
						</DialogDescription>
					</DialogHeader>
					{failure && <ErrorText>{failed}</ErrorText>}
					<DialogActionFooter
						onCancel={() => {
							setDiscardSource(null);
							setFailure(null);
						}}
						confirmLabel={t("agents.runtime.discardSourceAction")}
						busyLabel={t("agents.runtime.discardSourceBusy")}
						busy={switching}
						variant="destructive"
						onConfirm={() => {
							if (discardSource !== null) {
								runSwitch("discard", discardSource.expectedSourceRevision);
							}
						}}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}

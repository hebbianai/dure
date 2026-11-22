import {
	Clock3,
	MessageSquareText,
	ScrollText,
	SquareTerminal,
	X,
	Zap,
} from "lucide-react";
import { useState } from "react";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DureLoader } from "@/components/ui/dure-loader";
import { ErrorText } from "@/components/ui/error-text";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import type {
	NativeAgentViewV1,
	PendingChatHandoverV1,
} from "@/lib/agents/chatHandover";
import {
	type NativeAgentViewPort,
	useChatHandoverInFlight,
} from "@/lib/agents/chatHandoverRuntime";
import { t } from "@/lib/i18n";
import {
	agentRuntimeTransitionFailure,
	type DureAgentRuntimeTransitionFailureV1,
} from "@/lib/ipc/dureAgentRuntime";
import { cn } from "@/lib/utils";

type ViewChoice = NativeAgentViewV1 | "chat";

function failureText(failure: DureAgentRuntimeTransitionFailureV1): string {
	return failure.code !== undefined && failure.reason !== undefined
		? t("agents.runtime.switchToChatFailedReason", {
				code: failure.code,
				reason: failure.reason,
			})
		: t("agents.runtime.switchToChatFailed");
}

/** The one View control of a native Terminal Agent: the terminal itself, the
 * observer Conversation, or a move into Chat. Chat is the primary action; a
 * busy agent keeps working and switches at its next idle turn boundary.
 * Stopping the turn to switch now is an explicit secondary choice. Every move
 * runs through `port`, so the pane and its large window change one runtime. */
export function AgentViewControl({
	agentId,
	view,
	pending,
	conversationOffered,
	conversationAvailable,
	chatAvailable,
	disabled = false,
	disabledTitle,
	chatDisabledTitle,
	port,
	onSwitchingChange,
}: {
	agentId: string;
	/** The observer view currently presented. */
	view: NativeAgentViewV1;
	pending?: PendingChatHandoverV1;
	conversationOffered: boolean;
	conversationAvailable: boolean;
	chatAvailable: boolean;
	disabled?: boolean;
	disabledTitle?: string;
	/** Why Chat cannot be chosen right now, when it cannot. */
	chatDisabledTitle?: string;
	port: NativeAgentViewPort;
	onSwitchingChange?(switching: boolean): void;
}) {
	const inFlight = useChatHandoverInFlight(agentId);
	const [requesting, setRequesting] = useState(false);
	const [failure, setFailure] =
		useState<DureAgentRuntimeTransitionFailureV1 | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const switching = requesting || inFlight;

	const run = (action: () => Promise<unknown>, onDone?: () => void) => {
		if (switching) return;
		setRequesting(true);
		onSwitchingChange?.(true);
		setFailure(null);
		void action()
			.then(() => onDone?.())
			.catch((cause) => setFailure(agentRuntimeTransitionFailure(cause)))
			.finally(() => {
				setRequesting(false);
				onSwitchingChange?.(false);
			});
	};

	const choose = (next: ViewChoice) => {
		if (next === "chat") {
			if (pending && pending.lastError === undefined) return;
			run(() => port.requestChat());
			return;
		}
		// Choosing a terminal view again is the user changing their mind about
		// a scheduled move; it must not leave a switch armed behind the menu.
		setFailure(null);
		void (pending ? port.cancelChat() : Promise.resolve())
			.then(() => port.setView(next))
			.catch((cause) => setFailure(agentRuntimeTransitionFailure(cause)));
	};

	const viewLabel = t("agents.runtime.viewLabel");
	const chatName = t("agents.runtime.chatTarget");
	const viewName =
		view === "conversation"
			? t("agents.nativeChat.conversation")
			: t("common.terminal");
	const pendingFailed = pending?.lastError !== undefined;
	const status = switching
		? undefined
		: pending
			? pendingFailed
				? t("agents.runtime.scheduledSwitchFailedStatus")
				: t("agents.runtime.switchesWhenIdle")
			: undefined;
	const title = switching
		? t("agents.runtime.switchingToChat")
		: pending
			? pendingFailed
				? t("agents.runtime.scheduledSwitchFailed", {
						error: pending.lastError ?? "",
					})
				: t("agents.runtime.chatWhenIdleTitle")
			: failure
				? failureText(failure)
				: (disabledTitle ?? `${viewLabel}: ${viewName}`);
	const icon = switching ? (
		<DureLoader size={14} decorative />
	) : pending ? (
		<Clock3
			className={cn(
				"size-3.5 shrink-0",
				pendingFailed ? "text-destructive" : "text-status-warn",
			)}
		/>
	) : view === "conversation" ? (
		<ScrollText className="size-3.5 shrink-0" />
	) : (
		<SquareTerminal className="size-3.5 shrink-0" />
	);
	const display = switching
		? t("agents.runtime.switchingToChat")
		: pending
			? chatName
			: viewName;

	return (
		<>
			<div className="flex min-w-0 items-center gap-0.5">
				<DropdownMenu>
					<DropdownMenuTrigger asChild disabled={disabled || switching}>
						<ToolbarControl
							label={viewLabel}
							title={title}
							icon={icon}
							reveal={4}
							aria-busy={switching}
							data-view-state={
								switching
									? "switching"
									: pending
										? pendingFailed
											? "error"
											: "pending"
										: view
							}
							status={
								status && (
									<span
										role="status"
										aria-live="polite"
										className={cn(
											"text-[10px]",
											pendingFailed ? "text-destructive" : "text-status-warn",
										)}
									>
										{status}
									</span>
								)
							}
							className="max-w-[180px]"
						>
							<span className="truncate">{display}</span>
						</ToolbarControl>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-60">
						{pending && (
							<DropdownMenuLabel
								className={cn(
									"whitespace-normal text-xs",
									pendingFailed ? "text-destructive" : "text-muted-foreground",
								)}
							>
								{title}
							</DropdownMenuLabel>
						)}
						<DropdownMenuRadioGroup
							value={pending ? "chat" : view}
							onValueChange={(next) => choose(next as ViewChoice)}
						>
							<DropdownMenuRadioItem value="terminal">
								<SquareTerminal />
								<span className="text-xs">{t("common.terminal")}</span>
							</DropdownMenuRadioItem>
							{conversationOffered && (
								<DropdownMenuRadioItem
									value="conversation"
									disabled={!conversationAvailable}
								>
									<ScrollText />
									<span className="text-xs">
										{t("agents.nativeChat.conversation")}
									</span>
								</DropdownMenuRadioItem>
							)}
							{chatAvailable && (
								<DropdownMenuRadioItem
									value="chat"
									disabled={chatDisabledTitle !== undefined}
									title={chatDisabledTitle}
								>
									<MessageSquareText />
									<span className="text-xs">{chatName}</span>
								</DropdownMenuRadioItem>
							)}
						</DropdownMenuRadioGroup>
						{pending && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => setConfirmDiscard(true)}>
									<Zap />
									<span className="text-xs">
										{t("agents.runtime.interruptAndSwitchNow")}
									</span>
								</DropdownMenuItem>
								<DropdownMenuItem
									onSelect={() => {
										void port
											.cancelChat()
											.catch((cause) =>
												setFailure(agentRuntimeTransitionFailure(cause)),
											);
									}}
								>
									<X />
									<span className="text-xs">
										{t("agents.runtime.cancelScheduledSwitch")}
									</span>
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				{!confirmDiscard && failure && (
					<ErrorText
						className="max-w-40 truncate text-[10px]"
						title={failureText(failure)}
					>
						{failureText(failure)}
					</ErrorText>
				)}
			</div>
			<Dialog
				open={confirmDiscard}
				onOpenChange={(open) => {
					if (!open && !switching) {
						setConfirmDiscard(false);
						setFailure(null);
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							{t("agents.runtime.discardSourceTitle", { target: chatName })}
						</DialogTitle>
						<DialogDescription>
							{t("agents.runtime.discardSourceDescription")}
						</DialogDescription>
					</DialogHeader>
					{failure && <ErrorText>{failureText(failure)}</ErrorText>}
					<DialogActionFooter
						onCancel={() => {
							setConfirmDiscard(false);
							setFailure(null);
						}}
						confirmLabel={t("agents.runtime.discardSourceAction")}
						busyLabel={t("agents.runtime.discardSourceBusy")}
						busy={switching}
						variant="destructive"
						onConfirm={() =>
							run(
								() => port.applyChatNow(),
								() => setConfirmDiscard(false),
							)
						}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}

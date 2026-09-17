import { Check, History, Plus } from "lucide-react";
import { Titled } from "@/components/ui/tooltip";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/lib/i18n";
import type { Conversation } from "@/lib/ipc";
import { formatRelativeAge } from "@/lib/ui/relativeAge";

export type AgentConversationTarget =
	| { kind: "id"; id: string }
	| { kind: "fresh" }
	| { kind: "continue" };

export function AgentConversationMenu({
	activeConversationId,
	conversations,
	disabled,
	disabledTitle,
	freshDisabled = disabled,
	freshLabel = t("common.newConversation"),
	hiddenTrigger = false,
	onError,
	onLoad,
	onOpenChange,
	onSwitch,
	open,
	resumeLabel = t("agents.conversation.resume"),
	triggerTitle = t("agents.conversation.recoverExited"),
}: {
	activeConversationId: string | null;
	conversations: Conversation[] | null;
	disabled: boolean;
	disabledTitle: string;
	freshDisabled?: boolean;
	freshLabel?: string;
	/** 트리거를 숨기고 앵커로만 쓴다 — 열기는 controlled open이 담당
	 *  (pane 톱바 ⋮ 항목에서 신호로 연다, 사용자 요청 2026-08-01). */
	hiddenTrigger?: boolean;
	onError(error: unknown): void;
	onLoad(): void;
	onOpenChange?(open: boolean): void;
	onSwitch(target: AgentConversationTarget): Promise<void>;
	open?: boolean;
	resumeLabel?: string;
	triggerTitle?: string;
}) {
	return (
		<DropdownMenu
			{...(open === undefined ? {} : { open })}
			onOpenChange={(next) => {
				if (next) onLoad();
				onOpenChange?.(next);
			}}
		>
			<Titled title={hiddenTrigger ? undefined : disabled ? disabledTitle : triggerTitle}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className={
							hiddenTrigger
								? "pointer-events-none size-0 overflow-hidden p-0 opacity-0"
								: "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
						}
						disabled={disabled}
						tabIndex={hiddenTrigger ? -1 : undefined}
						aria-hidden={hiddenTrigger || undefined}
						aria-label={hiddenTrigger ? undefined : triggerTitle}
					>
						<History className="size-3.5" />
					</button>
				</DropdownMenuTrigger>
			</Titled>
			<DropdownMenuContent
				align="end"
				className="max-h-96 w-80 overflow-y-auto"
			>
				<DropdownMenuItem
					disabled={disabled || freshDisabled}
					title={disabled || freshDisabled ? disabledTitle : undefined}
					onClick={() => void onSwitch({ kind: "fresh" }).catch(onError)}
				>
					<Plus className="size-4" /> {freshLabel}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuLabel className="text-[10px] text-muted-foreground">
					{t("agents.conversation.recent")} {conversations ? `(${conversations.length})` : "…"}
				</DropdownMenuLabel>
				{conversations === null && (
					<div className="px-2 py-2 text-xs text-muted-foreground">
						{t("common.loading")}
					</div>
				)}
				{conversations?.length === 0 && (
					<div className="px-2 py-2 text-xs text-muted-foreground">
						{t("agents.conversation.noPrevious")}
					</div>
				)}
				{conversations?.map((conversation) => (
					<DropdownMenuItem
						key={conversation.id}
						className="flex items-start gap-2"
						disabled={disabled || activeConversationId === conversation.id}
						title={disabled ? disabledTitle : undefined}
						onClick={() =>
							void onSwitch({
								kind: "id",
								id: conversation.id,
							}).catch(onError)
						}
					>
						<span className="mt-0.5 w-3 shrink-0">
							{activeConversationId === conversation.id && (
								<Check className="text-status-run" />
							)}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-xs">
								{conversation.title}
							</span>
							<span className="block font-mono text-[10px] text-muted-foreground">
								{formatRelativeAge(conversation.mtime * 1000)}
							</span>
						</span>
						{activeConversationId !== conversation.id && (
							<span className="shrink-0 self-center rounded bg-accent/70 px-1 py-0.5 text-[9px] leading-none text-muted-foreground">
								{resumeLabel}
							</span>
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

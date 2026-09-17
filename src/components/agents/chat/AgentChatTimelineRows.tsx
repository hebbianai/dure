import { Copy } from "lucide-react";
import {
	memo,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	AgentChatVirtualTimeline,
	type ChatTimelineContent,
} from "@/components/agents/chat/AgentChatVirtualTimeline";
import { ChatDisclosure } from "@/components/agents/chat/ChatDisclosure";
import { ChatMarkdown } from "@/components/agents/chat/ChatMarkdown";
import { ChatToolBurst } from "@/components/agents/chat/ChatToolBurst";
import { CodeBlock } from "@/components/common/CodeBlock";
import { EmptyHint } from "@/components/common/StatusBlocks";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { IconButton } from "@/components/ui/icon-button";
import { useWorkspaceRuntimeActive } from "@/components/workspace/WorkspaceRuntimeContext";
import { splitPromptAttachments } from "@/lib/agents/attachmentPrompt";
import {
	type AgentChatActiveTurnV1,
	type AgentChatProjectedRow,
	type AgentChatTranscriptTailFacts,
	type AgentChatTurnBlock,
	projectAgentChatTranscript,
	transcriptTailFacts,
} from "@/lib/agents/chat/agentChatProjection";
import {
	type AgentChatTimelineItem,
	agentChatTimelineItems,
} from "@/lib/agents/chat/agentChatTimelineItems";
import type {
	AgentPendingRequestV1,
	AgentTimelineItemBodyV1,
	AgentTimelinePageV1,
} from "@/lib/agents/chat/agentConversationContract";
import { presentPendingAnswer } from "@/lib/agents/chat/agentPendingPresentation";
import {
	formatWorkedDuration,
	opaqueJsonText,
} from "@/lib/agents/chat/chatFormat";
import { presentLifecycleRow } from "@/lib/agents/chat/lifecycleRowPresentation";
import {
	type PlanStepState,
	presentPlan,
} from "@/lib/agents/chat/planPresentation";
import {
	parseTurnFailureReason,
	TURN_FAILURE_REASON_COPY,
} from "@/lib/agents/chat/turnFailureReason";
import { t } from "@/lib/i18n";
import { readChatAttachment } from "@/lib/ipc";
import { copyTextToClipboard } from "@/lib/platform/clipboardWrite";

/** Read attachment bytes when their placeholder reaches the viewport. Reserve
 * the preview's maximum height so a stack of short filenames cannot admit all
 * images before their bytes arrive. Loaded bytes stay with this mounted row. */
function ChatAttachmentImage({
	path,
	fileName,
}: {
	path: string;
	fileName: string;
}) {
	const targetRef = useRef<HTMLSpanElement>(null);
	const [image, setImage] = useState<{ path: string; source: string | null }>();
	const source = image?.path === path ? image.source : undefined;
	useEffect(() => {
		const target = targetRef.current;
		const view = target?.ownerDocument.defaultView;
		if (!target || !view) return;
		let cancelled = false;
		let requested = false;
		const observer = new view.IntersectionObserver(
			(entries) => {
				if (
					cancelled ||
					requested ||
					!entries.some(
						(entry) => entry.target === target && entry.isIntersecting,
					)
				)
					return;
				requested = true;
				observer.disconnect();
				void readChatAttachment(path).then(
					({ mime, dataB64 }) => {
						if (!cancelled)
							setImage({ path, source: `data:${mime};base64,${dataB64}` });
					},
					() => {
						if (!cancelled) setImage({ path, source: null });
					},
				);
			},
			{ rootMargin: "200px 0px" },
		);
		observer.observe(target);
		return () => {
			cancelled = true;
			observer.disconnect();
		};
	}, [path]);
	return (
		<span ref={targetRef} className="block">
			{source ? (
				<img
					src={source}
					alt={fileName}
					className="max-h-56 max-w-full rounded-md object-contain"
				/>
			) : (
				<span
					className={`text-[0.85em] text-muted-foreground ${source === undefined ? "flex h-56 items-center" : ""}`}
				>
					{fileName}
				</span>
			)}
		</span>
	);
}

/** The user's prompt chip: pasted images render as images and the file
 * references the provider needs stay out of sight; the typed text keeps its
 * exact whitespace. */
function UserMessageChip({ markdown }: { markdown: string }) {
	const { body, attachments } = useMemo(
		() => splitPromptAttachments(markdown),
		[markdown],
	);
	if (attachments.length === 0) return markdown;
	return (
		<span className="flex flex-col gap-1.5">
			{attachments.map((attachment) => (
				<ChatAttachmentImage
					key={attachment.path}
					path={attachment.path}
					fileName={attachment.fileName}
				/>
			))}
			{body && <span>{body}</span>}
		</span>
	);
}

/** Elapsed time since the live turn's user message — the one moving element
 * while the agent works, so waiting has a visible measure. */
function LiveElapsed({ startedAtMs }: { startedAtMs: number }) {
	const [now, setNow] = useState(() => Date.now());
	const workspaceActive = useWorkspaceRuntimeActive();
	useLayoutEffect(() => {
		if (!workspaceActive) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [workspaceActive]);
	return (
		<span className="font-mono text-muted-foreground tabular-nums">
			{formatWorkedDuration(Math.max(0, now - startedAtMs))}
		</span>
	);
}

function lifecycleLabel(
	body: Extract<AgentTimelineItemBodyV1, { type: "lifecycle" }>,
) {
	return t(`agents.chat.lifecycle.${body.state}`);
}

/** Quiet centered notice row (history boundary, lifecycle transitions). */
function CenteredNotice({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-center justify-center gap-2 py-0.5 text-center text-[0.85em] text-muted-foreground">
			{children}
		</div>
	);
}

const PLAN_STEP_DOT_CLASS: Readonly<Record<PlanStepState, string>> = {
	done: "border-muted-foreground/60 bg-muted-foreground/60",
	active: "border-foreground",
	pending: "border-muted-foreground/60",
};

const PLAN_STEP_TEXT_CLASS: Readonly<Record<PlanStepState, string>> = {
	done: "text-muted-foreground line-through decoration-muted-foreground/40",
	active: "font-medium text-foreground",
	pending: "text-muted-foreground",
};

function PlanRow({
	body,
	rowKey,
}: {
	body: Extract<AgentTimelineItemBodyV1, { type: "plan" }>;
	rowKey: string;
}) {
	const plan = presentPlan(body.value);
	if (!plan) {
		return (
			<ChatDisclosure
				disclosureKey={`plan:${rowKey}`}
				className="w-full text-[0.92em]"
			>
				{(expanded) => (
					<>
						<summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground/75">
							{t("agents.chat.plan")}
						</summary>
						{expanded && (
							<CodeBlock className="mt-1.5" maxHeightClass="max-h-64">
								{opaqueJsonText(body.value)}
							</CodeBlock>
						)}
					</>
				)}
			</ChatDisclosure>
		);
	}
	return (
		<section className="w-full">
			<h4 className="text-[0.77em] font-medium tracking-[0.14em] text-muted-foreground uppercase">
				{t("agents.chat.plan")}
			</h4>
			{plan.explanation && (
				<p data-selectable className="mt-1 text-[0.92em] text-muted-foreground">
					{plan.explanation}
				</p>
			)}
			<ul className="mt-1.5 flex flex-col gap-1 text-[0.92em]">
				{plan.steps.map((step, index) => (
					<li
						key={`${index}:${step.text}`}
						className="flex items-baseline gap-2.5"
					>
						<span
							aria-hidden="true"
							className={`size-2 shrink-0 translate-y-px rounded-full border ${PLAN_STEP_DOT_CLASS[step.state]}`}
						/>
						<span
							data-selectable
							className={`min-w-0 break-words ${PLAN_STEP_TEXT_CLASS[step.state]}`}
						>
							{step.text}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function TimelineRow({
	projected,
	dimmed = false,
}: {
	projected: AgentChatProjectedRow;
	dimmed?: boolean;
}) {
	const { body } = projected.timeline.item;
	switch (body.type) {
		case "message": {
			if (body.role === "assistant") {
				return (
					<div className="w-full">
						<ChatMarkdown markdown={body.markdown} />
					</div>
				);
			}
			return (
				<article
					data-selectable
					className={`ml-auto w-fit max-w-[85%] rounded-lg bg-glass-tint-selected px-3 py-1.5 break-words whitespace-pre-wrap text-foreground ${
						dimmed
							? "opacity-60 transition-opacity duration-150 hover:opacity-100"
							: ""
					}`}
				>
					<UserMessageChip markdown={body.markdown} />
				</article>
			);
		}
		case "goal_continuation":
			return (
				<ChatDisclosure
					disclosureKey={`goal:${projected.key}`}
					className="text-muted-foreground"
				>
					<summary className="cursor-pointer select-none">
						{t("agents.chat.goal.continuing")}
					</summary>
					<p data-selectable className="mt-1 whitespace-pre-wrap break-words">
						{body.objective}
					</p>
				</ChatDisclosure>
			);
		case "pending_answer": {
			const answer = presentPendingAnswer(body.request.request, body.answer);
			return (
				<div className="w-full whitespace-pre-wrap break-words">
					<p className="text-muted-foreground">
						{t(
							answer.decision === "allow"
								? "agents.chat.answer.allowed"
								: answer.decision === "deny"
									? "agents.chat.answer.declined"
									: "agents.chat.answer.delivered",
						)}
					</p>
					{answer.permission && (
						<p data-selectable>
							{[
								answer.permission.title,
								answer.permission.description,
								answer.permission.blockedPath,
							]
								.filter(Boolean)
								.join("\n")}
						</p>
					)}
					{answer.questions.map((question, index) => (
						<dl key={`${index}:${question.question}`} className="mt-1">
							<dt data-selectable className="text-muted-foreground">
								{question.question}
							</dt>
							<dd data-selectable>
								{question.answer ?? t("agents.chat.answer.sensitiveHidden")}
							</dd>
						</dl>
					))}
				</div>
			);
		}
		case "reasoning":
			return (
				<ChatDisclosure
					disclosureKey={`reasoning:${projected.key}`}
					className="w-fit max-w-full text-[0.92em]"
				>
					<summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground/75">
						{t("agents.chat.reasoning")}
					</summary>
					<p
						data-selectable
						className="mt-1 border-l border-glass-hairline pl-3 break-words whitespace-pre-wrap text-muted-foreground"
					>
						{body.text}
					</p>
				</ChatDisclosure>
			);
		case "tool":
			return <ChatToolBurst rows={[projected]} shimmerToolKey={null} />;
		case "tool_input":
			return (
				<div className="w-full">
					<CodeBlock maxHeightClass="max-h-56">{body.jsonText}</CodeBlock>
				</div>
			);
		case "plan":
			return <PlanRow body={body} rowKey={projected.key} />;
		case "error":
			return (
				<Alert>
					<span data-selectable>{body.message}</span>
				</Alert>
			);
		case "history_boundary":
			return (
				<CenteredNotice>{t("agents.chat.historyBoundary")}</CenteredNotice>
			);
		case "provider_evidence":
			return null;
		case "lifecycle": {
			const lifecycle = presentLifecycleRow(body.state, body.detail);
			if (lifecycle.kind === "hidden") return null;
			// A shared reason token reads as words; anything else stays verbatim
			// so an operator never loses the one fact they need.
			const reason =
				body.state === "turn_failed"
					? parseTurnFailureReason(body.detail)
					: undefined;
			return (
				<CenteredNotice>
					<span className={lifecycle.failed ? "text-destructive" : undefined}>
						{reason
							? t(TURN_FAILURE_REASON_COPY[reason])
							: lifecycleLabel(body)}
					</span>
					{!reason && lifecycle.detail && (
						<span data-selectable>{lifecycle.detail}</span>
					)}
				</CenteredNotice>
			);
		}
	}
}

// A completed turn is the norm and stays quiet: the footer keeps only a
// hover-revealed copy affordance (space reserved, no layout shift) and a real
// worked-for duration when the turn ran a minute or longer. Failed/canceled
// outcomes surface their status; success is never announced.
function TurnFooter({ turn }: { turn: AgentChatTurnBlock }) {
	if (turn.state === "active") return null;
	const exceptional = turn.state !== "completed";
	const worked =
		turn.workedMs !== null && turn.workedMs >= 60_000
			? formatWorkedDuration(turn.workedMs)
			: null;
	if (!exceptional && !turn.assistantMarkdown && !worked) return null;
	return (
		<div
			data-agent-turn-footer
			className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground"
		>
			{turn.assistantMarkdown && (
				<IconButton
					title={t("agents.chat.copyResponse")}
					className="size-5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-visible:opacity-100"
					onClick={() => void copyTextToClipboard(turn.assistantMarkdown)}
				>
					<Copy aria-hidden="true" />
				</IconButton>
			)}
			{worked && (
				<span>{t("agents.chat.workedFor", { duration: worked })}</span>
			)}
			{exceptional && (
				<span
					className={turn.state === "failed" ? "text-destructive" : undefined}
				>
					{turn.failureReason
						? t(TURN_FAILURE_REASON_COPY[turn.failureReason])
						: t(`agents.chat.lifecycle.turn_${turn.state}`)}
				</span>
			)}
		</div>
	);
}

function rowAnchors(rows: readonly AgentChatProjectedRow[]): string {
	return rows.flatMap((row) => row.revision.split("|")).join(" ");
}

function isUserMessageRow(row: AgentChatProjectedRow): boolean {
	const { body } = row.timeline.item;
	return body.type === "message" && body.role === "user";
}

const TimelineHistoryItem = memo(function TimelineHistoryItem({
	item,
	lastUserKey,
	shimmerTarget,
}: {
	item: AgentChatTimelineItem;
	lastUserKey: string | null;
	shimmerTarget: AgentChatTranscriptTailFacts["activeTurnRunningTool"];
}) {
	if (item.kind === "footer") {
		return (
			<div className="group/turn pb-3 @2xl/chat:pb-4">
				<TurnFooter turn={item.turn} />
			</div>
		);
	}
	const { segment, turn } = item;
	return (
		<div
			data-agent-chat-row-anchors={rowAnchors(
				segment.kind === "tools" ? segment.rows : [segment.row],
			)}
			className={
				turn ? "w-full pb-2 @2xl/chat:pb-2.5" : "w-full pb-3 @2xl/chat:pb-4"
			}
		>
			{segment.kind === "tools" ? (
				<ChatToolBurst
					rows={segment.rows}
					shimmerToolKey={
						turn &&
						shimmerTarget?.turnId === turn.turnId &&
						shimmerTarget.clientMessageId === turn.clientMessageId
							? shimmerTarget.toolKey
							: null
					}
				/>
			) : (
				<TimelineRow
					projected={segment.row}
					dimmed={
						isUserMessageRow(segment.row) && segment.row.key !== lastUserKey
					}
				/>
			)}
		</div>
	);
});

export const TranscriptContents = memo(function TranscriptContents({
	page,
	active = false,
	shimmerTurn,
	loadingOlder,
	olderHistoryError,
	onLoadOlder,
	renderPending,
}: {
	page: AgentTimelinePageV1;
	active?: boolean;
	shimmerTurn?: AgentChatActiveTurnV1;
	loadingOlder: boolean;
	olderHistoryError?: string;
	onLoadOlder: () => Promise<void>;
	renderPending?: (request: AgentPendingRequestV1) => ReactNode;
}) {
	const transcript = useMemo(
		() => projectAgentChatTranscript(page.rows),
		[page.rows],
	);
	const shimmerTurnId = shimmerTurn?.turnId;
	const shimmerTurnClientMessageId = shimmerTurn?.clientMessageId;
	const { lastUserKey, activeTurnRunningTool, lastUserAtMs } = useMemo(
		() =>
			transcriptTailFacts(
				transcript,
				shimmerTurnId && shimmerTurnClientMessageId
					? {
							turnId: shimmerTurnId,
							clientMessageId: shimmerTurnClientMessageId,
						}
					: undefined,
			),
		[shimmerTurnClientMessageId, shimmerTurnId, transcript],
	);
	// Keep the historical React elements stable during live-text-only updates.
	const history = useMemo<ChatTimelineContent[]>(
		() =>
			agentChatTimelineItems(transcript).map((item) => ({
				key: `history:${item.key}`,
				content: (
					<TimelineHistoryItem
						item={item}
						lastUserKey={lastUserKey}
						shimmerTarget={activeTurnRunningTool}
					/>
				),
			})),
		[transcript, lastUserKey, activeTurnRunningTool],
	);
	const items: ChatTimelineContent[] = [];
	let header: ReactNode;
	if (page.hasMore || olderHistoryError) {
		header = (
			<div className="flex flex-col items-center gap-1 pb-3 @2xl/chat:pb-4">
				{page.hasMore && (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						disabled={loadingOlder}
						aria-busy={loadingOlder}
						onClick={() => void onLoadOlder().catch(() => {})}
					>
						{loadingOlder
							? t("agents.chat.loadingEarlierHistory")
							: t("agents.chat.loadEarlierHistory")}
					</Button>
				)}
				<ErrorText className="text-center">{olderHistoryError}</ErrorText>
			</div>
		);
	}
	if (transcript.length === 0 && page.liveText.length === 0) {
		items.push({
			key: "empty",
			content: <EmptyHint>{t("agents.chat.empty")}</EmptyHint>,
		});
	}
	items.push(...history);
	for (const head of page.liveText) {
		items.push({
			key: `live:${head.streamId}`,
			content: (
				<div className="w-full pb-3 @2xl/chat:pb-4">
					{head.kind === "assistant" ? (
						<ChatMarkdown
							key={JSON.stringify([
								page.binding.interactionSessionId,
								page.binding.timelineEpoch,
								page.binding.runtime.runtimeGeneration,
								page.binding.runtime.providerEpoch,
								head.streamId,
							])}
							markdown={head.text}
							streaming={active}
						/>
					) : (
						<span
							data-selectable
							className="break-words whitespace-pre-wrap text-muted-foreground"
						>
							{head.text}
						</span>
					)}
				</div>
			),
		});
	}
	for (const pending of page.pendingRequests) {
		items.push({
			key: `pending:${pending.request.requestId}`,
			keepMounted: true,
			content: (
				<div className="pb-3 @2xl/chat:pb-4">
					{renderPending?.(pending) ?? (
						<CodeBlock maxHeightClass="max-h-64">
							{opaqueJsonText(pending.request.payload)}
						</CodeBlock>
					)}
				</div>
			),
		});
	}
	if (active) {
		items.push({
			key: "active",
			content: (
				<div className="flex items-baseline gap-2 text-[0.85em]">
					{shimmerTurn && activeTurnRunningTool === null && (
						<span className="chat-shimmer">{t("agents.chat.streaming")}</span>
					)}
					{lastUserAtMs !== null && <LiveElapsed startedAtMs={lastUserAtMs} />}
				</div>
			),
		});
	}
	// Pending cards and the active indicator have stable keys after incoming
	// messages. Advance the end marker so append following sees that growth.
	items.push({
		key: `end:${page.finalCursor.sequence}:${items.length}`,
		content: null,
	});
	return (
		<AgentChatVirtualTimeline
			key={JSON.stringify([
				page.binding.interactionSessionId,
				page.binding.timelineEpoch,
			])}
			header={header}
			items={items}
		/>
	);
});

import {
	defaultRangeExtractor,
	measureElement,
	observeElementOffset,
	observeElementRect,
	useVirtualizer,
	type VirtualItem,
} from "@tanstack/react-virtual";
import {
	createContext,
	memo,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	ChatDisclosure,
	ChatDisclosureState,
} from "@/components/agents/chat/ChatDisclosure";
import { ChatFileDiff } from "@/components/agents/chat/ChatFileDiff";
import { CodeBlock } from "@/components/common/CodeBlock";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import type { AgentChatProjectedRow } from "@/lib/agents/chat/agentChatProjection";
import type { AgentTimelineItemBodyV1 } from "@/lib/agents/chat/agentConversationContract";
import { opaqueJsonText } from "@/lib/agents/chat/chatFormat";
import {
	summarizeToolBurst,
	type ToolBurstCategory,
} from "@/lib/agents/chat/toolBurstPresentation";
import { presentToolDetail } from "@/lib/agents/chat/toolDetailPresentation";
import { presentToolRow } from "@/lib/agents/chat/toolRowPresentation";
import { t } from "@/lib/i18n";

type ToolTimelineBody = Extract<AgentTimelineItemBodyV1, { type: "tool" }>;
type ToolBurstEntry = { row: AgentChatProjectedRow; body: ToolTimelineBody };

export interface ToolBurstViewportMemory {
	offset: number;
	measurements: VirtualItem[];
}

// The transcript owns this memory so releasing a whole burst's DOM does not
// lose the inner viewport. Standalone bursts retain it for their own lifetime.
export const ChatToolBurstViewportState =
	createContext<ToolBurstViewportMemory | null>(null);

// Literal t("…") calls keep every fragment visible to the i18n coverage scan.
function burstFragment(category: ToolBurstCategory, count: number): string {
	switch (category) {
		case "read":
			return count === 1
				? t("agents.chat.workReadOne")
				: t("agents.chat.workReadMany", { count });
		case "edit":
			return count === 1
				? t("agents.chat.workEditOne")
				: t("agents.chat.workEditMany", { count });
		case "run":
			return count === 1
				? t("agents.chat.workRunOne")
				: t("agents.chat.workRunMany", { count });
		case "search":
			return count === 1
				? t("agents.chat.workSearchOne")
				: t("agents.chat.workSearchMany", { count });
		case "other":
			return count === 1
				? t("agents.chat.workOtherOne")
				: t("agents.chat.workOtherMany", { count });
	}
}

function ToolRowDetail({ body }: { body: ToolTimelineBody }) {
	const detail = presentToolDetail(body.name, body.input, body.output);
	if (detail.kind === "shell") {
		return (
			<CodeBlock maxHeightClass="max-h-64">
				{detail.output
					? `$ ${detail.command}\n\n${detail.output}`
					: `$ ${detail.command}`}
			</CodeBlock>
		);
	}
	if (detail.kind === "file") {
		return (
			<div className="flex flex-col gap-1.5">
				{(detail.added !== null || detail.removed !== null) && (
					<div className="flex items-baseline gap-2 font-mono text-[0.92em]">
						{detail.added !== null && (
							<span className="text-vcs-added">+{detail.added}</span>
						)}
						{detail.removed !== null && (
							<span className="text-vcs-deleted">−{detail.removed}</span>
						)}
						{detail.path && (
							<span className="min-w-0 truncate text-muted-foreground">
								{detail.path}
							</span>
						)}
					</div>
				)}
				{detail.files.length > 0
					? detail.files.map((file, index) => (
							<ChatFileDiff
								key={file.path ?? index}
								diff={file.diff}
								path={detail.files.length > 1 ? file.path : null}
							/>
						))
					: body.input !== null && (
							<CodeBlock maxHeightClass="max-h-56">
								{opaqueJsonText(body.input)}
							</CodeBlock>
						)}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			{body.input !== null && (
				<CodeBlock maxHeightClass="max-h-56">
					{opaqueJsonText(body.input)}
				</CodeBlock>
			)}
			{body.output !== null && (
				<CodeBlock maxHeightClass="max-h-64">
					{opaqueJsonText(body.output)}
				</CodeBlock>
			)}
		</div>
	);
}

/** One tool call inside an expanded burst: verb + argument, with failures in
 * tone and the pane's sole running shimmer reserved for the burst headline.
 * The memo guard keeps unchanged snapshots from reserializing payloads on
 * unrelated updates. */
const ToolRow = memo(
	function ToolRow({
		body,
		rowKey,
		stateLabel,
	}: {
		body: ToolTimelineBody;
		rowKey: string;
		snapshotRevision: string;
		stateLabel: string;
	}) {
		const { label, detail } = presentToolRow(body.name, body.input);
		return (
			<ChatDisclosure
				disclosureKey={`tool:${rowKey}`}
				open={body.state === "failed" || undefined}
				className="group/tool border-t border-glass-hairline first:border-t-0"
			>
				{(expanded) => (
					<>
						<summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1 select-none hover:bg-glass-tint-hover">
							<DisclosureChevron className="group-open/tool:rotate-90" />
							<span className="shrink-0 font-medium text-foreground/75">
								{label}
							</span>
							{detail && (
								<span className="min-w-0 truncate font-mono text-[0.92em] text-muted-foreground">
									{detail}
								</span>
							)}
							{(body.state === "failed" || body.state === "canceled") && (
								<span
									className={`ml-auto shrink-0 pl-2 text-[0.92em] ${
										body.state === "failed"
											? "text-destructive"
											: "text-muted-foreground"
									}`}
								>
									{stateLabel}
								</span>
							)}
						</summary>
						{expanded && (
							<div className="px-2.5 pt-1 pb-2">
								<ToolRowDetail body={body} />
							</div>
						)}
					</>
				)}
			</ChatDisclosure>
		);
	},
	(previous, next) =>
		previous.snapshotRevision === next.snapshotRevision &&
		previous.stateLabel === next.stateLabel,
);

function renderTool({ row, body }: ToolBurstEntry) {
	return (
		<ToolRow
			key={row.key}
			rowKey={row.key}
			body={body}
			snapshotRevision={row.revision}
			stateLabel={t(`agents.chat.toolState.${body.state}`)}
		/>
	);
}

function VirtualToolRows({
	tools,
	label,
}: {
	tools: readonly ToolBurstEntry[];
	label: string;
}) {
	const memory = useContext(ChatToolBurstViewportState)!;
	const scrollRef = useRef<HTMLDivElement>(null);
	const [focusedKey, setFocusedKey] = useState<string | null>(null);
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: tools.length,
		useFlushSync: false,
		getScrollElement: () => scrollRef.current,
		getItemKey: (index) => tools[index]!.row.key,
		estimateSize: () => 28,
		overscan: 4,
		initialOffset: memory.offset,
		initialMeasurementsCache: memory.measurements,
		measureElement: (element, entry, instance) => {
			if (!instance.scrollElement?.offsetHeight) {
				return (
					instance.itemSizeCache.get(
						instance.options.getItemKey(instance.indexFromElement(element)),
					) ?? 28
				);
			}
			return measureElement(element, entry, instance);
		},
		observeElementRect: (instance, callback) =>
			observeElementRect(instance, (rect) => {
				if (rect.height > 0) callback(rect);
			}),
		observeElementOffset: (instance, callback) =>
			observeElementOffset(instance, (offset, scrolling) => {
				if (instance.scrollElement?.offsetHeight) {
					memory.offset = offset;
					callback(offset, scrolling);
				}
			}),
		rangeExtractor: (range) => {
			const visible = defaultRangeExtractor(range);
			const focused = tools.findIndex(({ row }) => row.key === focusedKey);
			// Keep native Tab/Shift+Tab targets mounted even before the browser
			// delivers the scroll event caused by focusing an overscan row.
			if (focused >= 0) {
				visible.push(focused);
				if (focused > 0) visible.push(focused - 1);
				if (focused + 1 < tools.length) visible.push(focused + 1);
			}
			return [...new Set(visible)].sort((a, b) => a - b);
		},
	});
	useLayoutEffect(
		() => () => {
			memory.measurements = virtualizer.takeSnapshot();
		},
		[memory, virtualizer],
	);
	return (
		<div
			ref={scrollRef}
			role="region"
			aria-label={label}
			className="h-96 overflow-y-auto [overflow-anchor:none]"
		>
			<div className="relative" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((item) => (
					<div
						key={item.key}
						ref={virtualizer.measureElement}
						data-index={item.index}
						className={`absolute top-0 left-0 w-full ${item.index > 0 ? "[&>details]:border-t" : ""}`}
						style={{ transform: `translateY(${item.start}px)` }}
						onFocusCapture={() => setFocusedKey(tools[item.index]!.row.key)}
						onBlurCapture={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget))
								setFocusedKey(null);
						}}
					>
						{renderTool(tools[item.index]!)}
					</div>
				))}
			</div>
		</div>
	);
}

// Joined with a locale-neutral middle dot — list-conjunction grammar differs
// per language and a punctuation rail matches the pane's meta voice.
function burstSentence(tools: readonly ToolTimelineBody[]): string {
	return summarizeToolBurst(tools)
		.parts.map((part) => burstFragment(part.category, part.count))
		.join(" · ");
}

/** A burst of consecutive tool calls: collapsed to one quiet line — the live
 * verb + argument (shimmering) while a call runs, an aggregated past-tense
 * sentence once the burst settles — with the per-call rows behind it. */
export function ChatToolBurst({
	rows,
	shimmerToolKey,
}: {
	rows: readonly AgentChatProjectedRow[];
	shimmerToolKey: string | null;
}) {
	const inheritedDisclosures = useContext(ChatDisclosureState);
	const inheritedViewport = useContext(ChatToolBurstViewportState);
	const [localDisclosures] = useState(() => new Map<string, boolean>());
	const [localViewport] = useState<ToolBurstViewportMemory>(() => ({
		offset: 0,
		measurements: [],
	}));
	const tools = rows.flatMap((row) =>
		row.timeline.item.body.type === "tool"
			? [{ row, body: row.timeline.item.body }]
			: [],
	);
	if (tools.length === 0) return null;
	const runningTool = [...tools]
		.reverse()
		.find((tool) => tool.body.state === "running");
	const shimmer = runningTool?.row.key === shimmerToolKey;
	const failed = tools.filter((tool) => tool.body.state === "failed").length;

	let headline: string;
	if (runningTool) {
		const live = presentToolRow(runningTool.body.name, runningTool.body.input);
		headline = live.detail ? `${live.label} ${live.detail}` : live.label;
	} else if (tools.length === 1) {
		const only = tools[0] as (typeof tools)[number];
		const line = presentToolRow(only.body.name, only.body.input);
		headline = line.detail ? `${line.label} ${line.detail}` : line.label;
	} else {
		headline = burstSentence(tools.map((tool) => tool.body));
	}

	return (
		<ChatDisclosureState value={inheritedDisclosures ?? localDisclosures}>
			<ChatToolBurstViewportState value={inheritedViewport ?? localViewport}>
				<ChatDisclosure
					disclosureKey={`burst:${rows[0]?.key}`}
					className="group/burst w-full text-[0.92em]"
				>
					{(expanded) => (
						<>
							{/* An expandable line without a caret reads as inert status text;
					    the shared chevron is the affordance (user report 2026-08-31). */}
							<summary className="flex cursor-pointer items-center gap-1.5 select-none">
								<DisclosureChevron className="group-open/burst:rotate-90" />
								<span
									className={`block min-w-0 truncate [&::first-letter]:uppercase ${
										shimmer
											? "chat-shimmer"
											: "text-muted-foreground hover:text-foreground/75"
									}`}
								>
									{headline}
								</span>
								{failed > 0 && (
									<span className="shrink-0 text-destructive">
										{failed === 1
											? t("agents.chat.workFailedOne")
											: t("agents.chat.workFailedMany", { count: failed })}
									</span>
								)}
							</summary>
							{expanded && (
								<div className="mt-1.5 w-full overflow-hidden rounded-md border border-glass-hairline">
									{tools.length > 40 ? (
										<VirtualToolRows tools={tools} label={headline} />
									) : (
										tools.map(renderTool)
									)}
								</div>
							)}
						</>
					)}
				</ChatDisclosure>
			</ChatToolBurstViewportState>
		</ChatDisclosureState>
	);
}

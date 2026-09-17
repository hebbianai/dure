import {
	defaultRangeExtractor,
	elementScroll,
	measureElement,
	observeElementOffset,
	observeElementRect,
	useVirtualizer,
} from "@tanstack/react-virtual";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ChatDisclosureState } from "@/components/agents/chat/ChatDisclosure";
import {
	ChatToolBurstViewportState,
	type ToolBurstViewportMemory,
} from "@/components/agents/chat/ChatToolBurst";
import { ScrollToLatestButton } from "@/components/common/ScrollToLatestButton";
import { t } from "@/lib/i18n";

export interface ChatTimelineContent {
	key: string;
	content: ReactNode;
	/** Unanswered request cards own local, unsubmitted form state. */
	keepMounted?: boolean;
}

const observeChatViewport: typeof observeElementRect<HTMLDivElement> = (
	instance,
	callback,
) => {
	let firstVisibleLayout = true;
	return observeElementRect(instance, (rect) => {
		// A hidden pane has no usable geometry. Retain its window so unanswered
		// request cards keep their local form state until the pane is shown again.
		if (rect.height === 0) return;
		const initialize = firstVisibleLayout;
		firstVisibleLayout = false;
		const previousHeight = instance.scrollRect?.height ?? rect.height;
		const wasAtEnd =
			instance.getTotalSize() - (instance.scrollOffset ?? 0) - previousHeight <=
				instance.options.scrollEndThreshold || instance.isAtEnd();
		callback(rect);
		if (initialize) {
			instance.scrollToEnd();
		} else if (wasAtEnd && rect.height > 0) {
			elementScroll(
				Math.max(0, instance.getTotalSize() - rect.height),
				{},
				instance,
			);
		}
	});
};

function isAtDomEnd(element: HTMLElement | null, threshold: number): boolean {
	return (
		!!element &&
		element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
	);
}

/** One geometry owner handles windowing, prepend anchors and tail following.
 * Measured heights belong to stable row keys, never array positions. */
export function AgentChatVirtualTimeline({
	items,
	header,
}: {
	items: readonly ChatTimelineContent[];
	header?: ReactNode;
}) {
	const [disclosures] = useState(() => new Map<string, Map<string, boolean>>());
	const [toolViewports] = useState(
		() => new Map<string, ToolBurstViewportMemory>(),
	);
	const toolViewport = (key: string) => {
		let state = toolViewports.get(key);
		if (!state) {
			state = { offset: 0, measurements: [] };
			toolViewports.set(key, state);
		}
		return state;
	};

	const disclosureState = (key: string) => {
		let state = disclosures.get(key);
		if (!state) {
			state = new Map<string, boolean>();
			disclosures.set(key, state);
		}
		return state;
	};
	const [focusedKey, setFocusedKey] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const headerRef = useRef<HTMLDivElement>(null);
	// Keep the history action outside the item list: a prepend must anchor the
	// first durable row even when the action is visible at scroll offset zero.
	const [headerHeight, setHeaderHeight] = useState(0);
	const headerAdjustment = useRef<{
		offset: number;
		atEnd: boolean;
		delta: number;
	} | null>(null);
	useLayoutEffect(() => {
		const element = headerRef.current;
		if (!element) return;
		let measuredHeight = 0;
		const measure = () => {
			// Hidden panes have no usable layout; retain their last visible geometry.
			if (!scrollRef.current?.offsetHeight) return;
			const height = element.getBoundingClientRect().height;
			if (height === measuredHeight) return;
			headerAdjustment.current = {
				offset: scrollRef.current?.scrollTop ?? 0,
				atEnd: isAtDomEnd(
					scrollRef.current,
					virtualizer.options.scrollEndThreshold,
				),
				delta: height - measuredHeight,
			};
			measuredHeight = height;
			setHeaderHeight(height);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const persistentIndexes = items.flatMap((item, index) =>
		item.keepMounted ? [index] : [],
	);
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: items.length,
		// Ref measurements can run in React's layout phase.
		useFlushSync: false,
		getScrollElement: () => scrollRef.current,
		getItemKey: (index) => items[index]!.key,
		measureElement: (element, entry, instance) => {
			if (!instance.scrollElement?.offsetHeight) {
				const index = instance.indexFromElement(element);
				return (
					instance.itemSizeCache.get(instance.options.getItemKey(index)) ??
					instance.options.estimateSize(index)
				);
			}
			return measureElement(element, entry, instance);
		},
		estimateSize: () => 96,
		overscan: 6,
		rangeExtractor: (range) => {
			const visible = defaultRangeExtractor(range);
			const focused =
				focusedKey === null
					? -1
					: items.findIndex((item) => item.key === focusedKey);
			if (focused >= 0) visible.push(focused);
			return [...new Set([...visible, ...persistentIndexes])].sort(
				(a, b) => a - b,
			);
		},
		paddingStart: 10 + headerHeight,
		anchorTo: "end",
		followOnAppend: true,
		scrollEndThreshold: 70,
		observeElementRect: observeChatViewport,
		observeElementOffset: (instance, callback) =>
			observeElementOffset(instance, (offset, scrolling) => {
				// display:none can report zero without changing the saved native offset.
				const visible = Boolean(instance.scrollElement?.offsetHeight);
				callback(
					visible ? offset : (instance.scrollOffset ?? 0),
					visible && scrolling,
				);
			}),
	});
	useEffect(() => {
		const retained = new Set(items.map((item) => item.key));
		for (const key of disclosures.keys()) {
			if (!retained.has(key)) disclosures.delete(key);
		}
		for (const key of toolViewports.keys()) {
			if (!retained.has(key)) toolViewports.delete(key);
		}
		// Tail trimming must release geometry as well as disclosure state.
		for (const key of virtualizer.itemSizeCache.keys()) {
			if (!retained.has(String(key))) virtualizer.itemSizeCache.delete(key);
		}
	}, [items, disclosures, toolViewports, virtualizer]);

	useLayoutEffect(() => {
		const adjustment = headerAdjustment.current;
		headerAdjustment.current = null;
		if (!adjustment) return;
		if (
			adjustment.atEnd ||
			isAtDomEnd(scrollRef.current, virtualizer.options.scrollEndThreshold)
		) {
			elementScroll(
				Math.max(
					0,
					virtualizer.getTotalSize() - (virtualizer.scrollRect?.height ?? 0),
				),
				{},
				virtualizer,
			);
		} else if (adjustment.offset > 0) {
			virtualizer.scrollToOffset(
				Math.max(
					0,
					(scrollRef.current?.scrollTop ?? adjustment.offset) +
						adjustment.delta,
				),
			);
		}
	}, [headerHeight, virtualizer]);

	return (
		<div
			data-selectable
			role="log"
			aria-label={t("agents.chat.transcript")}
			aria-relevant="additions"
			className="min-h-0 flex-1"
		>
			<div
				ref={scrollRef}
				className="h-full overflow-y-auto [overflow-anchor:none]"
			>
				<div
					className="relative mx-auto w-full max-w-3xl"
					style={{ height: virtualizer.getTotalSize() }}
				>
					<div
						ref={headerRef}
						className="absolute top-2.5 left-0 w-full px-2.5 @2xl/chat:px-4"
					>
						{header}
					</div>
					{virtualizer.getVirtualItems().map((item) => (
						<div
							key={item.key}
							ref={virtualizer.measureElement}
							data-index={item.index}
							className="absolute top-0 left-0 w-full px-2.5 @2xl/chat:px-4"
							onFocusCapture={() => setFocusedKey(items[item.index]!.key)}
							onBlurCapture={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget))
									setFocusedKey(null);
							}}
							style={{
								transform: `translateY(${item.start}px)`,
								// Include the end inset in measured content so native scroll
								// bounds grow with an append before the sizer commits.
								paddingBottom: item.index === items.length - 1 ? 10 : 0,
							}}
						>
							<ChatDisclosureState
								value={disclosureState(items[item.index]!.key)}
							>
								<ChatToolBurstViewportState
									value={toolViewport(items[item.index]!.key)}
								>
									{items[item.index]!.content}
								</ChatToolBurstViewportState>
							</ChatDisclosureState>
						</div>
					))}
				</div>
			</div>
			<div className="pointer-events-none flex h-0 items-end justify-center">
				<div className="-translate-y-2">
					<ScrollToLatestButton
						visible={!virtualizer.isAtEnd()}
						label={t("agents.chat.scrollToLatest")}
						onClick={() => virtualizer.scrollToEnd()}
					/>
				</div>
			</div>
		</div>
	);
}

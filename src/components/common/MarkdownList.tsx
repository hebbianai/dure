import {
	defaultRangeExtractor,
	elementScroll,
	measureElement,
	useVirtualizer,
} from "@tanstack/react-virtual";
import {
	Children,
	type ComponentProps,
	type ComponentPropsWithoutRef,
	cloneElement,
	isValidElement,
	type ReactElement,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

type ListProps = ComponentPropsWithoutRef<"ol"> & { ordered?: boolean };
type ItemProps = ComponentProps<"li"> & { "data-index"?: number };
type Item = ReactElement<ItemProps>;

/** Keep Markdown's parsed list items intact: references, nested blocks and GFM
 * tasks still use the same safe renderer. Only mounting is windowed. */
export function MarkdownList({
	children,
	ordered = false,
	...props
}: ListProps) {
	const items = useMemo(
		() =>
			Children.toArray(children).filter((child): child is Item =>
				isValidElement(child),
			),
		[children],
	);
	return <WindowedList {...props} ordered={ordered} items={items} />;
}

function WindowedList({
	items,
	ordered,
	start = 1,
	style,
	...props
}: Omit<ListProps, "children"> & { items: Item[] }) {
	const bounded = items.length > 64;
	const ref = useRef<HTMLOListElement & HTMLUListElement>(null);
	const [viewport, setViewport] = useState<HTMLElement | null>(null);
	const [margin, setMargin] = useState(0);
	const [metrics, setMetrics] = useState({ line: 24, gap: 4, indent: 22 });
	const [focused, setFocused] = useState<number | null>(null);
	useLayoutEffect(() => {
		if (!bounded) return;
		const list = ref.current;
		const win = list?.ownerDocument.defaultView;
		if (!list || !win) return;
		let parent = list.parentElement;
		while (
			parent &&
			!/(auto|scroll)/.test(win.getComputedStyle(parent).overflowY)
		)
			parent = parent.parentElement;
		setViewport(parent ?? list.ownerDocument.documentElement);
		const css = win.getComputedStyle(list);
		setMetrics({
			line: Number.parseFloat(css.lineHeight) || 24,
			gap: Number.parseFloat(css.fontSize) * 0.3 || 4,
			indent: Number.parseFloat(css.paddingLeft) || 22,
		});
	}, [bounded]);
	const position = () => {
		if (!viewport || !ref.current) return 0;
		const top =
			viewport === viewport.ownerDocument.documentElement
				? 0
				: viewport.getBoundingClientRect().top;
		return ref.current.getBoundingClientRect().top - top + viewport.scrollTop;
	};
	useLayoutEffect(() => {
		if (viewport?.offsetHeight) setMargin(position());
	});
	const virtualizer = useVirtualizer<HTMLElement, HTMLLIElement>({
		count: items.length,
		enabled: bounded,
		initialRect: { width: 0, height: 1 },
		getScrollElement: () => viewport,
		getItemKey: (index) => items[index]!.key ?? index,
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
		estimateSize: () => metrics.line,
		gap: metrics.gap,
		scrollMargin: margin,
		overscan: 8,
		useFlushSync: false,
		rangeExtractor: (range) => {
			const indexes = defaultRangeExtractor(range);
			if (
				focused !== null &&
				focused < items.length &&
				!indexes.includes(focused)
			)
				indexes.push(focused);
			return indexes.sort((a, b) => a - b);
		},
		observeElementRect: (instance, callback) => {
			const element = instance.scrollElement;
			const win = element?.ownerDocument.defaultView;
			if (!element || !win) return;
			const measure = () => {
				const root = element === element.ownerDocument.documentElement;
				const height = root ? win.innerHeight : element.clientHeight;
				if (height === 0) return;
				setMargin(position());
				callback({
					width: root ? win.innerWidth : element.clientWidth,
					height,
				});
			};
			measure();
			const observer = new win.ResizeObserver(measure);
			observer.observe(element);
			win.addEventListener("resize", measure);
			return () => {
				observer.disconnect();
				win.removeEventListener("resize", measure);
			};
		},
		observeElementOffset: (instance, callback) => {
			const element = instance.scrollElement;
			const win = element?.ownerDocument.defaultView;
			if (!element || !win) return;
			const target =
				element === element.ownerDocument.documentElement ? win : element;
			const update = () => {
				if (!element.offsetHeight) return;
				setMargin(position());
				callback(element.scrollTop, false);
			};
			update();
			target.addEventListener("scroll", update, { passive: true });
			return () => target.removeEventListener("scroll", update);
		},
		// Navigation and tail following stay with the enclosing scroll surface.
		// This list only requests compensation for size changes above its reader.
		scrollToFn: elementScroll,
	});
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
		item,
		_delta,
		instance,
	) => {
		const offset = instance.scrollOffset ?? 0;
		return (
			offset > margin &&
			offset < margin + instance.getTotalSize() &&
			!instance.isAtEnd(70) &&
			item.end <= offset
		);
	};
	const Tag = ordered ? "ol" : "ul";
	return (
		<Tag
			{...props}
			start={ordered ? start : undefined}
			ref={ref}
			style={
				bounded
					? {
							...style,
							position: "relative",
							height: virtualizer.getTotalSize(),
						}
					: style
			}
		>
			{(bounded
				? virtualizer.getVirtualItems()
				: items.map((item, index) => ({
						key: item.key ?? index,
						index,
						start: 0,
					}))
			).map((item) =>
				cloneElement(items[item.index]!, {
					key: item.key,
					ref: bounded ? virtualizer.measureElement : undefined,
					"data-index": item.index,
					"aria-posinset": item.index + 1,
					"aria-setsize": items.length,
					value: ordered ? start + item.index : undefined,
					onFocusCapture: () => setFocused(item.index),
					onBlurCapture: (event) => {
						if (!event.currentTarget.contains(event.relatedTarget))
							setFocused(null);
					},
					style: bounded
						? {
								...items[item.index]!.props.style,
								position: "absolute",
								top: 0,
								left: metrics.indent,
								right: 0,
								margin: 0,
								transform: `translateY(${item.start - margin}px)`,
							}
						: items[item.index]!.props.style,
				}),
			)}
		</Tag>
	);
}

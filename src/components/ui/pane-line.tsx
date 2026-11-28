import {
	type ComponentProps,
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	DISCLOSURE_INDENT,
	Disclosure,
	type DisclosureOpenState,
} from "@/components/ui/disclosure";
import { rowSnappedHeight } from "@/lib/ui/rowSnappedHeight";
import { cn } from "@/lib/utils";

/** One line of a pane under a hairline, at the pane's 12px inset: the box
 * every part below a pane's content stands in. PaneLabel names a part on
 * it, FoldLine folds one to it, and the goal bar holds its controls on it. */
export function PaneLine({
	as: Tag = "section",
	className,
	...props
}: Omit<ComponentProps<"section">, "ref"> & { as?: "section" | "h3" }) {
	return (
		<Tag
			className={cn(
				"shrink-0 border-t border-glass-hairline px-3 py-1.5 text-xs",
				className,
			)}
			{...props}
		/>
	);
}

/** A part's name on its PaneLine, starting where a fold line's label starts
 * (the chevron sits in the gutter before it), so a pane's parts read as
 * parallel sections whether or not they fold. */
export function PaneLabel({
	children,
	...props
}: Omit<ComponentProps<"h3">, "ref">) {
	return (
		<PaneLine as="h3" className="text-muted-foreground" {...props}>
			<span className={cn("block truncate", DISCLOSURE_INDENT)}>
				{children}
			</span>
		</PaneLine>
	);
}

type FoldLineProps = Omit<ComponentProps<"section">, "ref" | "children"> &
	DisclosureOpenState & {
		/** Shown before the summary only when it means something. */
		dot?: ReactNode;
		summary: ReactNode;
		/** Merged over the rows' 12rem cap, e.g. a cap relative to the pane. */
		rowsClassName?: string;
		children: ReactNode;
	};

/** A part of a pane folded to its PaneLine: a dot and the words that sum the
 * part up, unfolding to its rows. The rows scroll under a cap that always
 * ends on a whole row, so the last one is never sliced by the line below. */
export function FoldLine(props: FoldLineProps) {
	const {
		dot,
		summary,
		rowsClassName,
		children,
		className,
		open: _open,
		defaultOpen: _defaultOpen,
		onOpenChange: _onOpenChange,
		...section
	} = props;
	const rows = useRef<HTMLDivElement>(null);
	const height = useRowSnappedHeight(rows);
	return (
		<PaneLine className={cn("text-muted-foreground", className)} {...section}>
			<Disclosure
				{...openStateOf(props)}
				label={
					<span className="inline-flex items-center gap-2 font-normal text-muted-foreground">
						{dot}
						{summary}
					</span>
				}
			>
				<div
					ref={rows}
					className={cn("max-h-48 overflow-y-auto", rowsClassName)}
					style={height === undefined ? undefined : { height }}
				>
					{children}
				</div>
			</Disclosure>
		</PaneLine>
	);
}

/** Just the fold's open state, from props that carry the section's too. */
function openStateOf(props: DisclosureOpenState): DisclosureOpenState {
	return props.open === undefined
		? { defaultOpen: props.defaultOpen, onOpenChange: props.onOpenChange }
		: { open: props.open, onOpenChange: props.onOpenChange };
}

/** The height that ends `scroller`'s capped rows on a row boundary: its
 * CSS max-height is the cap, and its first child's children are the rows.
 * It follows the rows, the scroller and the window, since a cap relative to
 * a container changes with the window without the scroller resizing. */
function useRowSnappedHeight(
	scroller: RefObject<HTMLElement | null>,
): number | undefined {
	const [height, setHeight] = useState<number>();
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		const observer = new ResizeObserver(() => measure());
		const measure = () => {
			const list = element.firstElementChild;
			// Rows mount when the fold opens; observing again is a no-op.
			if (list) observer.observe(list);
			const top = element.getBoundingClientRect().top - element.scrollTop;
			setHeight(
				rowSnappedHeight(
					Array.from(
						list?.children ?? [],
						(row) => row.getBoundingClientRect().bottom - top,
					),
					Number.parseFloat(getComputedStyle(element).maxHeight),
				),
			);
		};
		observer.observe(element);
		measure();
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [scroller]);
	return height;
}

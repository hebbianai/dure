import {
	memo,
	useEffect,
	useRef,
	useState,
	type ComponentPropsWithoutRef,
} from "react";
import { cn } from "@/lib/utils";

export const OVERFLOW_REVEAL_DELAY_MS = 700;

const MIN_OVERFLOW_PX = 1;
const MIN_REVEAL_DURATION_MS = 650;
const MAX_REVEAL_DURATION_MS = 3_000;
const REVEAL_DURATION_MS_PER_PX = 10;

function revealDurationMs(distancePx: number) {
	return Math.min(
		MAX_REVEAL_DURATION_MS,
		Math.max(MIN_REVEAL_DURATION_MS, distancePx * REVEAL_DURATION_MS_PER_PX),
	);
}

function reducedMotionRequested() {
	return (
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/** A one-line viewport that reveals genuine overflow after an intentional hover.
 * Movement is bounded to the exact clipped distance; fitting text never moves.
 * Children can highlight the same text without changing its reveal identity. */
export const OverflowRevealText = memo(function OverflowRevealText({
	text,
	children,
	className,
	contentClassName,
	onPointerEnter,
	onPointerLeave,
	...props
}: ComponentPropsWithoutRef<"span"> & {
	text: string;
	contentClassName?: string;
}) {
	const contentRef = useRef<HTMLSpanElement>(null);
	const revealTimerRef = useRef<number | null>(null);
	const [reveal, setReveal] = useState<{
		readonly text: string;
		readonly distancePx: number;
	} | null>(null);
	const activeDistance = reveal?.text === text ? reveal.distancePx : null;

	const cancelPendingReveal = () => {
		if (revealTimerRef.current === null) return;
		window.clearTimeout(revealTimerRef.current);
		revealTimerRef.current = null;
	};

	useEffect(
		() => () => {
			if (revealTimerRef.current !== null) {
				window.clearTimeout(revealTimerRef.current);
			}
		},
		[],
	);

	return (
		<span
			data-slot="overflow-reveal-text"
			className={cn(
				"block min-w-0 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%_-_16px),transparent)]",
				className,
			)}
			onPointerEnter={(event) => {
				onPointerEnter?.(event);
				if (event.defaultPrevented) return;
				if (event.pointerType === "touch" || reducedMotionRequested()) return;
				cancelPendingReveal();
				const content = contentRef.current;
				if (!content) return;
				const distancePx = Math.round(
					content.scrollWidth - event.currentTarget.clientWidth,
				);
				if (distancePx <= MIN_OVERFLOW_PX) return;
				revealTimerRef.current = window.setTimeout(() => {
					revealTimerRef.current = null;
					setReveal({ text, distancePx });
				}, OVERFLOW_REVEAL_DELAY_MS);
			}}
			onPointerLeave={(event) => {
				onPointerLeave?.(event);
				cancelPendingReveal();
				setReveal(null);
			}}
			{...props}
		>
			<span
				ref={contentRef}
				data-slot="overflow-reveal-text-content"
				className={cn(
					"inline-block min-w-full pr-4 whitespace-nowrap align-top transition-transform motion-reduce:transition-none",
					contentClassName,
				)}
				style={{
					transform:
						activeDistance === null
							? undefined
							: `translateX(-${activeDistance}px)`,
					transitionDuration:
						activeDistance === null
							? "160ms"
							: `${revealDurationMs(activeDistance)}ms`,
					transitionTimingFunction:
						activeDistance === null ? "ease-out" : "linear",
				}}
			>
				{children ?? text}
			</span>
		</span>
	);
});

import { useEffect, useRef } from "react";
import { ConfirmationButton } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** In-place confirmation row — the popup-free confirm idiom (owner decision
 * 2026-08-31, SOUL §6 "확인은 그 자리에서"): the row that triggered a
 * destructive action swaps itself for "question? · Cancel · Confirm" instead
 * of raising a modal or native confirm. The caller owns the confirming state
 * and renders this in place of the row's normal content.
 *
 * Escape cancels; the confirm button takes initial focus so Enter confirms
 * and Tab reaches Cancel. Reach for a dialog only when the effect spans
 * surfaces or needs additional choices (e.g. worktree deletion options). */
export function InlineConfirmRow({
	question,
	confirmLabel,
	cancelLabel,
	onConfirm,
	onCancel,
	busy = false,
	className,
}: {
	question: string;
	/** Names the exact result, e.g. "Remove" — never a bare "OK". */
	confirmLabel: string;
	cancelLabel?: string;
	onConfirm: () => void;
	onCancel: () => void;
	busy?: boolean;
	className?: string;
}) {
	const confirmRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		confirmRef.current?.focus();
	}, []);
	return (
		<div
			role="alertdialog"
			aria-label={question}
			className={cn(
				"flex min-w-0 items-center gap-2 rounded-md bg-glass-tint px-3 py-1.5",
				className,
			)}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onCancel();
				}
			}}
		>
			{/* 11px medium, wrapping to two lines: the question used to be 14px
			    semibold on one clipped line, which in a sidebar cut "Kill this
			    session? This cannot be undone." to "Kill this session? Thi…" and
			    outweighed the 13px rows around it (owner call 2026-09-14). */}
			<span className="line-clamp-2 min-w-0 flex-1 text-meta leading-[15px] font-medium text-foreground">
				{question}
			</span>
			<ConfirmationButton
				type="button"
				disabled={busy}
				onClick={onCancel}
				variant="glass"
				// xs and 11px: the sidebar\'s scale; the pill sat over the 13px rows
				// around it (owner call 2026-09-14).
				size="xs"
				className="text-meta"
			>
				{cancelLabel ?? t("common.cancel")}
			</ConfirmationButton>
			<ConfirmationButton
				ref={confirmRef}
				type="button"
				disabled={busy}
				onClick={onConfirm}
				variant="destructive"
				size="xs"
				className="text-meta"
			>
				{confirmLabel}
			</ConfirmationButton>
		</div>
	);
}

import { cloneElement, isValidElement, type ReactNode, useId } from "react";
import { ErrorText } from "@/components/ui/error-text";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Labeled form row — the shared `grid gap-1.5` column used by dialog and
 * panel forms: a ui/Label wired to the control, the control itself as
 * children, then optional helper and error paragraphs. Domain copy and
 * validation policy stay at the call site; this component owns only the
 * label wiring and the row rhythm.
 *
 * Single-child contract: when `htmlFor` is omitted and `children` is exactly
 * one React element, a generated id is cloned onto that element and the label
 * points at it. With multiple children (or a non-element child) the caller
 * must wire ids itself and pass `htmlFor` — the label is left unassociated
 * rather than pointing at a guess.
 */
export function FormField({
	label,
	htmlFor,
	description,
	error,
	className,
	children,
}: {
	label: ReactNode;
	/** Control id — omit to auto-generate and clone onto a single element child. */
	htmlFor?: string;
	/** Helper copy below the control. */
	description?: ReactNode;
	/** Validation copy below the control (rendered after description). */
	error?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const autoId = useId();
	let labelFor = htmlFor;
	let control = children;
	if (labelFor === undefined && isValidElement<{ id?: string }>(children)) {
		const existingId = children.props.id;
		labelFor = existingId ?? autoId;
		if (existingId === undefined) {
			control = cloneElement(children, { id: autoId });
		}
	}

	return (
		// 8px from the label to its control (Figma 17375:198691, spacing/2).
		<div className={cn("grid gap-2", className)}>
			<Label htmlFor={labelFor}>{label}</Label>
			{control}
			{description !== undefined && (
				<p className="text-[11px] text-muted-foreground">{description}</p>
			)}
			{error !== undefined && (
				<ErrorText className="text-[11px]">{error}</ErrorText>
			)}
		</div>
	);
}

import type * as React from "react";
import { cn } from "@/lib/utils";

/** Inline destructive error line — the unboxed counterpart of
 * `ui/alert`. Renders nothing when there is no
 * message, so call sites can pass `error` straight through without a
 * conditional. Always announces via role="alert": inline errors appear in
 * response to an action, exactly the assertive case. Default scale is the
 * 12px caption; density variants (text-sm, text-[11px], break-all) merge
 * through `className`. */
export function ErrorText({
	children,
	className,
	...rest
}: {
	children?: React.ReactNode;
	className?: string;
} & Omit<React.HTMLAttributes<HTMLParagraphElement>, "className">) {
	if (children === null || children === undefined || children === false) {
		return null;
	}
	return (
		<p
			role="alert"
			className={cn("text-xs text-destructive", className)}
			{...rest}
		>
			{children}
		</p>
	);
}

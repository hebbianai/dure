import { Check, Minus } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** 14px 체크박스 (Figma dure-UI 2443:82616) — 네이티브 input을 투명하게 덮어
 *  키보드·스크린리더 동작을 그대로 두고 상자만 디자인에 맞춘다. */
export function OnboardingImportCheckbox({
	checked,
	indeterminate = false,
	label,
	disabled = false,
	className,
	onChange,
}: {
	checked: boolean;
	indeterminate?: boolean;
	label: string;
	disabled?: boolean;
	className?: string;
	onChange: (checked: boolean) => void;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	// 부분 선택은 DOM 프로퍼티로만 표현된다 — 네이티브 체크박스에 aria-checked를
	// 덧씌우면 브라우저가 계산한 상태와 두 개의 진실이 생긴다.
	useEffect(() => {
		if (inputRef.current) inputRef.current.indeterminate = indeterminate && !checked;
	}, [indeterminate, checked]);
	const filled = checked || indeterminate;
	return (
		<span
			className={cn(
				"relative flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border shadow-xs transition-colors",
				filled
					? "border-primary bg-primary text-primary-foreground"
					: "border-input bg-input/30 text-transparent",
				disabled && "opacity-50",
				className,
			)}
		>
			<input
				ref={inputRef}
				type="checkbox"
				checked={checked}
				disabled={disabled}
				aria-label={label}
				className="absolute inset-0 cursor-pointer appearance-none rounded-[4px] outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed"
				onChange={(event) => onChange(event.currentTarget.checked)}
			/>
			{checked ? (
				<Check className="pointer-events-none size-3" strokeWidth={2.5} />
			) : indeterminate ? (
				<Minus className="pointer-events-none size-3" strokeWidth={2.5} />
			) : null}
		</span>
	);
}

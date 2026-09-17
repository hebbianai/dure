import { OnboardingImportCheckbox } from "@/components/onboarding/OnboardingImportCheckbox";
import { t } from "@/lib/i18n";
import type { OnboardingImportScope } from "@/lib/onboarding/onboardingImportSelection";
import { cn } from "@/lib/utils";

function ScopeTab({
	active,
	label,
	onSelect,
}: {
	active: boolean;
	label: string;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onSelect}
			className={cn(
				"flex h-7 items-center justify-center rounded-md px-2 py-1 text-[13px]/none font-medium transition-colors",
				active
					? "border border-input/0 bg-input/30 text-foreground shadow-sm"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</button>
	);
}

/** 목록 위 조작 줄 — 전체 선택 체크박스와 기간 범위 탭. */
export function OnboardingImportToolbar({
	selected,
	total,
	scope,
	disabled = false,
	onToggleAll,
	onScopeChange,
}: {
	selected: number;
	total: number;
	scope: OnboardingImportScope;
	disabled?: boolean;
	onToggleAll: (checked: boolean) => void;
	onScopeChange: (scope: OnboardingImportScope) => void;
}) {
	const allSelected = total > 0 && selected === total;
	return (
		<div className="flex w-full items-center justify-between pl-0.5">
			<label className="flex cursor-pointer items-center gap-2">
				<OnboardingImportCheckbox
					checked={allSelected}
					indeterminate={selected > 0 && !allSelected}
					disabled={disabled || total === 0}
					label={t("onboarding.import.toolbar.selectAll")}
					onChange={onToggleAll}
				/>
				<span className="text-[13px]/none text-foreground">
					{t("onboarding.import.toolbar.selectionSummary", { selected, total })}
				</span>
			</label>
			<div
				role="group"
				aria-label={t("onboarding.import.toolbar.rangeLabel")}
				className="flex w-fit items-center gap-0 rounded-[10px] bg-muted p-1"
			>
				<ScopeTab
					active={scope === "recent"}
					label={t("onboarding.import.toolbar.rangeRecent")}
					onSelect={() => onScopeChange("recent")}
				/>
				<ScopeTab
					active={scope === "all"}
					label={t("onboarding.import.toolbar.rangeAll")}
					onSelect={() => onScopeChange("all")}
				/>
			</div>
		</div>
	);
}

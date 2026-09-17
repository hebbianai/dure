import { useId } from "react";
import { DureLoader } from "@/components/ui/dure-loader";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
	onboardingImportActionEnabled,
	type OnboardingImportActionState,
} from "@/lib/onboarding/onboardingImportActionState";
import { cn } from "@/lib/utils";

function actionMessage(state: OnboardingImportActionState): string {
	if (state.kind === "applying") {
		return t("onboarding.import.apply.inProgressHint");
	}
	if (state.kind === "retry") {
		return t("onboarding.import.apply.incompleteHint");
	}
	if (state.kind === "ready") {
		return t("onboarding.import.apply.readyHint");
	}
	if (state.reason === "no_selection") {
		return t("common.selectSessionsToStart");
	}
	if (state.reason === "desktop_name_required") {
		return t("onboarding.import.apply.desktopNameRequired", {
			n: state.desktopNumber,
		});
	}
	return t("onboarding.import.apply.paneLimitExceeded", {
			name: state.desktopName,
			selected: state.selectedPaneCount,
			limit: state.desktopPaneLimit,
		});
}

/** 화면 하단에 고정되는 결정 바 (Figma dure-UI 2443:82640) — 왼쪽은 무엇이
 *  만들어질지 한 줄 요약, 오른쪽은 나가는 두 갈래. */
export function OnboardingImportActionBar({
	discoveredCount,
	desktopCount,
	paneCount,
	state,
	journalLocked,
	editError,
	actionBarTarget,
	onApply,
	onDiscardPlan,
	onStartWithoutSessions,
}: {
	discoveredCount: number;
	desktopCount: number;
	paneCount: number;
	state: OnboardingImportActionState;
	journalLocked: boolean;
	editError: string | null;
	actionBarTarget?: HTMLElement | null;
	onApply: () => void;
	onDiscardPlan: () => void;
	onStartWithoutSessions?: () => void;
}) {
	const actionStatusId = useId();
	const actionStatus = actionMessage(state);
	const showActionStatus = state.kind !== "ready";
	const actionEnabled = onboardingImportActionEnabled(state);

	return (
		<div
			data-onboarding-import-action-bar
			className={cn(
				"flex items-center justify-between gap-4",
				!actionBarTarget && "mt-3 border-t border-border pt-3",
			)}
		>
			<div className="min-w-0 pb-0.5 pr-1">
				<p className="truncate text-xs text-muted-foreground">
					{t("onboarding.import.apply.selectionSummary", {
						selected: paneCount,
						total: discoveredCount,
						desktops: desktopCount,
					})}
				</p>
				{showActionStatus && (
					<p
						id={actionStatusId}
						aria-live="polite"
						className={cn(
							"mt-0.5 text-[11px]",
							state.kind === "blocked"
								? "text-status-warn"
								: "text-muted-foreground",
						)}
					>
						{actionStatus}
					</p>
				)}
				{editError && (
					<p className="mt-0.5 text-[11px] text-status-warn">{editError}</p>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-3">
				{journalLocked && state.kind !== "applying" && (
					<Button
						size="lg"
						variant="ghost"
						className="h-10"
						onClick={onDiscardPlan}
					>
						{t("onboarding.import.apply.discardPlan")}
					</Button>
				)}
				{onStartWithoutSessions && (
					<Button
						size="lg"
						variant="ghost"
						className="h-10 rounded-md px-8"
						onClick={onStartWithoutSessions}
					>
						{t("onboarding.import.startFromFolder")}
					</Button>
				)}
				<Button
					size="lg"
					// QA 프로브가 잡는 고정 앵커 — 라벨은 선택 개수에 따라 바뀐다.
					data-onboarding-import-apply
					className="h-10 rounded-md px-8"
					disabled={!actionEnabled}
					onClick={onApply}
					title={actionStatus}
					aria-describedby={showActionStatus ? actionStatusId : undefined}
				>
					{state.kind === "applying" && (
						<DureLoader decorative />
					)}
					{state.kind === "applying"
						? t("onboarding.import.apply.inProgress")
						: state.kind === "retry"
							? t("onboarding.import.apply.retry")
							: t("onboarding.import.apply.startWithSessions", { n: paneCount })}
				</Button>
			</div>
		</div>
	);
}

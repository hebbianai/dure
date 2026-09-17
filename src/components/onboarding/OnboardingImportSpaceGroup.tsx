import { GripVertical, Pencil, Plus } from "lucide-react";
import { useId, useRef } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { Titled } from "@/components/ui/tooltip";
import { OnboardingImportCheckbox } from "@/components/onboarding/OnboardingImportCheckbox";
import { OnboardingImportLayoutPreview } from "@/components/onboarding/OnboardingImportLayoutPreview";
import { onboardingImportPaneTimeLabel } from "@/components/onboarding/onboardingImportPaneTimeLabel";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { t } from "@/lib/i18n";
import type {
	OnboardingImportDesktopDraft,
	OnboardingImportPaneDraft,
} from "@/lib/onboarding/onboardingImportDraft";
import {
	ONBOARDING_IMPORT_PANE_DRAG_TYPE,
	parseOnboardingImportPaneDrag,
	serializeOnboardingImportPaneDrag,
	type OnboardingImportPaneDragPayload,
} from "@/lib/onboarding/onboardingImportDrag";
import type { OnboardingImportPaneDirection } from "@/lib/onboarding/onboardingImportPaneOrder";
import { compactOnboardingImportCwd } from "@/lib/onboarding/onboardingImportPresentation";
import { cn } from "@/lib/utils";

/** 이 창에 들어가지 않은 세션 한 줄 — 눌러서 넣거나 다른 스페이스로 끌어 옮긴다. */
function OverflowRow({
	pane,
	desktopId,
	disabled,
	draggable,
	dragged,
	onAdd,
	onDragStart,
	onDragEnd,
}: {
	pane: OnboardingImportPaneDraft;
	desktopId: string;
	disabled: boolean;
	draggable: boolean;
	dragged: boolean;
	onAdd: () => void;
	onDragStart?: (payload: OnboardingImportPaneDragPayload) => void;
	onDragEnd?: () => void;
}) {
	return (
		<li
			data-import-pane-row
			data-import-pane-key={pane.key}
			data-import-location={pane.executionLocation}
			data-import-host-id={pane.hostId}
			data-selected="false"
			draggable={draggable && !disabled}
			className={cn("min-w-0", dragged && "opacity-45")}
			onDragStart={(event) => {
				if (!draggable || disabled) return;
				const payload: OnboardingImportPaneDragPayload = {
					schemaVersion: 1,
					paneKey: pane.key,
					fromDesktopId: desktopId,
				};
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(
					ONBOARDING_IMPORT_PANE_DRAG_TYPE,
					serializeOnboardingImportPaneDrag(payload.paneKey, payload.fromDesktopId),
				);
				onDragStart?.(payload);
			}}
			onDragEnd={() => onDragEnd?.()}
		>
			<button
				type="button"
				disabled={disabled}
				data-import-selected-toggle
				aria-label={t("onboarding.import.space.addPaneAria", { name: pane.title })}
				className={cn(
					"group/row relative flex h-9 w-full min-w-0 items-center gap-1.5 rounded-md bg-surface-sunken pl-1.5 pr-2 text-left",
					disabled && "opacity-60",
					!disabled &&
						(draggable
							? "cursor-grab active:cursor-grabbing"
							: "cursor-pointer"),
				)}
				onClick={onAdd}
			>
				{!disabled && (
					<span
						aria-hidden
						className="pointer-events-none absolute inset-0 rounded-md transition-colors group-hover/row:bg-glass-tint-hover"
					/>
				)}
				{/* 기본 상태의 24px 들여쓰기는 이 grip 자리다 — 호버에 나타나도
				    행이 밀리지 않는다(2443:83018). */}
				<span className="relative flex size-3 shrink-0 items-center justify-center">
					{draggable && !disabled && (
						<GripVertical className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100" />
					)}
				</span>
				<span className="relative flex min-w-0 flex-1 items-center gap-1">
					<ProviderGlyph provider={pane.provider} className="size-3 shrink-0" />
					<span className="min-w-0 flex-1 truncate text-[11px]/4 text-foreground">
						{pane.title}
					</span>
				</span>
				<Titled title={pane.cwd}>
					<span
						className="relative max-w-[40%] shrink-0 truncate text-[10px]/4 text-muted-foreground"
					>
						{compactOnboardingImportCwd(pane.cwd)}
					</span>
				</Titled>
				<span className="relative shrink-0 text-[10px]/4 text-muted-foreground">
					{onboardingImportPaneTimeLabel(pane.mtime)}
				</span>
				<Plus className="relative size-3 shrink-0 text-muted-foreground" />
			</button>
		</li>
	);
}

/** 스페이스 카드 하나 — 머리글(포함 여부·이름·개수), pane 배치, 남은 세션 목록. */
export function OnboardingImportSpaceGroup({
	desktop,
	visiblePanes,
	canReorderOrMove,
	overflowExpanded,
	draggedPaneKey,
	dropBeforePaneKey,
	isDropTarget,
	onToggleIncluded,
	onRename,
	onToggleOverflow,
	onSelectPane,
	onRemovePane,
	onDragStart,
	onDragEnd,
	onDropTargetChange,
	onMovePane,
	onNudgePane,
	onDropOnSpace,
	onSpaceDragOver,
	onSpaceDragLeave,
}: {
	desktop: OnboardingImportDesktopDraft;
	visiblePanes: readonly OnboardingImportPaneDraft[];
	canReorderOrMove: boolean;
	overflowExpanded: boolean;
	draggedPaneKey?: string | null;
	dropBeforePaneKey?: string | null;
	isDropTarget: boolean;
	onToggleIncluded: (included: boolean) => void;
	onRename: (name: string) => void;
	onToggleOverflow: () => void;
	onSelectPane: (paneKey: string) => void;
	onRemovePane: (paneKey: string) => void;
	onDragStart: (payload: OnboardingImportPaneDragPayload) => void;
	onDragEnd: () => void;
	onDropTargetChange: (paneKey: string | null) => void;
	onMovePane: (
		payload: OnboardingImportPaneDragPayload,
		beforePaneKey: string,
	) => void;
	onNudgePane: (paneKey: string, direction: OnboardingImportPaneDirection) => void;
	onDropOnSpace: (payload: OnboardingImportPaneDragPayload) => void;
	onSpaceDragOver: () => void;
	onSpaceDragLeave: () => void;
}) {
	const overflowListId = useId();
	const nameRef = useRef<HTMLInputElement | null>(null);
	const selectedPanes = visiblePanes.filter((pane) => pane.selected);
	const overflowPanes = visiblePanes.filter((pane) => !pane.selected);
	// 배치 그리드는 이 범위에서 보이는 선택분만 그린다 — 범위 밖 pane이 숨은 채로
	// 자리를 차지하면 카드가 화면과 다른 배치를 약속하게 된다.
	const scopedDesktop = { ...desktop, panes: visiblePanes };

	return (
		<section
			data-import-desktop-id={desktop.id}
			className={cn(
				"flex w-full flex-col overflow-clip rounded-[12px] transition-colors",
				// 받는 스페이스는 2px 링만으로 표시한다 — 배경까지 물들이면 그 안의
				// pane 색이 바뀌어 무엇이 들어갈 자리인지 되레 흐려진다(2443:82902).
				isDropTarget && "ring-2 ring-ring",
				!desktop.included && "opacity-55",
			)}
			onDragOver={(event) => {
				if (
					!Array.from(event.dataTransfer.types).includes(
						ONBOARDING_IMPORT_PANE_DRAG_TYPE,
					)
				) {
					return;
				}
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				onSpaceDragOver();
			}}
			onDragLeave={(event) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget.contains(next)) return;
				onSpaceDragLeave();
			}}
			onDrop={(event) => {
				const payload = parseOnboardingImportPaneDrag(
					event.dataTransfer.getData(ONBOARDING_IMPORT_PANE_DRAG_TYPE),
				);
				if (!payload || payload.fromDesktopId === desktop.id) return;
				event.preventDefault();
				onDropOnSpace(payload);
			}}
		>
			<div className="flex w-full items-center justify-between p-3">
				<div className="flex min-w-0 items-center gap-1.5">
					<OnboardingImportCheckbox
						checked={desktop.included}
						label={t("onboarding.import.space.include")}
						onChange={onToggleIncluded}
					/>
					<input
						ref={nameRef}
						value={desktop.name}
						aria-label={t("onboarding.import.space.desktopName")}
						disabled={!desktop.included}
						className="min-w-0 max-w-[280px] truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-[13px]/none font-medium text-foreground outline-none hover:border-border focus:border-border focus:bg-input/30 disabled:cursor-not-allowed"
						size={Math.max(desktop.name.length + 1, 8)}
						onChange={(event) => onRename(event.currentTarget.value)}
					/>
					<button
						type="button"
						aria-label={t("onboarding.import.space.rename")}
						disabled={!desktop.included}
						className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
						onClick={() => {
							nameRef.current?.focus();
							nameRef.current?.select();
						}}
					>
						<Pencil className="size-3" />
					</button>
				</div>
				<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
					{selectedPanes.length}/{visiblePanes.length}
				</span>
			</div>

			<OnboardingImportLayoutPreview
				desktop={scopedDesktop}
				disabled={!desktop.included}
				canReorderOrMove={canReorderOrMove && desktop.included}
				draggedPaneKey={draggedPaneKey}
				dropBeforePaneKey={dropBeforePaneKey}
				onDragStart={onDragStart}
				onDragEnd={onDragEnd}
				onDropTargetChange={onDropTargetChange}
				onMovePane={onMovePane}
				onNudgePane={onNudgePane}
				onRemovePane={onRemovePane}
			/>

			{overflowPanes.length > 0 && (
				<div className="flex w-full flex-col">
					<div className="flex w-full flex-col p-3">
						<button
							type="button"
							aria-expanded={overflowExpanded}
							aria-controls={overflowListId}
							data-import-overflow-toggle
							className="flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
							onClick={onToggleOverflow}
						>
							{t("onboarding.import.space.leftOutSummary", {
								n: overflowPanes.length,
							})}
							{/* text-current keeps the chevron on the button's hover color. */}
							<DisclosureChevron
								open={overflowExpanded}
								orientation="down-up"
								className="text-current"
							/>
						</button>
					</div>
					{overflowExpanded && (
						<ul id={overflowListId} className="flex w-full flex-col gap-1 px-2 pb-1">
							{overflowPanes.map((pane) => (
								<OverflowRow
									key={pane.key}
									pane={pane}
									desktopId={desktop.id}
									disabled={!desktop.included}
									draggable={canReorderOrMove}
									dragged={draggedPaneKey === pane.key}
									onAdd={() => onSelectPane(pane.key)}
									onDragStart={onDragStart}
									onDragEnd={onDragEnd}
								/>
							))}
						</ul>
					)}
				</div>
			)}
		</section>
	);
}

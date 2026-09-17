import { GripVertical, Server, X } from "lucide-react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { Titled } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import {
	onboardingImportLayoutPlan,
	type OnboardingImportDesktopDraft,
} from "@/lib/onboarding/onboardingImportDraft";
import {
	ONBOARDING_IMPORT_PANE_DRAG_TYPE,
	parseOnboardingImportPaneDrag,
	serializeOnboardingImportPaneDrag,
	type OnboardingImportPaneDragPayload,
} from "@/lib/onboarding/onboardingImportDrag";
import type { OnboardingImportPaneDirection } from "@/lib/onboarding/onboardingImportPaneOrder";
import { onboardingImportPaneTimeLabel } from "@/components/onboarding/onboardingImportPaneTimeLabel";
import { compactOnboardingImportCwd } from "@/lib/onboarding/onboardingImportPresentation";
import { cn } from "@/lib/utils";

/** 스페이스가 실제로 열릴 pane 배치 — 미리보기가 아니라 편집 표면이다.
 *  카드를 끌어 순서·스페이스를 바꾸고, X로 이 창에서 빼낸다. */
export function OnboardingImportLayoutPreview({
	desktop,
	canReorderOrMove = false,
	draggedPaneKey,
	dropBeforePaneKey,
	onDragStart,
	onDragEnd,
	onDropTargetChange,
	onMovePane,
	onNudgePane,
	onRemovePane,
	disabled = false,
}: {
	desktop: OnboardingImportDesktopDraft;
	canReorderOrMove?: boolean;
	disabled?: boolean;
	draggedPaneKey?: string | null;
	dropBeforePaneKey?: string | null;
	onDragStart?: (payload: OnboardingImportPaneDragPayload) => void;
	onDragEnd?: () => void;
	onDropTargetChange?: (paneKey: string | null) => void;
	onMovePane?: (
		payload: OnboardingImportPaneDragPayload,
		beforePaneKey: string,
	) => void;
	onNudgePane?: (
		paneKey: string,
		direction: OnboardingImportPaneDirection,
	) => void;
	onRemovePane?: (paneKey: string) => void;
}) {
	const plan = onboardingImportLayoutPlan(desktop);
	const panes = new Map(desktop.panes.map((pane) => [pane.key, pane]));

	if (plan.cells.length === 0) {
		return (
			<div className="px-2">
				<p className="flex h-[52px] items-center justify-center border border-dashed border-border text-[11px] text-muted-foreground">
					{t("onboarding.import.space.empty")}
				</p>
			</div>
		);
	}

	return (
		<div className="px-2">
			<ul
				className="grid w-full gap-[2px] bg-glass-sheet py-px"
				style={{
					gridTemplateColumns: `repeat(${plan.columns}, minmax(0, 1fr))`,
					gridTemplateRows: `repeat(${plan.rows}, 52px)`,
				}}
			>
				{plan.cells.map((cell, index) => {
					const pane = panes.get(cell.paneKey);
					if (!pane) return null;
					const dropTarget = dropBeforePaneKey === cell.paneKey;
					// 끌고 있는 카드의 원래 자리는 비운다 — 카드가 들려 나간 것이
					// 보여야 어디로 되돌아갈지 알 수 있다(2443:82902).
					const lifted = draggedPaneKey === cell.paneKey;
					return (
						<Titled key={cell.paneKey} title={`${index + 1}. ${pane.title}`}>
							<li
								data-layout-cell
								data-layout-pane-key={cell.paneKey}
								data-layout-drop-target={dropTarget ? "true" : "false"}
								// pane 정체는 배치와 무관하게 읽혀야 한다 — 선택된 pane은
								// 여기, 빠진 pane은 목록 행에 같은 이름으로 실린다.
								data-import-pane-key={cell.paneKey}
								data-import-location={pane.executionLocation}
								data-import-host-id={pane.hostId}
								data-selected="true"
								aria-label={t("onboarding.import.space.paneReorderAria", {
									n: index + 1,
									name: pane.title,
								})}
								aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
								tabIndex={canReorderOrMove ? 0 : -1}
								draggable={canReorderOrMove}
								className={cn(
									"group/card relative flex min-w-0 flex-col transition-colors outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-ring",
									lifted
										? "items-center justify-center border border-border"
										: "justify-center bg-glass-pane py-2 pl-1.5 pr-2",
									canReorderOrMove && "cursor-grab active:cursor-grabbing",
									dropTarget && "ring-2 ring-ring",
								)}
								style={{
									gridColumn: `${cell.column} / span ${cell.columnSpan}`,
									gridRow: `${cell.row} / span ${cell.rowSpan}`,
								}}
								onDragStart={(event) => {
									if (!canReorderOrMove) return;
									const payload: OnboardingImportPaneDragPayload = {
										schemaVersion: 1,
										paneKey: cell.paneKey,
										fromDesktopId: desktop.id,
									};
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData(
										ONBOARDING_IMPORT_PANE_DRAG_TYPE,
										serializeOnboardingImportPaneDrag(
											payload.paneKey,
											payload.fromDesktopId,
										),
									);
									event.dataTransfer.setDragImage(
										event.currentTarget,
										Math.max(12, event.currentTarget.offsetWidth - 12),
										12,
									);
									onDragStart?.(payload);
								}}
								onDragOver={(event) => {
									if (
										draggedPaneKey === cell.paneKey ||
										!Array.from(event.dataTransfer.types).includes(
											ONBOARDING_IMPORT_PANE_DRAG_TYPE,
										)
									) {
										return;
									}
									event.preventDefault();
									event.stopPropagation();
									event.dataTransfer.dropEffect = "move";
									onDropTargetChange?.(cell.paneKey);
								}}
								onDragLeave={(event) => {
									const next = event.relatedTarget;
									if (next instanceof Node && event.currentTarget.contains(next)) return;
									if (dropTarget) onDropTargetChange?.(null);
								}}
								onDrop={(event) => {
									const payload = parseOnboardingImportPaneDrag(
										event.dataTransfer.getData(ONBOARDING_IMPORT_PANE_DRAG_TYPE),
									);
									if (!payload || payload.paneKey === cell.paneKey) return;
									event.preventDefault();
									event.stopPropagation();
									onDropTargetChange?.(null);
									onMovePane?.(payload, cell.paneKey);
								}}
								onDragEnd={() => {
									onDropTargetChange?.(null);
									onDragEnd?.();
								}}
								onKeyDown={(event) => {
									const direction =
										event.key === "ArrowLeft" || event.key === "ArrowUp"
											? "previous"
											: event.key === "ArrowRight" || event.key === "ArrowDown"
												? "next"
												: undefined;
									if (!direction) return;
									event.preventDefault();
									onNudgePane?.(cell.paneKey, direction);
								}}
							>
								{lifted ? (
									<span className="text-[10px]/4 text-muted-foreground">
										{index + 1}
									</span>
								) : (
								<>
								{/* 호버 틴트는 pane 색 위에 덧입히는 층이다 — 배경을 바꿔치기하면
								    뒤의 sheet 색이 비쳐 카드가 오히려 밝아진다. */}
								<span
									aria-hidden
									className="pointer-events-none absolute inset-0 transition-colors group-hover/card:bg-glass-tint-hover"
								/>
								<div className="relative flex min-w-0 flex-col gap-1 pl-0.5">
									<div className="flex min-w-0 items-start gap-1">
										<div className="flex min-w-0 flex-1 items-center gap-1.5">
											{/* 순번 자리에 호버하면 grip이 들어선다 — 12px 폭이 같아
											    글자가 밀리지 않는다(2443:83018). */}
											<span className="flex w-3 shrink-0 items-center justify-center">
												<span
													className={cn(
														"font-mono text-[11px] tabular-nums text-muted-foreground",
														canReorderOrMove && "group-hover/card:hidden",
													)}
												>
													{index + 1}
												</span>
												{canReorderOrMove && (
													<GripVertical className="hidden size-3 text-muted-foreground group-hover/card:block" />
												)}
											</span>
											<span className="min-w-0 flex-1 truncate text-[13px]/4 text-foreground">
												{pane.title}
											</span>
										</div>
										<button
											type="button"
											disabled={disabled}
											data-import-selected-toggle
											aria-label={t("onboarding.import.space.removePaneAria", {
												name: pane.title,
											})}
											className="-mr-0.5 mt-px shrink-0 p-px text-muted-foreground opacity-35 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:hover:opacity-35"
											onClick={() => onRemovePane?.(cell.paneKey)}
										>
											<X className="size-3" />
										</button>
									</div>
									<div className="flex min-w-0 items-center gap-2 pl-4">
										<div className="flex min-w-0 flex-1 items-center gap-1">
											<ProviderGlyph
												provider={pane.provider}
												className="size-3 shrink-0"
											/>
											{pane.executionLocation === "ssh" && (
												<Titled title={pane.hostId ?? t("onboarding.import.discovery.unknownHost")}>
													<span
														className="flex shrink-0 items-center gap-0.5 text-[10px]/4 text-muted-foreground"
													>
														<Server className="size-2.5" />
														{pane.hostId ?? t("onboarding.import.discovery.unknownHost")}
													</span>
												</Titled>
											)}
											<Titled title={pane.cwd}>
												<span
													className="min-w-0 flex-1 truncate text-[10px]/4 text-muted-foreground"
												>
													{compactOnboardingImportCwd(pane.cwd)}
												</span>
											</Titled>
										</div>
										<span className="shrink-0 text-[10px]/4 text-muted-foreground">
											{onboardingImportPaneTimeLabel(pane.mtime)}
										</span>
									</div>
								</div>
								</>
								)}
							</li>
						</Titled>
					);
				})}
			</ul>
		</div>
	);
}

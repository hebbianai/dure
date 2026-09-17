import { Plus, RefreshCw } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { OnboardingImportActionBar } from "@/components/onboarding/OnboardingImportActionBar";
import {
	OnboardingImportDiscoveryProgress,
	OnboardingImportDiscoverySources,
} from "@/components/onboarding/OnboardingImportDiscoveryProgress";
import { AgentLaunchPreferences } from "@/components/settings/AgentLaunchPreferences";
import { OnboardingHero } from "@/components/onboarding/OnboardingHero";
import { OnboardingImportSpaceGroup } from "@/components/onboarding/OnboardingImportSpaceGroup";
import { OnboardingImportToolbar } from "@/components/onboarding/OnboardingImportToolbar";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { useOnboardingImportDiscovery } from "@/components/onboarding/useOnboardingImportDiscovery";
import { t } from "@/lib/i18n";
import { applyOnboardingImportDraft } from "@/lib/onboarding/onboardingImportApply";
import {
	onboardingImportActionEnabled,
	onboardingImportActionState,
	type OnboardingImportApplyState,
} from "@/lib/onboarding/onboardingImportActionState";
import {
	addOnboardingImportDesktop,
	moveOnboardingImportPane,
	ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
	type OnboardingImportDraftMutation,
	onboardingImportCounts,
	renameOnboardingImportDesktop,
	setOnboardingImportDesktopIncluded,
	setOnboardingImportPaneSelected,
} from "@/lib/onboarding/onboardingImportDraft";
import {
	discardOnboardingImportJournal,
	MAX_RECOVERABLE_ONBOARDING_DESKTOP_PANES,
} from "@/lib/onboarding/onboardingImportJournal";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { nudgeOnboardingImportPane } from "@/lib/onboarding/onboardingImportPaneOrder";
import {
	narrowOnboardingImportScope,
	type OnboardingImportScope,
	onboardingImportScopePanes,
	onboardingImportScopeSelectionCount,
	setAllOnboardingImportDesktopsIncluded,
	setOnboardingImportScopeSelected,
} from "@/lib/onboarding/onboardingImportSelection";
import { cn } from "@/lib/utils";

function mutationMessage(error: OnboardingImportDraftMutation["error"]): string {
	if (error === "desktop_pane_limit") {
		return t("onboarding.import.paneLimitNotice", {
			n: ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
		});
	}
	return t("onboarding.import.draftUpdateFailed");
}

/** 가운데 정렬 본문 폭은 Figma dure-UI 2443:82616 기준(max 896px). */
function ImportShell({ children }: { children: React.ReactNode }) {
	return (
		<section className="flex items-start justify-center px-6 pb-8 pt-10">
			<div className="flex w-full min-w-0 max-w-[896px] flex-col gap-3">
				{children}
			</div>
		</section>
	);
}

export function OnboardingImportPreview({
	onAvailabilityChange,
	actionBarTarget,
	onStartWithoutSessions,
}: {
	onAvailabilityChange?: (available: boolean | undefined) => void;
	actionBarTarget?: HTMLElement | null;
	onStartWithoutSessions?: () => void;
}) {
	const [reload, setReload] = useState(0);
	const [scope, setScope] = useState<OnboardingImportScope>("recent");
	const { scan, journalLocked, lockJournal, unlockJournal, updateDraft } =
		useOnboardingImportDiscovery(reload, scope);
	const [editError, setEditError] = useState<string | null>(null);
	const [draggedPane, setDraggedPane] = useState<{
		paneKey: string;
		fromDesktopId: string;
	} | null>(null);
	const [dropDesktopId, setDropDesktopId] = useState<string | null>(null);
	const [dropBeforePaneKey, setDropBeforePaneKey] = useState<string | null>(null);
	const [applyState, setApplyState] =
		useState<OnboardingImportApplyState>("idle");
	const [expandedOverflowIds, setExpandedOverflowIds] = useState<
		ReadonlySet<string>
	>(() => new Set());

	useEffect(() => {
		setExpandedOverflowIds(new Set());
		setEditError(null);
		setDraggedPane(null);
		setDropDesktopId(null);
		setDropBeforePaneKey(null);
	}, [reload]);

	const draft = scan.kind === "ready" ? scan.draft : undefined;
	const actionState = draft
		? onboardingImportActionState({
				draft,
				journalLocked,
				applyState,
				desktopPaneLimit: journalLocked
					? MAX_RECOVERABLE_ONBOARDING_DESKTOP_PANES
					: undefined,
			})
		: undefined;
	const draftReady = actionState
		? onboardingImportActionEnabled(actionState)
		: false;
	const counts = useMemo(
		() => (draft ? onboardingImportCounts(draft) : undefined),
		[draft],
	);
	const scopeCount = useMemo(
		() =>
			draft
				? onboardingImportScopeSelectionCount(draft, scope)
				: { total: 0, selected: 0 },
		[draft, scope],
	);
	const canReorderOrMove =
		(draft?.desktops.reduce((total, desktop) => total + desktop.panes.length, 0) ??
			0) > 1;
	useEffect(() => {
		onAvailabilityChange?.(
			scan.kind === "scanning"
				? undefined
				: scan.kind === "ready"
					? scan.draft.discoveredCount > 0
					: false,
		);
	}, [onAvailabilityChange, scan]);

	/** 적용됐으면 true — 실패한 변경에 딸린 후속 UI 반응을 막는 데 쓴다. */
	const applyMutation = (mutation: OnboardingImportDraftMutation): boolean => {
		if (journalLocked) {
			setEditError(t("onboarding.import.apply.lockedAfterBegin"));
			return false;
		}
		if (mutation.error) {
			setEditError(mutationMessage(mutation.error));
			return false;
		}
		setEditError(null);
		updateDraft(mutation.draft);
		return true;
	};

	const revealOverflow = (desktopId: string) => {
		setExpandedOverflowIds((current) => {
			if (current.has(desktopId)) return current;
			return new Set(current).add(desktopId);
		});
	};

	// View and selection move together: expanding selects newly visible panes,
	// while narrowing clears hidden ones so the preview matches the result.
	const changeScope = (next: OnboardingImportScope) => {
		setScope(next);
		if (!draft || journalLocked) return;
		if (next === "recent") {
			updateDraft(narrowOnboardingImportScope(draft, next));
			return;
		}
		applyMutation(setOnboardingImportScopeSelected(draft, next, true));
	};

	const applyDraft = () => {
		const readyDraft = draft;
		if (!readyDraft || !draftReady || applyState === "applying") {
			return;
		}
		setApplyState("applying");
		lockJournal();
		setEditError(null);
		void applyOnboardingImportDraft(readyDraft)
			.catch((error) => {
				setApplyState("failed");
				setEditError(t("onboarding.import.apply.failed", { error: String(error) }));
			});
	};

	// 잠금 탈출구 — 적용이 실패한 채 저널이 남으면(재시작 후 포함) 화면 전체가
	// 영구 편집 불가가 된다. 명시적 확인을 받고 계획을 버려 처음부터 다시
	// 검색한다. 부분 실행으로 이미 만들어진 항목은 남는다(일반 경로로 정리).
	const discardPlan = async () => {
		const ok = await confirmDialog(
			t("onboarding.import.apply.discardConfirm"),
			{ title: t("onboarding.import.apply.restartTitle"), kind: "warning" },
		);
		if (!ok) return;
		discardOnboardingImportJournal();
		unlockJournal();
		setApplyState("idle");
		setEditError(null);
		setReload((value) => value + 1);
	};

	const toggleOverflowExpanded = (desktopId: string) => {
		setExpandedOverflowIds((current) => {
			const next = new Set(current);
			if (next.has(desktopId)) {
				next.delete(desktopId);
			} else {
				next.add(desktopId);
			}
			return next;
		});
	};

	if (scan.kind === "scanning") {
		return (
			<ImportShell>
				<OnboardingHero
					title={t("onboarding.import.title")}
					description={t("onboarding.import.description")}
					paneLimit={ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT}
				/>
				<AgentLaunchPreferences className="py-6" disabled={journalLocked} />
				<div className="rounded-md border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
					{scan.sources.length > 0 ? (
						<OnboardingImportDiscoveryProgress
							sources={scan.sources}
							complete={false}
						/>
					) : (
						<div className="flex items-center gap-2">
							<DureLoader decorative />
							{t("onboarding.import.discovery.looking")}
						</div>
					)}
				</div>
			</ImportShell>
		);
	}

	if (scan.kind === "failed") {
		return (
			<ImportShell>
				<OnboardingHero
					title={t("onboarding.import.title")}
					description={t("onboarding.import.description")}
					paneLimit={ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT}
				/>
				<AgentLaunchPreferences className="py-6" disabled={journalLocked} />
				<Alert
					tone="warn"
					role="status"
					title={t("onboarding.import.discovery.failedTitle")}
				>
					<p>
						{t("onboarding.import.discovery.failedHint")}
					</p>
					<OnboardingImportDiscoverySources
						sources={scan.sources.filter((source) => source.status === "failed")}
					/>
					<Button
						size="sm"
						variant="outline"
						className="mt-2"
						onClick={() => setReload((value) => value + 1)}
						disabled={journalLocked}
					>
						<RefreshCw className="size-3.5" />
						{t("onboarding.import.discovery.retry")}
					</Button>
				</Alert>
			</ImportShell>
		);
	}

	if (!draft || draft.discoveredCount === 0) {
		return scan.sources.some((source) => source.status === "failed") ||
			scan.sources.some((source) => source.status === "pending") ? (
			<ImportShell>
				<OnboardingImportDiscoveryProgress
					sources={scan.sources}
					complete={scan.complete}
				/>
			</ImportShell>
		) : null;
	}
	if (!actionState) return null;
	const actionBar = (
		<OnboardingImportActionBar
			discoveredCount={draft.discoveredCount}
			desktopCount={counts?.desktopCount ?? 0}
			paneCount={counts?.paneCount ?? 0}
			state={actionState}
			journalLocked={journalLocked}
			editError={editError}
			actionBarTarget={actionBarTarget}
			onApply={applyDraft}
			onDiscardPlan={() => void discardPlan()}
			onStartWithoutSessions={onStartWithoutSessions}
		/>
	);

	return (
		<ImportShell>
			<OnboardingHero
					title={t("onboarding.import.title")}
					description={t("onboarding.import.description")}
					paneLimit={ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT}
				/>
			<AgentLaunchPreferences className="py-6" disabled={journalLocked} />
			<div className="flex items-center gap-3">
				<OnboardingImportDiscoveryProgress
					sources={scan.sources}
					complete={scan.complete}
				/>
				{/* 검색이 조용히 끝나면 진행 표시가 사라진다 — 그때 다시 검색 버튼이
				    왼쪽에 홀로 남지 않도록 항상 오른쪽 끝에 붙인다. */}
				<Button
					size="icon"
					variant="ghost"
					className="ml-auto shrink-0"
					title={t("onboarding.import.rebuildDraft")}
					onClick={() => setReload((value) => value + 1)}
					disabled={journalLocked}
				>
					<RefreshCw className="size-3.5" />
				</Button>
			</div>

			<div
				className={cn(
					"flex flex-col gap-3",
					journalLocked && "pointer-events-none opacity-70",
				)}
			>
				<OnboardingImportToolbar
					selected={scopeCount.selected}
					total={scopeCount.total}
					scope={scope}
					disabled={journalLocked}
					onToggleAll={(checked) => {
						// 해제는 스페이스를 끄기만 한다 — pane 선택을 지우면 목록이
						// 통째로 사라져 무엇을 껐는지 볼 수 없다. 다시 켜면 원래
						// 선택이 그대로 돌아온다.
						if (!checked) {
							applyMutation(setAllOnboardingImportDesktopsIncluded(draft, false));
							return;
						}
						// 두 변경을 이어 붙이되 적용은 한 번만 한다. 선택 단계가 pane
						// 한도로 거부되면 applyMutation이 그 draft를 통째로 버리므로,
						// 앞 단계의 "모두 포함"까지 조용히 사라진다 — 그때는 포함까지는
						// 살리고 한도 사유만 알린다.
						const included = setAllOnboardingImportDesktopsIncluded(draft, true);
						const selected = setOnboardingImportScopeSelected(
							included.draft,
							scope,
							true,
						);
						if (selected.error) {
							updateDraft(included.draft);
							setEditError(mutationMessage(selected.error));
							return;
						}
						applyMutation(selected);
					}}
					onScopeChange={changeScope}
				/>

				<div className="flex w-full flex-col gap-4">
					{draft.desktops.map((desktop) => {
						const visiblePanes = onboardingImportScopePanes(desktop, scope);
						// 범위 밖이라 통째로 비어 버린 스페이스는 감춘다. 직접 만든 빈
						// 스페이스는 옮겨 담을 자리이므로 남긴다.
						if (visiblePanes.length === 0 && desktop.panes.length > 0) return null;
						return (
							<OnboardingImportSpaceGroup
								key={desktop.id}
								desktop={desktop}
								visiblePanes={visiblePanes}
								canReorderOrMove={canReorderOrMove}
								overflowExpanded={expandedOverflowIds.has(desktop.id)}
								draggedPaneKey={draggedPane?.paneKey}
								dropBeforePaneKey={
									dropDesktopId === desktop.id ? dropBeforePaneKey : null
								}
								isDropTarget={
									draggedPane !== null &&
									draggedPane.fromDesktopId !== desktop.id &&
									dropDesktopId === desktop.id
								}
								onToggleIncluded={(included) =>
									applyMutation(
										setOnboardingImportDesktopIncluded(draft, desktop.id, included),
									)
								}
								onRename={(name) =>
									applyMutation(
										renameOnboardingImportDesktop(draft, desktop.id, name),
									)
								}
								onToggleOverflow={() => toggleOverflowExpanded(desktop.id)}
								onSelectPane={(paneKey) =>
									applyMutation(
										setOnboardingImportPaneSelected(draft, desktop.id, paneKey, true),
									)
								}
								onRemovePane={(paneKey) => {
									// 뺀 세션은 아래 목록으로 내려간다 — 목록이 접혀 있으면
									// 어디로 갔는지 알 수 없으므로 그 자리에서 펼쳐 보여준다.
									if (
										applyMutation(
											setOnboardingImportPaneSelected(
												draft,
												desktop.id,
												paneKey,
												false,
											),
										)
									) {
										revealOverflow(desktop.id);
									}
								}}
								onDragStart={(payload) => {
									setDraggedPane({
										paneKey: payload.paneKey,
										fromDesktopId: payload.fromDesktopId,
									});
								}}
								onDragEnd={() => {
									setDraggedPane(null);
									setDropDesktopId(null);
									setDropBeforePaneKey(null);
								}}
								onDropTargetChange={(paneKey) => {
									setDropDesktopId(paneKey ? desktop.id : null);
									setDropBeforePaneKey(paneKey);
								}}
								onMovePane={(payload, beforePaneKey) => {
									setDraggedPane(null);
									setDropDesktopId(null);
									setDropBeforePaneKey(null);
									applyMutation(
										moveOnboardingImportPane(
											draft,
											payload.paneKey,
											payload.fromDesktopId,
											desktop.id,
											beforePaneKey,
										),
									);
								}}
								onNudgePane={(paneKey, direction) =>
									applyMutation(
										nudgeOnboardingImportPane(
											draft,
											desktop.id,
											paneKey,
											direction,
										),
									)
								}
								onSpaceDragOver={() => {
									if (draggedPane && draggedPane.fromDesktopId === desktop.id) return;
									setDropDesktopId(desktop.id);
									setDropBeforePaneKey(null);
								}}
								onSpaceDragLeave={() =>
									setDropDesktopId((current) =>
										current === desktop.id ? null : current,
									)
								}
								onDropOnSpace={(payload) => {
									setDraggedPane(null);
									setDropDesktopId(null);
									setDropBeforePaneKey(null);
									applyMutation(
										moveOnboardingImportPane(
											draft,
											payload.paneKey,
											payload.fromDesktopId,
											desktop.id,
										),
									);
								}}
							/>
						);
					})}
					<Button
						variant="ghost"
						className="h-9 w-full border border-dashed border-border text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
						onClick={() => applyMutation(addOnboardingImportDesktop(draft))}
					>
						<Plus className="size-3.5" />
						{t("onboarding.import.addSpace")}
					</Button>
				</div>
			</div>

			{actionBarTarget ? createPortal(actionBar, actionBarTarget) : actionBar}
		</ImportShell>
	);
}

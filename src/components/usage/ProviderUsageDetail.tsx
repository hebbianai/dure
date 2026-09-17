// 공급자 사용량 상세 — 배지 팝오버와 설정 > 통계 및 사용량이 함께 쓴다.
//
// UsageBadge.tsx에서 빼냈다. 같은 숫자(계정별 한도·5h/24h 토큰·별도 모델
// 한도)를 두 화면이 각자 그리면 한쪽만 고쳐지는 순간 서로 다른 값을 말한다 —
// 표시 규칙은 한 곳에만 둔다. 미터 ring과 팝오버 껍데기는 배지 고유라
// UsageBadge에 남겼다.

import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { Titled } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { ClaudeCollectorState, UsageRecentReport } from "@/lib/ipc";
import { useLoginIdentity } from "@/lib/agents/loginIdentity";
import {
	activeAccount,
	agentAccount,
	providerLoginCmd,
} from "@/lib/agents/providers";
import {
	applyCodexSnapshot,
	codexSnapshotForCredential,
	codexSnapshotFreshness,
} from "@/lib/usage/codexUsageSnapshots";
import {
	claudeUsageForAccount,
	codexAccountUsage,
	codexUnattributedUsage,
	codexUsageForAccount,
} from "@/lib/usage/usageAccounts";
import {
	claudeMeter,
	claudeUsedTokens,
	codexMeter,
	codexModelMeters,
	fmtAgo,
	fmtReset,
	fmtTokens,
} from "@/lib/usage/usageMeter";
import { cn } from "@/lib/utils";
import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import {
	useActiveAccount,
	useHasAccountProfiles,
	useProviderCredentialListState,
	useUsageAccountPaneAgent,
	useWorkingAgentCount,
} from "@/components/usage/useProviderUsageState";
import { PROVIDERS, type AccountProfile, type Provider } from "@/types";

export type Report = UsageRecentReport;

// 사용량 그래프/미터의 계열색. 프로바이더 아이콘은 회색조지만 이 패널의
// 색은 남긴다 — 점(범례)과 그 아래 막대가 한 쌍이라, 점만 회색으로 빼면
// 범례와 막대의 대응이 끊긴다. 데이터 시각화라 아이콘 규칙을 그대로 적용하지
// 않았다는 뜻이지, 색이 두 provider를 구분한다는 뜻은 아니다: StatsPage는
// scope별로 한 provider만 그리고(StatsPage.tsx:411) 배지도 provider별로
// 팝오버가 갈린다(UsageBadge.tsx:196). 한 화면에 두 계열이 같이 서지 않는다.
const CLAUDE_COLOR = "var(--agent-claude-series)";
// codex는 대응 토큰이 없어 상수로 남긴다(전 테마 공통).
const CODEX_COLOR = "#22c55e";

function Bar({ pct, color }: { pct: number; color: string }) {
	const clamped = Math.min(100, Math.max(0, pct));
	return (
		<span
			data-slot="usage-meter-track"
			className="inline-block h-[5px] w-[66px] overflow-hidden rounded-[3px] bg-muted-foreground/30 align-middle"
		>
			<span
				className="block h-full rounded-[3px] transition-[width]"
				style={{
					width: `${clamped}%`,
					backgroundColor:
						clamped >= 85
							? "var(--status-blocked)"
							: clamped >= 60
								? "var(--status-warn)"
								: color,
				}}
			/>
		</span>
	);
}

/** 계정 범위가 아닌 숫자를 계정 값인 척 보여주지 않기 위한 각주. */
function ScopeNote({ children }: { children: ReactNode }) {
	return (
		<p className="mt-1 text-[10px] leading-tight text-muted-foreground">
			{children}
		</p>
	);
}

/** provider에 등록된 credential 전부 — 이름·이메일·플랜, 클릭해 그 provider의
 *  활성 계정으로 전환(사용자 요청: 팝오버에서 다른 계정 선택 가능하게 —
 *  provider별로 분리, codex 목록에는 codex 계정만·claude 목록에는 claude
 *  계정만). 전환은 기존 activeAccounts 스토어 액션 그대로 — 설정 화면의
 *  계정 전환과 동일 경로라 상태가 갈라지지 않는다. */
interface CredentialProfile {
	id: string | undefined;
	dir: string | undefined;
	name: string;
	account?: AccountProfile;
}

interface CredentialSummary {
	limits: string;
	source: string;
	warning?: boolean;
}

function ProviderCredentialList({
	provider,
	summaryFor,
	dataSlot,
}: {
	provider: Provider;
	summaryFor?: (profile: CredentialProfile) => CredentialSummary;
	dataSlot?: string;
}) {
	const { accounts, activeId, activeSpaceId, setActiveAccount } =
		useProviderCredentialListState(provider);
	const pool = accounts.filter((a) => a.provider === provider);
	if (pool.length === 0) return null;
	const profiles: CredentialProfile[] = [
		{ id: undefined, dir: undefined, name: t("common.default") },
		...pool.map((account) => ({
			id: account.id,
			dir: account.dir,
			name: account.name,
			account,
		})),
	];
	return (
		<div
			className={cn(
				"mt-1 flex flex-col border-t border-border/60 pt-1",
				summaryFor ? "gap-1" : "gap-0.5",
			)}
		>
			{profiles.map((profile) => (
				<CredentialRow
					key={profile.id ? `credential:${profile.id}` : "default"}
					provider={provider}
					dir={profile.dir}
					name={profile.name}
					active={activeId === profile.id}
					summary={summaryFor?.(profile)}
					dataSlot={dataSlot}
					onSelect={() => setActiveAccount(provider, profile.id)}
					onLogin={() => {
						const api = getDockview(activeSpaceId);
						if (!api) return;
						openCommandTerminalOn(api, {
							title: t("common.loginWithName", { name: profile.name }),
							command: providerLoginCmd(provider, profile.account),
							closeOnSuccess: true,
						});
					}}
				/>
			))}
		</div>
	);
}

function CredentialRow({
	provider,
	dir,
	name,
	active,
	summary,
	dataSlot,
	onSelect,
	onLogin,
}: {
	provider: Provider;
	dir: string | undefined;
	name: string;
	active: boolean;
	summary?: CredentialSummary;
	dataSlot?: string;
	onSelect: () => void;
	onLogin: () => void;
}) {
	const identity = useLoginIdentity(provider, dir);
	const detail = [identity?.email, identity?.plan].filter(Boolean).join(" · ");
	return (
		<div className="flex min-w-0 items-start gap-1">
			<Titled title={active ? undefined : t("usage.account.makeActive")}>
				<button
					type="button"
					onClick={onSelect}
					disabled={active}
					aria-pressed={active}
					data-slot={dataSlot}
					aria-label={`${PROVIDERS[provider].label} ${name}`}
					className={cn(
						"flex min-w-0 flex-1 flex-col rounded text-left transition-colors",
						summary ? "gap-0.5 px-1.5 py-1" : "px-1 py-0.5",
						active
							? summary
								? "cursor-default bg-accent/60"
								: "cursor-default"
							: "hover:bg-accent",
					)}
				>
					<span className="flex w-full min-w-0 items-baseline justify-between gap-2 text-[11px]">
						<span className="flex min-w-0 items-center gap-1 text-muted-foreground">
							{active && (
								<Check className="size-2.5 shrink-0 text-foreground" />
							)}
							<span
								className={cn(
									"truncate",
									active && "font-semibold text-foreground",
								)}
							>
								{name}
							</span>
						</span>
						<span
							className={cn(
								"truncate text-muted-foreground",
								summary
									? "text-[10px]"
									: "font-mono text-[11px] tabular-nums",
								!summary && active && "text-foreground",
							)}
						>
							{detail || "—"}
						</span>
					</span>
					{summary && (
						<span className="flex w-full items-baseline justify-between gap-2 font-mono text-[10px] tabular-nums">
							<span
								className={cn(
									summary.limits
										? "text-foreground"
										: "text-muted-foreground",
								)}
							>
								{summary.limits || "—"}
							</span>
							<span
								className={cn(
									"truncate",
									summary.warning
										? "text-status-warn"
										: "text-muted-foreground",
								)}
							>
								{summary.source}
							</span>
						</span>
					)}
				</button>
			</Titled>
			{identity?.status === "unauthenticated" && (
				<Button
					type="button"
					size="xs"
					variant="outline"
					className="mt-0.5 shrink-0"
					onClick={onLogin}
					aria-label={t("common.loginWithName", { name })}
				>
					{t("common.login")}
				</Button>
			)}
		</div>
	);
}

/** 등록된 Codex subscription을 한 화면에서 비교한다. 사용하지 않은 계정도
 * App Server snapshot을 쓰며, 새 probe 실패 시 마지막 성공값과 수집 시각을
 * 그대로 보여준다. */
function CodexCredentialUsageList({
	u5,
	nowSec,
}: {
	u5: Report;
	nowSec: number;
}) {
	return (
		<ProviderCredentialList
			provider="codex"
			dataSlot="codex-subscription-usage"
			summaryFor={(profile) =>
				codexCredentialUsageSummary(profile.id, u5, nowSec)
			}
		/>
	);
}

function codexCredentialUsageSummary(
	id: string | undefined,
	u5: Report,
	nowSec: number,
): CredentialSummary {
	const snapshot = codexSnapshotForCredential(u5.codexAccountSnapshots, id);
	// 전체 fallback은 어느 credential 것인지 증명하지 못한다. 목록의 각 행에
	// 같은 전역 값을 복제하지 않고, 저널로 귀속된 값만 세션 fallback으로 쓴다.
	const logged = codexAccountUsage(u5.codexAccounts, id)?.usage ?? {
		...u5.codex,
		usedPercent: null,
		usedPercentWeekly: null,
		resetsAt: null,
		weeklyResetsAt: null,
		usedPercentCapturedAt: null,
		rateLimits: [],
	};
	const usage = applyCodexSnapshot(logged, snapshot);
	const shortReset = fmtReset(usage.resetsAt, nowSec);
	const weeklyReset = fmtReset(usage.weeklyResetsAt, nowSec);
	const limits = [
		usage.usedPercent != null
			? `5h ${Math.round(usage.usedPercent)}%${shortReset ? ` · ${shortReset}` : ""}`
			: null,
		usage.usedPercentWeekly != null
			? `${t("usage.window.weekly")} ${Math.round(usage.usedPercentWeekly)}%${weeklyReset ? ` · ${weeklyReset}` : ""}`
			: null,
	]
		.filter(Boolean)
		.join(" / ");
	const capturedAgo = fmtAgo(snapshot?.capturedAt, nowSec);
	const freshness = codexSnapshotFreshness(snapshot, nowSec);
	const source = snapshot?.capturedAt
		? snapshot.error
			? t("usage.source.refreshFailedKeepLast")
			: freshness === "stale"
				? t("usage.source.lastValueAgo", { ago: capturedAgo ?? "—" })
				: t("usage.source.checkedAgo", { ago: capturedAgo ?? "—" })
		: snapshot?.error
			? limits
				? t("usage.source.refreshFailedSessionRecord")
				: t("usage.status.checkFailed")
			: limits
				? t("usage.source.sessionRecord")
				: t("usage.status.noneObserved");
	return { limits, source, warning: Boolean(snapshot?.error) };
}

/** 표시 중인 사용량이 어느 계정 credential 맥락인지 — 선택된 pane의
 *  에이전트 계정 우선, 없으면 provider 활성 계정. 계정 해석은 스폰과 같은
 *  canonical resolver(agentAccount: credentialId > accountId > 활성)를
 *  그대로 쓴다 — 여기서 재구현하면 표시와 실제 credential이 갈라진다.
 *  로그인 이메일·플랜은 read-only IPC(account_login_identity)로 읽고,
 *  팝오버가 열릴 때만 마운트되므로 상시 배지 렌더에 얹히지 않는다. */
export function UsageAccountRow({ provider }: { provider: Provider }) {
	const paneAgent = useUsageAccountPaneAgent(provider);
	const account = paneAgent ? agentAccount(paneAgent) : activeAccount(provider);
	const identity = useLoginIdentity(provider, account?.dir || undefined);
	const detail = [identity?.email, identity?.plan].filter(Boolean).join(" · ");
	return (
		<>
			<UsageRow
				label={paneAgent ? t("usage.account.selectedPane") : t("usage.account.active")}
				value={account?.name ?? t("common.default")}
			/>
			{detail && (
				<p className="-mt-0.5 truncate text-right text-[10px] leading-tight text-muted-foreground">
					{detail}
				</p>
			)}
		</>
	);
}

/** 팝오버 내 공급자 섹션 헤더 + 내용. provider 로고를 코드 텍스트(CL/CX)
 *  대신 쓴다. */
function UsageSection({
	provider,
	color,
	title,
	children,
}: {
	provider: Provider;
	color: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1.5">
				<span
					className="size-1.5 shrink-0 rounded-full"
					style={{ backgroundColor: color }}
					aria-hidden="true"
				/>
				<ProviderGlyph provider={provider} />
				<span className="text-[11px] text-muted-foreground">{title}</span>
			</div>
			<div className="flex flex-col gap-0.5 pl-3">{children}</div>
		</div>
	);
}

/** 팝오버 내 라벨·값 한 줄. */
function UsageRow({
	label,
	value,
	strong,
}: {
	label: string;
	value: string;
	strong?: boolean;
}) {
	return (
		<div className="flex items-baseline justify-between gap-2">
			<span className="text-[11px] text-muted-foreground">{label}</span>
			<span
				className={cn(
					"font-mono text-[11px] tabular-nums",
					strong ? "font-semibold text-foreground" : "text-muted-foreground",
				)}
			>
				{value}
			</span>
		</div>
	);
}

/** Claude usage derived for the active account — the badge popover headline
 *  (ring pct + tooltip) and the detail body below must read the exact same
 *  numbers, so the derivation lives once here. */
export function useClaudeUsage(u5: Report, nowSec: number) {
	const working = useWorkingAgentCount("claude");
	const account = useActiveAccount("claude");
	// 한도는 활성 계정 것으로, 토큰은 공유 저장소 합계 그대로.
	const resolved = claudeUsageForAccount(
		u5.claude,
		u5.claudeAccounts,
		account?.dir,
	);
	const claude = resolved.usage;
	return {
		working,
		resolved,
		claude,
		used: claudeUsedTokens(claude),
		meter: claudeMeter(claude, nowSec),
		capturedAgo: fmtAgo(claude.usedPercentCapturedAt, nowSec),
	};
}

/** Claude 사용량 상세 본문 (배지 팝오버 / 설정 공용). */
export function ClaudeUsageDetail({
	u5,
	u24,
	nowSec,
	collector,
	installing,
	onInstall,
}: {
	u5: Report;
	u24: Report | null;
	nowSec: number;
	collector: ClaudeCollectorState | null;
	installing: boolean;
	onInstall: () => void;
}) {
	const hasProfiles = useHasAccountProfiles("claude");
	const {
		working: clWorking,
		resolved,
		claude,
		used: clUsed,
		meter: cl,
		capturedAgo: clCapturedAgo,
	} = useClaudeUsage(u5, nowSec);

	return (
			<UsageSection
				provider="claude"
				color={CLAUDE_COLOR}
				title={cl.pct != null ? t("Claude · rate limit") : t("usage.claude.fiveHourTitle")}
			>
				<UsageAccountRow provider="claude" />
				<ProviderCredentialList provider="claude" />
				{cl.pct != null && (
					<>
						<UsageRow
							label={cl.window === "weekly" ? t("usage.limit.weekly") : t("usage.limit.fiveHour")}
							value={`${Math.round(cl.pct)}%${cl.resetLabel ? ` · ${t("usage.reset.inlineShort", { reset: cl.resetLabel })}` : ""}`}
							strong
						/>
						<div className="my-0.5">
							<Bar pct={cl.pct} color={CLAUDE_COLOR} />
						</div>
						{cl.window !== "weekly" && claude.usedPercentWeekly != null && (
							<UsageRow
								label={t("usage.limit.weekly")}
								value={`${Math.round(claude.usedPercentWeekly)}%${
									fmtReset(claude.weeklyResetsAt, nowSec)
										? ` · ${t("usage.reset.inlineShort", { reset: fmtReset(claude.weeklyResetsAt, nowSec) ?? "" })}`
										: ""
								}`}
							/>
						)}
					</>
				)}
				<UsageRow
					label={t("usage.tokens.fiveHour")}
					value={fmtTokens(clUsed)}
					strong={cl.pct == null}
				/>
				<UsageRow
					label={t("usage.tokens.breakdownLabel")}
					value={`${fmtTokens(claude.input)} · ${fmtTokens(claude.output)} · ${fmtTokens(claude.cacheWrite)}`}
				/>
				<UsageRow
					label={t("usage.tokens.last24hTotal")}
					value={fmtTokens(u24?.claude.total ?? 0)}
				/>
				<UsageRow label={t("usage.agents.working")} value={String(clWorking)} />
				{/* 토큰은 계정 오버레이가 transcript 저장소를 심링크로 공유해 계정별로
            가를 수 없다 — 한도만 계정별이라는 사실을 숨기지 않는다. 계정
            프로필이 하나도 없으면 가를 대상 자체가 없으니 각주도 없다. */}
				{hasProfiles && (
					<ScopeNote>
						{t("usage.attribution.sharedTokens")}
					</ScopeNote>
				)}
				{cl.pct != null ? (
					clCapturedAgo && (
						<ScopeNote>
							{t("usage.source.statusLineCapturedDetail", {
								ago: clCapturedAgo,
							})}
						</ScopeNote>
					)
				) : (
					<>
						<ScopeNote>
							{collector === "foreign"
								? t("usage.collector.foreignStatusLine")
								: resolved.scoped
									? t("usage.account.noHistoryYet")
									: t("usage.collector.missingPct")}
						</ScopeNote>
						{collector === "not_installed" && (
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="mt-1 w-fit"
								disabled={installing}
								onClick={onInstall}
							>
								{installing
									? t("common.installing")
									: t("usage.collector.installStatusLine")}
							</Button>
						)}
						{collector === "installed" && !resolved.scoped && (
							<ScopeNote>
								{t("usage.collector.installedNotice")}
							</ScopeNote>
						)}
					</>
				)}
			</UsageSection>
	);
}

/** Active-account Codex facts shared by the header popover and settings detail. */
export function useCodexUsage(
	u5: Report,
	u24: Report | null,
	nowSec: number,
) {
	const working = useWorkingAgentCount("codex");
	const account = useActiveAccount("codex");
	const resolved = codexUsageForAccount(
		u5.codex,
		u5.codexAccounts,
		account?.id,
	);
	const snapshot = codexSnapshotForCredential(
		u5.codexAccountSnapshots,
		account?.id,
	);
	const codex = applyCodexSnapshot(resolved.usage, snapshot);
	return {
		working,
		account,
		resolved,
		snapshot,
		codex,
		dailyTotal: u24
			? codexUsageForAccount(u24.codex, u24.codexAccounts, account?.id).usage
					.total
			: 0,
		unattributed: codexUnattributedUsage(u5.codexAccounts),
		meter: codexMeter(codex, nowSec),
		modelMeters: codexModelMeters(codex, nowSec),
		weeklyReset: fmtReset(codex.weeklyResetsAt, nowSec),
	};
}

/** Codex usage detail for the settings surface. */
export function CodexUsageDetail({
	u5,
	u24,
	nowSec,
}: {
	u5: Report;
	u24: Report | null;
	nowSec: number;
}) {
	const {
		working: cxWorking,
		resolved,
		snapshot,
		codex,
		dailyTotal,
		unattributed,
		meter: cx,
		modelMeters,
		weeklyReset,
	} = useCodexUsage(u5, u24, nowSec);

	return (
			<UsageSection
				provider="codex"
				color={CODEX_COLOR}
				title={t("Codex · rate limit")}
			>
				<UsageAccountRow provider="codex" />
				<CodexCredentialUsageList u5={u5} nowSec={nowSec} />
				{cx.pct == null ? (
					<p className="text-xs text-muted-foreground">
						{modelMeters.length > 0
							? t("usage.codex.generalLimitNoData")
							: snapshot?.error
								? t("usage.status.checkFailed")
								: t("usage.status.noneObserved")}
					</p>
				) : (
					<>
						<UsageRow
							label={cx.window === "weekly" ? t("usage.limit.weekly") : t("usage.limit.fiveHour")}
							value={`${Math.round(cx.pct)}%${cx.resetLabel ? ` · ${t("usage.reset.inlineShort", { reset: cx.resetLabel })}` : ""}`}
							strong
						/>
						<div className="my-0.5">
							<Bar pct={cx.pct} color={CODEX_COLOR} />
						</div>
						{cx.window !== "weekly" && codex.usedPercentWeekly != null && (
							<UsageRow
								label={t("usage.limit.weekly")}
								value={`${Math.round(codex.usedPercentWeekly)}%${weeklyReset ? ` · ${t("usage.reset.inlineShort", { reset: weeklyReset })}` : ""}`}
							/>
						)}
					</>
				)}
				{modelMeters.length > 0 && (
					<div className="mt-1 flex flex-col gap-1.5 border-t border-border/60 pt-2">
						<p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							{t("usage.limit.separateModels")}
						</p>
						{modelMeters.map((meter) => {
							const model = meter.limitName ?? t("usage.codex.separateModel");
							return (
								<div
									key={meter.limitId}
									className="flex flex-col gap-0.5"
									data-slot="codex-model-limit"
								>
									<Titled title={model}>
										<p
											className="truncate text-[11px] font-medium text-foreground"
										>
											{model}
										</p>
									</Titled>
									<UsageRow
										label={
											meter.window === "weekly"
												? t("usage.limit.weekly")
												: t("usage.limit.fiveHour")
										}
										value={`${Math.round(meter.pct ?? 0)}%${meter.resetLabel ? ` · ${t("usage.reset.inlineShort", { reset: meter.resetLabel })}` : ""}`}
										strong
									/>
									<div className="my-0.5">
										<Bar pct={meter.pct ?? 0} color={CODEX_COLOR} />
									</div>
									{meter.window !== "weekly" && meter.weeklyPct != null && (
										<UsageRow
											label={t("usage.limit.weekly")}
											value={`${Math.round(meter.weeklyPct)}%${meter.weeklyResetLabel ? ` · ${t("usage.reset.inlineShort", { reset: meter.weeklyResetLabel })}` : ""}`}
										/>
									)}
								</div>
							);
						})}
					</div>
				)}
				<UsageRow label={t("usage.tokens.last24h")} value={fmtTokens(dailyTotal)} />
				<UsageRow label={t("usage.agents.working")} value={String(cxWorking)} />
				{snapshot?.capturedAt && (
					<ScopeNote>
						{snapshot.error
							? t("usage.source.appServerFailedKeepLast", {
									ago: fmtAgo(snapshot.capturedAt, nowSec) ?? "—",
								})
							: t("usage.source.appServerCaptured", {
									ago: fmtAgo(snapshot.capturedAt, nowSec) ?? "—",
								})}
					</ScopeNote>
				)}
				{/* 저널 도입 전이나 앱 밖에서 시작된 세션은 어느 계정 것인지 알 수 없다.
            활성 계정 것으로 세지 않고 그 사실을 그대로 보여준다. */}
				{!resolved.scoped ? (
					<ScopeNote>
						{t("usage.attribution.noneTotal")}
					</ScopeNote>
				) : (
					<>
						{/* 재부착만 있는 장수 세션은 증명이 없다. 숫자는 보여주되
                근거 등급을 밝힌다 — 증명된 것처럼 보이면 안 된다. */}
						{resolved.observedOnly && (
							<ScopeNote>
								{t("usage.attribution.observedOnly")}
							</ScopeNote>
						)}
						{unattributed != null && unattributed.usage.total > 0 && (
							<ScopeNote>
								{t("usage.attribution.unattributedExcluded", {
									total: fmtTokens(unattributed.usage.total),
								})}
							</ScopeNote>
						)}
					</>
				)}
			</UsageSection>
	);
}

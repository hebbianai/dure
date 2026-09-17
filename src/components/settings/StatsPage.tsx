// 설정 > 통계 및 사용량 (시안 2527:77100 빈 상태 / 2527:78081 데이터 상태).
// SettingsDialog.tsx에서 빼냈다 — god-file 규칙상 손대는 페이지는 자기 모듈로
// 옮긴다. 집계 규칙은 렌더링과 무관하므로 lib/usageScope.ts에 따로 둔다.
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Bot, CalendarDays, Clock, Database, GitPullRequestArrow, Recycle, Sparkles } from "lucide-react";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Titled } from "@/components/ui/tooltip";
import { PageTitle } from "@/components/settings/PageTitle";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { ProviderUsageCard, type ProvStats } from "@/components/usage/ProviderUsageCard";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import {
  ClaudeUsageDetail,
  CodexUsageDetail,
} from "@/components/usage/ProviderUsageDetail";
import { useRecentUsage } from "@/components/usage/useRecentUsage";
import { Button, ConfirmationButton } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  claudeCollectorInstall,
  usageStats,
  type UsageStatsReport,
} from "@/lib/ipc";
import { normalizeTokenUsage, summarizeUsage } from "@/lib/usage/usageAccounting";
import { fmtTokens } from "@/lib/usage/usageMeter";
import {
  DEFAULT_SCAN_DAYS,
  isScanning,
  isUsageScope,
  normalizeScanDays,
  SCAN_DAY_OPTIONS,
  type ScanState,
  providerSummaryCounts,
  providersInScope,
  SCANNABLE_PROVIDERS,
  type ScannableProvider,
  toggleScanning,
  type UsageScope,
} from "@/lib/usage/usageScope";
import { cn } from "@/lib/utils";
import { useStatsPageState } from "@/components/settings/useStatsPageState";

const PROVIDER_LABEL: Record<ScannableProvider, string> = {
  claude: "Claude",
  codex: "Codex",
};

const fmtDur = (ms: number) => {
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const fmtKDate = (ms: number) => {
  const d = new Date(ms);
  return t("settings.stats.dateFormat", {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
  });
};

/** 상단 통계 카드 (아이콘 배지 + 큰 수치 + 라벨) */
function StatCard({ icon: Icon, value, label }: { icon: typeof Bot; value: string; label: string }) {
  return (
    <Card className="flex min-w-0 flex-1 items-center gap-3 rounded-[12px]">
      <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[9px] border bg-secondary">
        <Icon className="size-5 text-foreground" />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-xl leading-7 font-semibold text-foreground">{value}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </Card>
  );
}

/** Labels and exact values remain readable at the settings column's own width. */
function MiniStat({ icon: Icon, value, label, detail }: { icon: typeof Bot; value: string; label: string; detail: string }) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 rounded-[12px]">
      <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <Icon className="size-3.5 shrink-0" />
      </div>
      <div className="mt-auto flex min-w-0 flex-col gap-1">
        <span className="text-[28px] leading-8 font-semibold tracking-tight text-foreground tabular-nums">{value}</span>
        <span className="font-mono text-[11px] leading-4 text-muted-foreground tabular-nums [overflow-wrap:anywhere]">{detail}</span>
      </div>
    </Card>
  );
}

/** 스캔 대상 토글 버튼. 디자인의 primary/outline 두 벌이 곧 켜짐/꺼짐 상태다. */
function ScanToggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex h-8 shrink-0 items-center justify-center rounded-md px-3 text-xs font-medium",
        on
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "border border-input bg-glass-chrome text-foreground hover:bg-glass-tint-hover",
      )}
    >
      {on ? t("settings.stats.providers.scanning", { name: label }) : t("settings.stats.providers.enable", { name: label })}
    </button>
  );
}

/** 스캔 상태 한 줄.
 *
 *  성공 시각만 들고 "있으면 갱신, 없으면 스캔 중"으로 가르면, 스캔이 실패해도
 *  화면은 영원히 "스캔 중…"이다 — 진행 중인지 죽었는지 알 수 없는 표시는
 *  거짓말이다. 실패는 실패라고 말하고 재시도를 준다. */
function ScanStatusLine({
  scan,
  updatedAt,
  onRetry,
}: {
  scan: ScanState;
  updatedAt: number | null;
  onRetry: () => void;
}) {
  if (scan.phase === "scanning") {
    return (
      <span className="text-xs text-muted-foreground">
        {t("settings.stats.scan.progress", {
          n: scan.days,
        })}
      </span>
    );
  }
  if (scan.phase === "failed" || scan.phase === "cancelled") {
    const failed = scan.phase === "failed";
    return (
      <span
        className={cn(
          "flex flex-wrap items-center gap-2 text-xs",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {failed ? t("settings.stats.scan.failed", { message: scan.message }) : t("settings.stats.scan.cancelled")}
        <Button type="button" size="xs" variant="outline" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {updatedAt
        ? t("settings.stats.updatedAt", { when: new Date(updatedAt).toLocaleString() })
        : t("settings.stats.scan.notYet")}
    </span>
  );
}

/** 통계 및 사용량 페이지 — 상단 누적 통계 + 로그 스캔 기반 토큰 사용량. */
export function StatsPage() {
  const { stats, accounts, savedScan, setUi, savedDays } = useStatsPageState();
  const days = normalizeScanDays(savedDays);
  const setDays = (n: number) => setUi({ usageScanDays: n });
  const [scope, setScope] = useState<UsageScope>("overview");
  const [data, setData] = useState<UsageStatsReport | null>(null);
  const [scan, setScan] = useState<ScanState>({ phase: "idle" });
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // 기간을 바꾸면 이전 요청이 아직 날아오고 있다. 늦게 도착한 응답이 지금
  // 보고 있는 창을 덮으면, 히트맵은 14칸인데 합계는 180일치가 되는 식으로
  // 화면 안에서 값이 어긋난다 — 세대 토큰으로 최신 요청만 반영한다.
  const loadSeq = useRef(0);
  const load = useCallback((forDays: number) => {
    const seq = ++loadSeq.current;
    setScan({ phase: "scanning", startedAt: Date.now(), days: forDays });
    usageStats(forDays)
      .then((d) => {
        if (seq !== loadSeq.current) return;
        setData(d);
        setUpdatedAt(Date.now());
        setScan({ phase: "done" });
      })
      .catch((error) => {
        if (seq !== loadSeq.current) return;
        // 실패를 '스캔 중'으로 남겨두면 영원히 도는 것처럼 보인다.
        setScan({ phase: "failed", message: String(error) });
      });
  }, []);

  const cancelScan = () => {
    // 백엔드 명령 자체를 중단시킬 수는 없다(취소 가능한 IPC가 아니다). 세대를
    // 올려 결과를 버리고 화면을 정직하게 '취소됨'으로 둔다 — 캐시가 빈 첫
    // 스캔은 실측 62초라 "취소했는데 나중에 화면이 바뀌는" 일이 실제로 난다.
    loadSeq.current += 1;
    setScan({ phase: "cancelled" });
  };

  useEffect(() => {
    load(days);
  }, [days, load]);

  // 공급자 상세는 배지와 같은 출처(usage_recent)를 쓴다 — 한도·계정 귀속은
  // 선택한 기간의 로그 스캔(usage_stats)에 없고, 두 화면이 다른 값을 말하면 안 된다.
  const { u5, u24, collector, setCollector } = useRecentUsage(accounts);
  const [installing, setInstalling] = useState(false);

  // 스코프와 스캔 스위치가 함께 어떤 공급자를 집계할지 정한다.
  const shown = providersInScope(scope, savedScan);
  const totals = {
    claude: data?.claude.total ?? 0,
    codex: data?.codex.total ?? 0,
  };
  const counts = providerSummaryCounts(savedScan, totals);

  const usage = data
    ? summarizeUsage(
        shown.map((p) =>
          p === "claude"
            ? normalizeTokenUsage(data.claude, "disjoint")
            : normalizeTokenUsage(data.codex, "input-subset"),
        ),
      )
    : null;
  const totalTokens = usage?.activityTotal ?? 0;
  const processedTokens = usage?.processedTotal ?? 0;
  const hasData = totalTokens > 0;
  const inputTot = usage?.input ?? 0;
  const outputTot = usage?.output ?? 0;
  const cacheTot = (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  const cachePct = processedTokens > 0 ? (cacheTot / processedTokens) * 100 : 0;

  // 일별 병합 — 스코프에 든 공급자만
  const dailyMap = new Map<string, number>();
  if (data) {
    for (const p of shown) {
      for (const d of data[p].daily) dailyMap.set(d.date, (dailyMap.get(d.date) ?? 0) + d.total);
    }
  }
  const activeDays = [...dailyMap.values()].filter((v) => v > 0).length;

  // 선택한 기간의 히트맵 셀
  const cells: { key: string; total: number }[] = [];
  const base = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    cells.push({ key, total: dailyMap.get(key) ?? 0 });
  }
  const maxDay = Math.max(1, ...cells.map((c) => c.total));
  const peak = cells.reduce((a, b) => (b.total > a.total ? b : a), cells[0] ?? { key: "", total: 0 });
  const cellOpacity = (total: number) => (total <= 0 ? 0.08 : 0.2 + (total / maxDay) * 0.8);

  const compTotal = Math.max(1, processedTokens);
  const scopeLabel = scope === "overview" ? t("settings.stats.usage.overviewLabel") : PROVIDER_LABEL[scope];
  const offProviders = SCANNABLE_PROVIDERS.filter((p) => !isScanning(savedScan, p));

  return (
    <>
      <PageTitle title={t("settings.stats.title")} desc={t("settings.stats.description")} />
      <div className="flex w-full flex-col">
        {/* 상단 누적 통계 */}
        <SettingsSection first>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-3">
              <StatCard icon={Bot} value={String(stats.agentsStarted)} label={t("settings.stats.activity.agentsStarted")} />
              <StatCard icon={Clock} value={fmtDur(stats.activeMs)} label={t("settings.stats.activity.workTime")} />
              {/* What GitPanel counts is "times the PR compose (compare) screen
                  was opened" — whether a PR actually got created is only knowable
                  by asking GitHub, so the label matches the measurement. */}
              <StatCard
                icon={GitPullRequestArrow}
                value={String(stats.prsCreated)}
                label={t("settings.stats.activity.prComposeOpened")}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {t("settings.stats.activity.trackingSince", { date: fmtKDate(stats.since) })}
            </span>
          </div>
        </SettingsSection>

        {/* 사용량 분석 */}
        <SettingsSection>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm font-medium text-foreground">{t("settings.stats.usage.analysisTitle")}</span>
              {/* 아이콘은 SelectValue가 고른 항목의 children을 그대로 그리면서
                  같이 나온다 — 여기서 또 그리면 두 번 찍힌다. */}
              {/* The only values the trigger can actually show are the overview
                  label and PROVIDER_LABEL's "Claude"/"Codex". The longest is pt
                  "Visão geral" at 119px including the icon, and the width was
                  120px — not clipped, but with 1px of slack any translation that
                  grows would overflow. Widened for headroom, not to fix clipping. */}
              <SelectField
                value={scope}
                onValueChange={(v) => {
                  if (isUsageScope(v)) setScope(v);
                }}
                className="w-[144px]"
                aria-label={t("settings.stats.scope.title")}
              >
                <SelectOption value="overview">
                  <BarChart3 className="size-3.5 shrink-0 text-muted-foreground" />
                  {t("settings.stats.scope.overview")}
                </SelectOption>
                {SCANNABLE_PROVIDERS.map((p) => (
                  <SelectOption key={p} value={p}>
                    <ProviderGlyph provider={p} />
                    {PROVIDER_LABEL[p]}
                  </SelectOption>
                ))}
              </SelectField>
            </div>

            <Card className="flex flex-col gap-[14px] rounded-[14px]">
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-[140px] flex-1 text-sm font-medium text-foreground">{scopeLabel}</span>
                  <div className="flex flex-wrap items-center gap-2">
                  {/* 스캔 기간 — 백엔드는 임의 창을 받는데 화면은 42일로 굳어 있었다. */}
                  <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                    {/* At 110px only the Korean default label (107px) fit and the
                        rest clipped. The sizing locale is es "Últimos 7 días ·
                        Predeterminado", which needs 193px (en 136 / fr 172 / pt
                        150). Sized above that — only the default option carries the
                        "· default" suffix, so that item is always the longest. */}
                    <SelectTrigger className="w-[200px]" aria-label={t("settings.stats.scanPeriod.title")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCAN_DAY_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {t("settings.stats.scanPeriod.lastNDays", { n })}
                          {n === DEFAULT_SCAN_DAYS ? ` · ${t("common.default")}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {scan.phase === "scanning" && (
                    <ConfirmationButton type="button" variant="glass" onClick={cancelScan}>
                      {t("common.cancel")}
                    </ConfirmationButton>
                  )}
                  <RefreshButton
                    busy={scan.phase === "scanning"}
                    onClick={() => load(days)}
                  />
                  </div>
                </div>
                <ScanStatusLine scan={scan} updatedAt={updatedAt} onRetry={() => load(days)} />
              </div>

              {scope !== "overview" ? (
                /* 공급자 하나를 고르면 배지 팝오버와 같은 상세를 그대로 보여준다.
                   한도·계정 귀속은 로그 스캔에 없는 값이라 여기서만 볼 수 있다. */
                u5 ? (
                  scope === "claude" ? (
                    <ClaudeUsageDetail
                      u5={u5}
                      u24={u24}
                      nowSec={Date.now() / 1000}
                      collector={collector}
                      installing={installing}
                      onInstall={() => {
                        setInstalling(true);
                        claudeCollectorInstall()
                          .then(setCollector)
                          .catch(() => {})
                          .finally(() => setInstalling(false));
                      }}
                    />
                  ) : (
                    <CodexUsageDetail u5={u5} u24={u24} nowSec={Date.now() / 1000} />
                  )
                ) : (
                  <span className="text-xs text-muted-foreground">{t("settings.stats.usage.loading")}</span>
                )
              ) : !hasData ? (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-foreground">{t("settings.stats.usage.startTitle")}</span>
                  <span className="text-xs text-muted-foreground">
                    {offProviders.length > 0
                      ? t("settings.stats.usage.enableProvidersHint")
                      : t("settings.stats.usage.autoAggregateHint")}
                  </span>
                  <div className="flex flex-wrap gap-[10px] pt-[10px]">
                    {SCANNABLE_PROVIDERS.map((p) => (
                      <ScanToggle
                        key={p}
                        label={PROVIDER_LABEL[p]}
                        on={isScanning(savedScan, p)}
                        onClick={() => setUi({ usageScanProviders: toggleScanning(savedScan, p) })}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3">
                    <MiniStat icon={Sparkles} value={fmtTokens(totalTokens)} label={t("settings.stats.tokens.aggregated")} detail={totalTokens.toLocaleString()} />
                    <MiniStat icon={Database} value={fmtTokens(processedTokens)} label={t("settings.stats.tokens.processed")} detail={processedTokens.toLocaleString()} />
                    <MiniStat icon={CalendarDays} value={String(activeDays)} label={t("settings.stats.tokens.activeDays")} detail={t("settings.stats.scanPeriod.lastNDays", { n: days })} />
                    <MiniStat icon={Recycle} value={`${cachePct.toFixed(2)}%`} label={t("settings.stats.tokens.cacheShare")} detail={t("settings.stats.tokens.cachedCount", { n: fmtTokens(cacheTot) })} />
                  </div>

                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3">
                    {/* 일일 강도 히트맵 */}
                    <Card className="flex min-w-0 flex-1 flex-col gap-2 rounded-[12px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{t("settings.stats.dailyIntensity.title")}</span>
                        {peak.total > 0 && (
                          <Badge size="sm" variant="secondary">
                            {t("settings.stats.dailyIntensity.peak", { date: peak.key.slice(5).replace("-", "/") })}
                          </Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {t("settings.stats.dailyIntensity.desc", { n: days })}
                      </span>
                      <div className="grid gap-1 pt-2" style={{ gridTemplateColumns: `repeat(${Math.min(days, 15)}, minmax(0, 1fr))` }}>
                        {cells.map((c) => (
                          <Titled key={c.key} title={`${c.key}: ${c.total.toLocaleString()}`}>
                            <span
                              className="h-4 rounded-[3px] bg-foreground"
                              style={{ opacity: cellOpacity(c.total) }}
                            />
                          </Titled>
                        ))}
                      </div>
                      <div className="flex items-center justify-between pt-0.5 text-meta text-muted-foreground">
                        <span>{cells[0]?.key.slice(5).replace("-", "/")}</span>
                        <span>{cells[cells.length - 1]?.key.slice(5).replace("-", "/")}</span>
                      </div>
                    </Card>

                    {/* 토큰 구성 */}
                    <Card className="flex min-w-0 flex-1 flex-col gap-2 rounded-[12px]">
                      <span className="text-sm font-medium text-foreground">{t("settings.stats.tokens.compositionTitle")}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("settings.stats.tokens.compositionDesc")}
                      </span>
                      <div aria-hidden="true" className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-status-done" style={{ width: `${(inputTot / compTotal) * 100}%` }} />
                        <div className="h-full bg-status-run" style={{ width: `${(outputTot / compTotal) * 100}%` }} />
                        <div className="h-full bg-muted-foreground" style={{ width: `${(cacheTot / compTotal) * 100}%` }} />
                      </div>
                      <dl className="mt-1 flex flex-col divide-y divide-border text-xs">
                        {([
                          { label: t("settings.stats.tokens.input"), value: inputTot, tone: "done" },
                          { label: t("settings.stats.tokens.output"), value: outputTot, tone: "run" },
                          { label: t("settings.stats.tokens.cache"), value: cacheTot, tone: "muted" },
                        ] as const).map(({ label, value, tone }) => (
                          <div key={tone} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                            <dt className="flex items-center gap-2 text-muted-foreground">
                              <StatusDot tone={tone} className="size-2" />{label}
                            </dt>
                            <dd className="flex min-w-0 flex-col items-end gap-0.5 tabular-nums">
                              <span className="font-medium text-foreground">{value.toLocaleString()}</span>
                              <span className="text-[11px] text-muted-foreground">{((value / compTotal) * 100).toFixed(2)}%</span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </Card>
                  </div>
                  <p className="border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
                    {t("settings.stats.usage.codexCaveat")}
                  </p>
                </>
              )}
            </Card>
          </div>
        </SettingsSection>

        {/* 공급자 — 데이터가 없어도 어떤 공급자를 보고 있는지는 늘 보여준다 */}
        <SettingsSection>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">{t("settings.stats.providers.title")}</span>
              <span className="text-xs text-muted-foreground">
                {t("settings.stats.providers.enabledSummary", { a: counts.enabled, b: counts.withData })}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
              {shown.map((p) => (
                <ProviderUsageCard
                  key={p}
                  label={PROVIDER_LABEL[p]}
                  provider={p}
                  s={data?.[p] ?? EMPTY_STATS}
                  scanning={isScanning(savedScan, p)}
                  pct={totalTokens > 0 ? ((data?.[p].total ?? 0) / totalTokens) * 100 : 0}
                />
              ))}
            </div>
          </div>
        </SettingsSection>
      </div>
    </>
  );
}

const EMPTY_STATS: ProvStats = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  sessions: 0,
  turns: 0,
  daily: [],
};
